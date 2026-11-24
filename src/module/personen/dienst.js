import { inTransaktion } from '../../db.js';
import { badRequest, conflict, fehler, notFound } from '../../errors.js';
import * as audit from '../audit/dienst.js';
import * as benachrichtigung from '../benachrichtigung/dienst.js';
import { landesverbandVon, vereinFuer } from '../organisation/dienst.js';
import { darf, darfFelder, ladeZiel, projiziere } from '../rechte/dienst.js';
import * as daten from './daten.js';

/**
 * FR-4: Person und erste Mitgliedschaft in einer Transaktion; der Verein wird Heimatverein. Eine Judopass-ID ist nur ein Hinweis:
 * Ob es sie gibt, wird nicht geprüft und nicht verraten (FR-6); der Landesverband erhält die Aufgabe zum Zusammenführen.
 */
export async function personAnlegen(ctx, db, { verein_id, person, eintritt = null, judopass_id = null }) {
  const ziel = await ladeZiel(ctx, db, { vereine: [verein_id], heimatverein_id: verein_id, person: { aktiv: true, rang: null, lizenzen: [] } });
  if (!darfFelder(ctx, 'mitglieder:ANLEGEN', 'person', Object.keys(person), ziel)) throw notFound();
  if (person.geburtsdatum > ctx.jetzt.toISOString().slice(0, 10)) throw fehler(422, 'Das Geburtsdatum liegt in der Zukunft', 'geburtsdatum_ungueltig');
  return inTransaktion(db, async (c) => {
    const verein = await vereinFuer(ctx, c, { id: verein_id });
    if (!verein) throw notFound();
    if (verein.aufgeloest_am) throw conflict('Der Verein ist aufgelöst', 'verein_aufgeloest');
    const von = ctx.benutzer.id;
    const { id: person_id } = await daten.personAnlegen(c, { ...person, vereinId: verein_id, judopassId: judopass_id, von });
    const mitgliedschaft = await daten.mitgliedschaftAnlegen(c, { personId: person_id, vereinId: verein_id, vorname: person.vorname, nachname: person.nachname, eintritt, von });
    if (judopass_id) {
      const lv = await landesverbandVon(ctx, c, { verein_id });
      await daten.aufgabeAnlegen(c, { art: 'person_zusammenfuehren', verbandId: lv?.id ?? null, personId: person_id, jetzt: ctx.jetzt, von });
    }
    return { person_id, heimatverein_id: verein_id, mitgliedschaft };
  });
}

const heute = (ctx) => ctx.jetzt.toISOString().slice(0, 10);
/** Hat die Person am Tag das Alter erreicht? Ohne Geburtsdatum nie. Am 29. Februar Geborene werden am 1. März älter. */
const mindestens = (person, jahre, tag) => !!person.geburtsdatum && `${Number(person.geburtsdatum.slice(0, 4)) + jahre}${person.geburtsdatum.slice(4)}` <= tag;

const plusJahre = (tag, n) => { const d = new Date(`${tag}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + n); return d.toISOString().slice(0, 10); };
/** Ab 18 ruht jeder Zugriff ohne gültige Freischaltung; ohne Geburtsdatum wirkt keiner (E103). */
const zugriffWirkt = (person, z, tag) => !!z && !!person.geburtsdatum && (!mindestens(person, 18, tag) || (!!z.freigeschaltet_bis && z.freigeschaltet_bis >= tag));

/**
 * Ziele für darf(): Lesen dürfen alle Vereine der Person (ausgetreten zählt nur beim Heimatverein), ändern nur der Heimatverein.
 * `rang` bleibt leer, bis das Modul graduierung liefert (Epic 6): Rollen mit Gradfilter sehen hier vorerst niemanden.
 */
async function zieleFuer(ctx, db, person) {
  const ms = await daten.mitgliedschaften(db, person.id);
  const selbst = person.benutzer_id === ctx.benutzer.id;
  const tag = heute(ctx);
  const gefunden = selbst ? null : await daten.zugriffFuer(db, { personId: person.id, benutzerId: ctx.benutzer.id });
  const zugriff = zugriffWirkt(person, gefunden, tag) ? gefunden : null;
  const vereine = [...new Set([person.heimatverein_id, ...ms.filter((m) => m.status !== 'ausgetreten').map((m) => m.verein_id)])];
  const basis = { heimatverein_id: person.heimatverein_id, person: { aktiv: ms.some((m) => m.status === 'aktiv'), rang: null, lizenzen: [] } };
  return {
    ms, selbst, zugriff,
    lesen: await ladeZiel(ctx, db, { ...basis, vereine, eigen: selbst || !!zugriff }),
    aendern: await ladeZiel(ctx, db, { ...basis, vereine: [person.heimatverein_id], eigen_kontakt: (selbst && mindestens(person, 14, tag)) || zugriff?.umfang === 'aendern' }),
  };
}

/** Lädt die Person mit ihren Zielen; kein Leserecht → 404. */
async function mitZielen(ctx, db, person) {
  if (!person) throw notFound();
  const z = await zieleFuer(ctx, db, person);
  if (!darf(ctx, 'mitglieder:LESEN', z.lesen)) throw notFound();
  return z;
}

const ansicht = (ctx, person, z) => ({
  ...projiziere(ctx, 'person', person, z.lesen),
  // Ein Verein erfährt nichts über Mitgliedschaften in anderen Vereinen (FR-7)
  mitgliedschaften: z.ms.filter((m) => z.lesen.eigen || (ctx.kontext?.art === 'verein' && ctx.kontext.id === m.verein_id)),
});

export async function personLesen(ctx, db, { id }) {
  const person = await daten.personLesen(db, id);
  return ansicht(ctx, person, await mitZielen(ctx, db, person));
}

/** FR-5: Kontaktdaten ändern Heimatverein, Person ab 14 und Benutzer mit Zugriff; andere Vereine lesen nur. */
export const kontaktAendern = (ctx, db, { id, version, aenderung }) => inTransaktion(db, async (c) => {
  if (!Object.keys(aenderung).length) throw badRequest('Keine änderbaren Felder angegeben');
  const alt = await daten.personSperren(c, id);
  const z = await mitZielen(ctx, c, alt);
  if (!darfFelder(ctx, 'mitglieder:AENDERN', 'person', Object.keys(aenderung), z.aendern)) throw fehler(422, 'Diese Kontaktdaten darfst du nicht ändern', 'feld_nicht_erlaubt');
  if (alt.change_seq !== version) throw fehler(412, 'Der Datensatz wurde inzwischen geändert', 'version_veraltet');
  return ansicht(ctx, await daten.kontaktAendern(c, { ...alt, ...aenderung, von: ctx.benutzer.id }), z);
});

/** Eigene Person und Personen mit wirksamem Zugriff, unabhängig vom Kontext (FR-15, FR-18). */
export async function meinePersonen(ctx, db) {
  const tag = heute(ctx);
  const ps = [];
  for (const p of await daten.personenFuerBenutzer(db, ctx.benutzer.id)) {
    const z = await zieleFuer(ctx, db, p);
    if (!z.lesen.eigen || !darf(ctx, 'mitglieder:LESEN', z.lesen)) continue;
    ps.push({ ...ansicht(ctx, p, z), selbst: z.selbst, zugriff: z.zugriff ? { art: z.zugriff.art, umfang: z.zugriff.umfang } : null, volljaehrig: mindestens(p, 18, tag) });
  }
  return { personen: ps };
}

// ---- Zugriffe erteilen und entziehen (FR-17, E86, E103) ----
const VERSTOSS = {
  personen_zugriff_aktiv_uq: [409, 'Dieser Benutzer hat schon einen Zugriff', 'zugriff_vorhanden'],
  zugriff_benutzer_unbekannt: [404, 'Benutzer nicht gefunden', 'benutzer_unbekannt'],
  zugriff_ohne_geburtsdatum: [422, 'Ohne Geburtsdatum der Person gibt es keinen Zugriff', 'geburtsdatum_fehlt'],
  zugriff_selbst: [422, 'Die Person selbst braucht keinen Zugriff', 'zugriff_selbst'],
  zugriff_berechtigter_minderjaehrig: [422, 'Berechtigte müssen volljährig sein', 'berechtigter_minderjaehrig'],
};
async function schreibe(db, fn) {
  try {
    return await inTransaktion(db, fn);
  } catch (e) {
    const v = Object.hasOwn(VERSTOSS, e.constraint ?? '') && VERSTOSS[e.constraint];
    throw v ? fehler(...v) : e;
  }
}

/** In welcher Eigenschaft verwaltet der Benutzer die Zugriffe? 'heimat' | 'person' | 'eltern' | null. */
function verwaltetAls(ctx, person, z) {
  if (z.selbst && mindestens(person, 18, heute(ctx))) return 'person';
  // Heimatverein nur mit vollem Änderungsrecht im Kontext dieses Vereins; kein Feldfilter, keine Verbandsrolle
  if (ctx.kontext?.art === 'verein' && ctx.kontext.id === person.heimatverein_id
    && darfFelder(ctx, 'mitglieder:AENDERN', 'person', ['vorname', 'email'], z.aendern)) return 'heimat';
  return z.zugriff?.art === 'erziehungsberechtigt' ? 'eltern' : null;
}

/** Die übrigen Erziehungsberechtigten erfahren von jeder Änderung. */
async function meldeZugriff(ctx, c, person, art, ausser) {
  const empfaenger = (await daten.zugriffeVon(c, person.id))
    .filter((x) => x.art === 'erziehungsberechtigt' && !ausser.includes(x.benutzer_id)).map(({ benutzer_id }) => ({ benutzer_id }));
  await benachrichtigung.senden(ctx, c, { empfaenger, art, daten: { vorname: person.vorname } });
}

export const zugriffErteilen = (ctx, db, { id, benutzer_id, art, umfang }) => schreibe(db, async (c) => {
  const person = await daten.personSperren(c, id);
  const z = await mitZielen(ctx, c, person);
  const als = verwaltetAls(ctx, person, z);
  if (!als) throw notFound();
  if (als === 'eltern' && (art !== 'bevollmaechtigt' || umfang !== 'lesen')) throw fehler(422, 'Dritten darfst du nur Lesezugriff geben', 'nur_lesezugriff');
  if (benutzer_id === ctx.benutzer.id) throw fehler(422, 'Dir selbst kannst du keinen Zugriff geben', 'selbsterteilung');
  // Ab 18 wirkt ein Zugriff nur mit Freischaltung durch die Person selbst, je ein Jahr (E103)
  const bis = als === 'person' ? plusJahre(heute(ctx), 1) : null;
  const neu = await daten.zugriffAnlegen(c, { personId: id, benutzerId: benutzer_id, art, umfang, bis, von: ctx.benutzer.id, jetzt: ctx.jetzt });
  await audit.schreiben(ctx, c, { aktion: 'recht_vergeben', objekt_art: 'personen_zugriff', objekt_id: neu.id, neu });
  await meldeZugriff(ctx, c, person, 'zugriff_erteilt', [ctx.benutzer.id, benutzer_id]);
  return neu;
});

export async function zugriffeLesen(ctx, db, { id }) {
  const person = await daten.personLesen(db, id);
  const z = await mitZielen(ctx, db, person);
  if (!verwaltetAls(ctx, person, z)) throw notFound();
  return { zugriffe: await daten.zugriffeVon(db, id) };
}

/** Heimatverein und volljährige Person beenden jeden Zugriff, Eltern die Zugriffe Dritter, jeder seinen eigenen. */
export const zugriffEntziehen = (ctx, db, { id, zugriff_id, grund = null }) => schreibe(db, async (c) => {
  const person = await daten.personSperren(c, id);
  if (!person) throw notFound();
  const z = await zieleFuer(ctx, c, person);
  const alt = await daten.zugriffSperren(c, { id: zugriff_id, personId: id });
  if (!alt) throw notFound();
  if (alt.benutzer_id !== ctx.benutzer.id) {
    const als = verwaltetAls(ctx, person, z);
    if (!als || (als === 'eltern' && alt.art !== 'bevollmaechtigt')) throw notFound();
  }
  await meldeZugriff(ctx, c, person, 'zugriff_entzogen', [ctx.benutzer.id, alt.benutzer_id]);
  const ende = await daten.zugriffBeenden(c, { id: zugriff_id, von: ctx.benutzer.id, jetzt: ctx.jetzt });
  await audit.schreiben(ctx, c, { aktion: 'recht_entzogen', objekt_art: 'personen_zugriff', objekt_id: zugriff_id, alt: ende, grund });
  return ende;
});
