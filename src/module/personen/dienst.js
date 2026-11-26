import { inTransaktion } from '../../db.js';
import { badRequest, conflict, fehler, notFound, tooMany } from '../../errors.js';
import * as audit from '../audit/dienst.js';
import * as benachrichtigung from '../benachrichtigung/dienst.js';
import { fristFuer, landesverbandVon, vereinFuer } from '../organisation/dienst.js';
import { beendeDirektrechte, darf, darfFelder, ladeZiel, projiziere, verlangeAuf } from '../rechte/dienst.js';
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

/** Nur diese Person (Einladung) oder das ganze Konto (fremdes Passwort) ist noch nicht bestätigt. */
const unbestaetigt = (ctx, person) => !!ctx.rechte.unbestaetigt || (person?.benutzer_id === ctx.benutzer.id && !!person.konto_unbestaetigt_seit);
const plusJahre = (tag, n) => { const d = new Date(`${tag}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + n); return d.toISOString().slice(0, 10); };
/** Ab 18 ruht jeder Zugriff ohne gültige Freischaltung; ohne Geburtsdatum wirkt keiner (E103). */
const zugriffWirkt = (person, z, tag) => !!z && !!person.geburtsdatum && (z.art === 'vormund' || !mindestens(person, 18, tag) || (!!z.freigeschaltet_bis && z.freigeschaltet_bis >= tag));

/**
 * Ziele für darf(): Lesen dürfen alle Vereine der Person (ausgetreten zählt nur beim Heimatverein), ändern nur der Heimatverein.
 * `rang` bleibt leer, bis das Modul graduierung liefert (Epic 6): Rollen mit Gradfilter sehen hier vorerst niemanden.
 */
async function zieleFuer(ctx, db, person) {
  const ms = await daten.mitgliedschaften(db, person.id);
  // Am Gerät (PIN) gibt es keine Rechte als Person oder mit Zugriff: sie gälten über den Verein des Geräts hinaus
  const selbst = !ctx.rechte.geraet && person.benutzer_id === ctx.benutzer.id;
  const tag = heute(ctx);
  const gefunden = selbst || ctx.rechte.geraet ? null : await daten.zugriffFuer(db, { personId: person.id, benutzerId: ctx.benutzer.id });
  const zugriff = zugriffWirkt(person, gefunden, tag) ? gefunden : null;
  const vereine = [...new Set([person.heimatverein_id, ...ms.filter((m) => m.status !== 'ausgetreten').map((m) => m.verein_id)])];
  const basis = { heimatverein_id: person.heimatverein_id, person: { aktiv: ms.some((m) => m.status === 'aktiv'), rang: null, lizenzen: [] } };
  return {
    ms, selbst, zugriff,
    lesen: await ladeZiel(ctx, db, { ...basis, vereine, eigen: selbst || !!zugriff }),
    aendern: await ladeZiel(ctx, db, { ...basis, vereine: [person.heimatverein_id], eigen_kontakt: !unbestaetigt(ctx, person) && ((selbst && mindestens(person, 14, tag)) || zugriff?.umfang === 'aendern') }),
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
  vormund_braucht_nachweis: [422, 'Ein Vormund braucht einen vom Heimatverein bestätigten Nachweis', 'nachweis_fehlt'],
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

const appSchreibt = (ctx) => ctx.rechte.app_scopes.includes('mitglieder:schreiben');

/** In welcher Eigenschaft verwaltet der Benutzer die Zugriffe? 'heimat' | 'person' | 'eltern' | null. */
function verwaltetAls(ctx, person, z) {
  const bestaetigt = !ctx.rechte.unbestaetigt;
  if (bestaetigt && !unbestaetigt(ctx, person) && z.selbst && mindestens(person, 18, heute(ctx))) return 'person';
  // Heimatverein nur mit vollem Änderungsrecht im Kontext dieses Vereins; kein Feldfilter, keine Verbandsrolle
  if (ctx.kontext?.art === 'verein' && ctx.kontext.id === person.heimatverein_id
    && darfFelder(ctx, 'mitglieder:AENDERN', 'person', ['vorname', 'email'], z.aendern)) return 'heimat';
  return bestaetigt && z.zugriff?.art === 'erziehungsberechtigt' ? 'eltern' : null;
}

/** Die übrigen Erziehungsberechtigten erfahren von jeder Änderung. */
async function meldeZugriff(ctx, c, person, art, ausser) {
  const empfaenger = (await daten.zugriffeVon(c, person.id))
    .filter((x) => x.art === 'erziehungsberechtigt' && zugriffWirkt(person, x, heute(ctx)) && !ausser.includes(x.benutzer_id)).map(({ benutzer_id }) => ({ benutzer_id }));
  await benachrichtigung.senden(ctx, c, { empfaenger, art, daten: { vorname: person.vorname } });
}

export const zugriffErteilen = (ctx, db, { id, benutzer_id, art, umfang, nachweis_id = null }) => schreibe(db, async (c) => {
  const person = await daten.personSperren(c, id);
  const z = await mitZielen(ctx, c, person);
  const als = verwaltetAls(ctx, person, z);
  if (!als || !appSchreibt(ctx)) throw notFound();
  if (als === 'eltern' && (art !== 'bevollmaechtigt' || umfang !== 'lesen')) throw fehler(422, 'Dritten darfst du nur Lesezugriff geben', 'nur_lesezugriff');
  if (art === 'vormund') {
    // FR-76: nur der Heimatverein, nur mit von ihm bestätigtem Nachweis
    if (als !== 'heimat') throw notFound();
    if (!nachweis_id) throw fehler(...VERSTOSS.vormund_braucht_nachweis);
  } else if (nachweis_id) throw badRequest('Ein Nachweis gehört nur zu einem Vormund');
  if (benutzer_id === ctx.benutzer.id) throw fehler(422, 'Dir selbst kannst du keinen Zugriff geben', 'selbsterteilung');
  // Ab 18 wirkt ein Zugriff nur mit Freischaltung durch die Person selbst, je ein Jahr (E103)
  const bis = als === 'person' ? plusJahre(heute(ctx), 1) : null;
  const neu = await daten.zugriffAnlegen(c, { personId: id, benutzerId: benutzer_id, art, umfang, bis, nachweisId: nachweis_id, von: ctx.benutzer.id, jetzt: ctx.jetzt });
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
  if (!person || ctx.rechte.geraet || ctx.rechte.unbestaetigt || !appSchreibt(ctx)) throw notFound();
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

// ---- Dokumente der Person (FR-75) ----
/** Erkennt den Inhalt, nicht den angegebenen Typ. */
function dateityp(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', endung: 'jpg' };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', endung: 'png' };
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', endung: 'webp' };
  if (b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', endung: 'pdf' };
  return null;
}

/**
 * Positivliste: Heimatverein (im eigenen Kontext, mit vollem Änderungsrecht), Person, Benutzer mit Zugriff; alle anderen 404, auch
 * der Super-Admin ohne Rolle dort. Das Passfoto sieht im Heimatverein jeder mit Leserecht. Der LV bei Judopass-Anträgen kommt mit diesen.
 */
async function dokumentRechte(ctx, db, person) {
  if (!person) throw notFound();
  const z = await zieleFuer(ctx, db, person);
  const eigenLesen = z.lesen.eigen && darf(ctx, 'mitglieder:LESEN', z.lesen);
  const eigen = eigenLesen && !unbestaetigt(ctx, person) && (!z.zugriff || !ctx.rechte.unbestaetigt);
  const c = { ...ctx, rechte: { ...ctx.rechte, super_admin: false } };
  const imHeimatverein = ctx.kontext?.art === 'verein' && ctx.kontext.id === person.heimatverein_id;
  const ziel = { ...z.aendern, eigen_kontakt: false };
  const verwalten = imHeimatverein && darfFelder(c, 'mitglieder:AENDERN', 'person', ['vorname', 'email'], ziel);
  const r = {
    // Nachweise und Scans enthalten Kontaktdaten: nur für Apps, die sie sehen dürfen
    alle: (eigen || verwalten) && ctx.rechte.app_scopes.includes('mitglieder:kontakt'),
    passfoto: eigenLesen || verwalten || (imHeimatverein && darf(c, 'mitglieder:LESEN', { ...ziel, eigen: false })),
    schreiben: appSchreibt(ctx) && (verwalten || (z.selbst && eigen && mindestens(person, 14, heute(ctx)))),
  };
  if (!r.passfoto) throw notFound();
  return r;
}
const sichtbar = (r, d) => r.alle || (r.passfoto && d.art === 'passfoto');

export async function dokumenteLesen(ctx, db, { id }) {
  const r = await dokumentRechte(ctx, db, await daten.personLesen(db, id));
  return { dokumente: (await daten.dokumenteVon(db, id)).filter((d) => sichtbar(r, d)) };
}

export async function dokumentLesen(ctx, db, { id, dokument_id }) {
  const r = await dokumentRechte(ctx, db, await daten.personLesen(db, id));
  const d = await daten.dokumentInhalt(db, { id: dokument_id, personId: id });
  if (!d || !sichtbar(r, d)) throw notFound();
  return { datei: { mime: d.mime_typ, name: d.dateiname, inhalt: d.inhalt } };
}

export const dokumentAblegen = (ctx, db, { id, art, inhalt }) => inTransaktion(db, async (c) => {
  const person = await daten.personSperren(c, id); // hält parallele Passfotos derselben Person auseinander
  const r = await dokumentRechte(ctx, c, person);
  if (!r.schreiben) throw notFound();
  if (!Buffer.isBuffer(inhalt) || !inhalt.length) throw badRequest('Datei als Body senden', 'datei_fehlt');
  const typ = dateityp(inhalt);
  if (!typ || (art === 'passfoto' && typ.endung === 'pdf')) throw badRequest('Nur JPEG, PNG, WebP oder PDF (Passfoto: nur Bild)', 'dateityp_ungueltig');
  const d = { personId: id, vereinId: person.heimatverein_id, art, name: `${art}.${typ.endung}`, mime: typ.mime, inhalt, von: ctx.benutzer.id };
  return (art === 'passfoto' && await daten.passfotoErsetzen(c, d)) || daten.dokumentAnlegen(c, d);
});

/** FR-76: der Heimatverein bestätigt den Nachweis der Vormundschaft. */
export const nachweisBestaetigen = (ctx, db, { id, dokument_id }) => inTransaktion(db, async (c) => {
  const person = await daten.personSperren(c, id);
  const z = await mitZielen(ctx, c, person);
  if (verwaltetAls(ctx, person, z) !== 'heimat' || !appSchreibt(ctx)) throw notFound();
  const d = await daten.nachweisBestaetigen(c, { id: dokument_id, personId: id, von: ctx.benutzer.id, jetzt: ctx.jetzt });
  if (!d) throw notFound();
  return d;
});

// ---- Eigenes Konto, Volljährigkeit (FR-19, NFR-4) ----
/** Eltern oder Heimatverein legen ab 14 ein Konto an. Das Startpasswort kennt der Anlegende: Personenrechte erst nach Bestätigung. */
export const kontoAnlegen = (ctx, db, { id, benutzername, konten }) => inTransaktion(db, async (c) => {
  const person = await daten.personSperren(c, id);
  const z = await mitZielen(ctx, c, person);
  const als = verwaltetAls(ctx, person, z);
  if ((als !== 'heimat' && als !== 'eltern') || !appSchreibt(ctx)) throw notFound();
  if (!mindestens(person, 14, heute(ctx))) throw fehler(422, 'Ein eigenes Konto gibt es ab 14 Jahren', 'zu_jung');
  if (person.benutzer_id) throw conflict('Diese Person hat schon ein Konto', 'konto_vorhanden');
  const heimat = z.ms.find((m) => m.verein_id === person.heimatverein_id);
  if (!heimat || heimat.status === 'ausgetreten') throw conflict('Die Person ist nicht mehr Mitglied des Heimatvereins', 'nicht_mitglied');
  return konten.anlegen(ctx, c, { benutzername, vorname: person.vorname, nachname: person.nachname, verein_id: person.heimatverein_id, mitglied_id: heimat.id });
});

/**
 * Schickt dem unbestätigten Konto den Link. Reihenfolge: eigene, vorher bestätigte Adresse; Adresse der Person, wenn sie weder ein
 * Vergebender noch ein von ihm Berechtigter gesetzt hat; bei Minderjährigen die übrigen Erziehungsberechtigten. Die Adresse wird nicht verraten.
 */
export async function bestaetigungAnfordern(ctx, db, { konten }) {
  if (ctx.rechte.geraet) throw notFound();
  const benutzer_id = ctx.benutzer.id;
  const { an, token } = await inTransaktion(db, async (c) => {
    const person = await daten.personZuKonto(c, benutzer_id);
    const tag = heute(ctx);
    const eltern = person?.geburtsdatum && !mindestens(person, 18, tag) ? (await daten.zugriffeVon(c, person.id)).filter((x) => x.art === 'erziehungsberechtigt') : [];
    const a = await konten.adresse(ctx, c, { benutzer_id });
    const offen = person?.konto_unbestaetigt_seit ? { id: person.id, seit: person.konto_unbestaetigt_seit } : null;
    if (!a && !offen) throw conflict('Das Konto ist schon bestätigt', 'schon_bestaetigt');
    // Ein Zweitkonto, das ein Vergebender berechtigt hat, ist keine unabhängige Adresse
    const durch = [...(a?.fremd_durch ?? []), ...(offen ? person.konto_vergeben_durch : [])];
    const befangen = new Set([...durch, ...(person ? await daten.zugriffeErteiltDurch(c, { personId: person.id, durch }) : [])]);
    const eigene = a?.eigene ?? (person?.email && durch.length && !befangen.has(person.email_gesetzt_von) ? person.email : null);
    const ziel = eigene ? [eigene] : await konten.adressen(ctx, c, { benutzer_ids: eltern.map((x) => x.benutzer_id).filter((x) => !befangen.has(x)) });
    if (!ziel.length) throw conflict('Keine Adresse für die Bestätigung hinterlegt', 'adresse_fehlt');
    return { an: ziel, token: await konten.linkAnlegen(ctx, c, { benutzer_id, person: offen, adresse: eigene, ueber_eltern: !eigene }) };
  });
  for (const x of an) await konten.senden(x, token);
  return { ok: true };
}

/** Job: ab 18 ruhen alle Zugriffe ohne gültige Freischaltung, außer Vormund. darf() rechnet ohnehin tagesgenau; hier für /v1 und Audit. */
export const volljaehrigkeitPruefen = (ctx, db) => inTransaktion(db, async (c) => {
  const tag = heute(ctx);
  let ruhend = 0;
  for (const z of await daten.ruhensKandidaten(c, tag)) {
    if (zugriffWirkt(z, z, tag)) continue;
    const neu = await daten.zugriffRuht(c, { id: z.id, jetzt: ctx.jetzt });
    await audit.schreiben(ctx, c, { aktion: 'recht_entzogen', objekt_art: 'personen_zugriff', objekt_id: z.id, alt: neu, grund: 'Zugriff ruht ab 18' });
    ruhend++;
  }
  return { ruhend };
});

async function abfrageStand(ctx, c, person, konten) {
  const z = await mitZielen(ctx, c, person);
  if (verwaltetAls(ctx, person, z) !== 'person') throw notFound();
  const zugriffe = (await daten.zugriffeVon(c, person.id)).filter((x) => x.art !== 'vormund');
  const zuletzt = person.zugriffe_abgefragt_am;
  // Nutzerentscheid 2026-11-26: Haben Eltern das Konto bestätigt, nur ein Hinweis, das Passwort selbst zu ändern
  const passwort_aendern = await konten.elternPasswort(ctx, c, { benutzer_id: ctx.benutzer.id });
  return { faellig: zugriffe.length > 0 && (!zuletzt || plusJahre(zuletzt, 1) <= heute(ctx)), zugriffe, passwort_aendern };
}

/** Jahresfrage der volljährigen Person; die Oberfläche fragt nach der Anmeldung. */
export const abfrageLesen = (ctx, db, { id, konten }) => inTransaktion(db, async (c) => abfrageStand(ctx, c, await daten.personLesen(c, id), konten));

export const abfrageBeantworten = (ctx, db, { id, entscheidungen, konten }) => inTransaktion(db, async (c) => {
  const person = await daten.personSperren(c, id);
  const { zugriffe } = await abfrageStand(ctx, c, person, konten);
  if (!appSchreibt(ctx)) throw notFound();
  const wahl = new Map(entscheidungen.map((e) => [e.zugriff_id, e.behalten]));
  if (wahl.size !== entscheidungen.length || wahl.size !== zugriffe.length || !zugriffe.every((z) => wahl.has(z.id))) throw fehler(422, 'Bitte über jeden Zugriff genau einmal entscheiden', 'entscheidung_fehlt');
  for (const z of zugriffe) {
    const behalten = wahl.get(z.id);
    const neu = behalten ? await daten.zugriffFreischalten(c, { id: z.id, bis: plusJahre(heute(ctx), 1) })
      : await daten.zugriffBeenden(c, { id: z.id, von: ctx.benutzer.id, jetzt: ctx.jetzt });
    await audit.schreiben(ctx, c, { aktion: behalten ? 'recht_vergeben' : 'recht_entzogen', objekt_art: 'personen_zugriff', objekt_id: z.id, [behalten ? 'neu' : 'alt']: neu, grund: 'Jahresfrage' });
  }
  await daten.abfrageMerken(c, { id, tag: heute(ctx) });
  return { zugriffe: await daten.zugriffeVon(c, id) };
});

// ---- Mitgliedschaftsantrag (FR-7, E70, E100) ----
const FEHLVERSUCHE_VEREIN = 20; const FEHLVERSUCHE_BENUTZER = 5; // je 24 Stunden; der Benutzerwert hält Einzelne davon ab, den Verein zu sperren
const abgelehnt = () => fehler(422, 'Der Antrag kann nicht angenommen werden', 'antrag_abgelehnt');
const nurOffen = { ein_offener_mitgliedschaftsantrag: [409, 'Es gibt schon einen offenen Antrag', 'antrag_offen'] };
Object.assign(VERSTOSS, nurOffen);

/** Ordnet über Pass-Nr., Nachname und Geburtsdatum zu. Ein Fehlversuch wird in eigener Transaktion gezählt, auch wenn der Antrag scheitert. */
async function personZuPass(ctx, db, { verein_id, judopass_nr, nachname, geburtsdatum }) {
  const id = await inTransaktion(db, async (c) => {
    await daten.fehlversucheSperren(c, verein_id, ctx.benutzer.id);
    const seit = new Date(ctx.jetzt.getTime() - 86_400_000);
    const n = await daten.fehlversuche(c, { vereinId: verein_id, benutzerId: ctx.benutzer.id, seit });
    if (n.verein >= FEHLVERSUCHE_VEREIN || n.benutzer >= FEHLVERSUCHE_BENUTZER) throw tooMany('Zu viele fehlgeschlagene Anträge – bitte später erneut');
    const treffer = await daten.personZuPass(c, { nummer: judopass_nr, nachname, geburtsdatum });
    if (!treffer) await daten.fehlversuchMerken(c, { vereinId: verein_id, benutzerId: ctx.benutzer.id, jetzt: ctx.jetzt });
    return treffer;
  });
  if (!id) throw abgelehnt();
  return id;
}

async function antragsVerein(ctx, c, id) {
  const verein = await vereinFuer(ctx, c, { id });
  if (!verein) throw notFound();
  if (verein.aufgeloest_am) throw conflict('Der Verein ist aufgelöst', 'verein_aufgeloest');
  return verein;
}

/** Ausgetretene dürfen neu beantragen (der Verein reaktiviert dann auf Wunsch), bestehende Mitglieder nicht. */
async function pruefeNichtMitglied(c, personId, vereinId) {
  const m = await daten.mitgliedschaftIn(c, { personId, vereinId });
  if (m && !m.geloescht_am && m.status !== 'ausgetreten') throw conflict('Die Mitgliedschaft besteht schon', 'mitgliedschaft_vorhanden');
}

const eigenSicht = ({ id, verein_id, vorname, nachname, geburtsdatum, status, grund, erstellt_am, entschieden_am, change_seq }) => ({ id, verein_id, vorname, nachname, geburtsdatum, status, grund, erstellt_am, entschieden_am, change_seq });
/** Ohne aktuellen Bezug zur Person: nur Stand des Antrags, kein Name, kein Grund. */
const standSicht = ({ id, verein_id, status, erstellt_am, entschieden_am, change_seq }) => ({ id, verein_id, status, erstellt_am, entschieden_am, change_seq });
/** Vor der Annahme nur die Antragsdaten; die Person erst danach. Nach Ablehnung, Rückzug oder Verfall kein Geburtsdatum mehr; die Pass-Nr. nie. */
const vereinsSicht = (a) => {
  const { geburtsdatum, ...sicht } = eigenSicht(a);
  return { ...sicht, ...(['offen', 'angenommen'].includes(a.status) ? { geburtsdatum } : {}), art: a.erfasst_von ? 'schriftlich' : 'online', ...(a.status === 'angenommen' ? { person_id: a.person_id } : {}) };
};

/** Wer für die Person Anträge stellt und zurückzieht: sie selbst ab 14, Eltern und Vormund mit Änderungszugriff. */
const VERTRETER = ['erziehungsberechtigt', 'vormund'];
const vertritt = (ctx, person, z) => (z.selbst && !unbestaetigt(ctx, person) && mindestens(person, 14, heute(ctx))) || (z.zugriff?.umfang === 'aendern' && VERTRETER.includes(z.zugriff.art));

/** Person und Erziehungsberechtigte bzw. Vormund. */
const betroffene = async (ctx, c, person) => [person.benutzer_id, ...(await daten.zugriffeVon(c, person.id))
  .filter((z) => z.art !== 'bevollmaechtigt' && zugriffWirkt(person, z, heute(ctx))).map((z) => z.benutzer_id)].filter(Boolean);
const empfaengerListe = (ids) => [...new Set(ids)].map((benutzer_id) => ({ benutzer_id }));

async function antragEinfuegen(ctx, c, a, { konten, verein }) {
  const neu = await daten.antragAnlegen(c, { ...a, von: ctx.benutzer.id, jetzt: ctx.jetzt });
  await benachrichtigung.senden(ctx, c, { empfaenger: (await konten.adminsVon(c, verein.id)).filter((x) => x.benutzer_id !== ctx.benutzer.id), art: 'antrag_eingegangen', daten: {} });
  if (a.person) {
    // Person und Erziehungsberechtigte erfahren von Anträgen, die jemand anderes für sie stellt
    const kreis = (await betroffene(ctx, c, a.person)).filter((x) => x !== ctx.benutzer.id);
    await benachrichtigung.senden(ctx, c, { empfaenger: empfaengerListe(kreis), art: 'antrag_gestellt', daten: { vorname: a.person.vorname, verein: verein.name } });
  }
  return neu;
}

/** Online: die eigene Person ab 14 oder ein Kind aus dem Konto; mit Pass-Nr. die zugeordnete Person. */
export async function antragStellen(ctx, db, { verein_id, person_id = null, judopass_nr = null, vorname = null, nachname = null, geburtsdatum = null, konten }) {
  if (ctx.rechte.geraet || ctx.rechte.unbestaetigt || !appSchreibt(ctx) || !darf(ctx, 'mitgliedschaftsantrag:ANLEGEN')) throw notFound();
  const mitPass = !!judopass_nr;
  if (mitPass ? (person_id || !vorname || !nachname || !geburtsdatum) : (!person_id || vorname || nachname || geburtsdatum)) {
    throw badRequest('Entweder person_id oder judopass_nr mit Vorname, Nachname und Geburtsdatum angeben');
  }
  if (mitPass) {
    await antragsVerein(ctx, db, verein_id);
    const selbst = await daten.personZuKonto(db, ctx.benutzer.id);
    if (selbst && !mindestens(selbst, 14, heute(ctx))) throw notFound();
  }
  const id = mitPass ? await personZuPass(ctx, db, { verein_id, judopass_nr, nachname, geburtsdatum }) : person_id;
  let fremd = false;
  return schreibe(db, async (c) => {
    const person = await daten.personSperren(c, id);
    if (!person) throw notFound();
    const z = await zieleFuer(ctx, c, person);
    fremd = !z.selbst && !z.zugriff;
    if (!mitPass) {
      if (!vertritt(ctx, person, z)) throw notFound();
      if (!person.geburtsdatum) throw fehler(422, 'Das Geburtsdatum der Person fehlt', 'geburtsdatum_fehlt');
    }
    const verein = await antragsVerein(ctx, c, verein_id);
    await pruefeNichtMitglied(c, id, verein_id);
    const angabe = mitPass ? { vorname, nachname, geburtsdatum } : person;
    return eigenSicht(await antragEinfuegen(ctx, c, {
      vereinId: verein_id, personId: id, vorname: angabe.vorname, nachname: angabe.nachname, geburtsdatum: angabe.geburtsdatum, judopassNr: judopass_nr, gestelltVon: ctx.benutzer.id, person,
    }, { konten, verein }));
  }).catch(async (e) => {
    // Fremde erfahren nicht, ob die Person dort Mitglied ist oder einen Antrag offen hat; der Versuch zählt wie ein Fehlversuch
    if (!fremd || !['mitgliedschaft_vorhanden', 'antrag_offen'].includes(e.code)) throw e;
    await inTransaktion(db, async (c) => {
      await daten.fehlversucheSperren(c, verein_id, ctx.benutzer.id);
      await daten.fehlversuchMerken(c, { vereinId: verein_id, benutzerId: ctx.benutzer.id, jetzt: ctx.jetzt });
    });
    throw abgelehnt();
  });
}

/** Der Verein erfasst einen schriftlichen Antrag; ohne Pass-Nr. entsteht bei der Annahme eine neue Person. */
export async function antragErfassen(ctx, db, { verein_id, person, judopass_nr = null, konten }) {
  await verlangeAuf(ctx, db, 'mitgliedschaftsantrag:AENDERN', { vereine: [verein_id] });
  if (person.geburtsdatum > heute(ctx)) throw fehler(422, 'Das Geburtsdatum liegt in der Zukunft', 'geburtsdatum_ungueltig');
  const kontakt = ['strasse', 'plz', 'ort', 'land', 'email', 'telefon'].some((f) => f in person);
  if (kontakt && !ctx.rechte.app_scopes.includes('mitglieder:kontakt')) throw fehler(422, 'Kontaktdaten sind über diese App nicht erlaubt', 'feld_nicht_erlaubt');
  await antragsVerein(ctx, db, verein_id);
  const id = judopass_nr ? await personZuPass(ctx, db, { verein_id, judopass_nr, nachname: person.nachname, geburtsdatum: person.geburtsdatum }) : null;
  return schreibe(db, async (c) => {
    const verein = await antragsVerein(ctx, c, verein_id);
    const gefunden = id && await daten.personSperren(c, id);
    if (id) await pruefeNichtMitglied(c, id, verein_id);
    return vereinsSicht(await antragEinfuegen(ctx, c, {
      vereinId: verein_id, personId: id, vorname: person.vorname, nachname: person.nachname, geburtsdatum: person.geburtsdatum, judopassNr: judopass_nr,
      angaben: id ? null : person, erfasstVon: ctx.benutzer.id, person: gefunden,
    }, { konten, verein }));
  });
}

export async function antraegeLesen(ctx, db, { verein_id, status = null }) {
  await verlangeAuf(ctx, db, 'mitgliedschaftsantrag:LESEN', { vereine: [verein_id] });
  return { antraege: (await daten.antraegeVon(db, { vereinId: verein_id, status })).map(vereinsSicht) };
}
export async function antragLesen(ctx, db, { verein_id, id }) {
  await verlangeAuf(ctx, db, 'mitgliedschaftsantrag:LESEN', { vereine: [verein_id] });
  const a = await daten.antragLesen(db, { id, vereinId: verein_id });
  if (!a) throw notFound();
  return vereinsSicht(a);
}
export async function meineAntraege(ctx, db) {
  // Am Gerät gibt es keine Personenrechte; die App braucht den Lese-Scope wie bei /ich/personen
  if (ctx.rechte.geraet || !ctx.rechte.app_scopes.includes('mitglieder:lesen')) throw notFound();
  const bezug = [];
  for (const p of await daten.personenFuerBenutzer(db, ctx.benutzer.id)) {
    const z = await zieleFuer(ctx, db, p);
    if (z.selbst || (z.zugriff && VERTRETER.includes(z.zugriff.art))) bezug.push(p.id);
  }
  const antraege = await daten.antraegeFuer(db, { benutzerId: ctx.benutzer.id, personIds: bezug });
  return { antraege: antraege.map((a) => (bezug.includes(a.person_id) ? eigenSicht(a) : standSicht(a))) };
}

export const antragZurueckziehen = (ctx, db, { id }) => inTransaktion(db, async (c) => {
  const a = await daten.antragSperren(c, id);
  if (!a || ctx.rechte.geraet || ctx.rechte.unbestaetigt || !appSchreibt(ctx)) throw notFound();
  const person = a.person_id && await daten.personLesen(c, a.person_id);
  const vertreter = !!person && vertritt(ctx, person, await zieleFuer(ctx, c, person));
  // Online gestellte Anträge ziehen auch die Person und ihre aktuellen Vertreter zurück; schriftliche liegen beim Verein
  if (!a.gestellt_von || (a.gestellt_von !== ctx.benutzer.id && !vertreter)) throw notFound();
  if (a.status !== 'offen') throw conflict('Der Antrag ist schon entschieden', 'status_unzulaessig');
  return (vertreter ? eigenSicht : standSicht)(await daten.antragEntscheiden(c, { id, status: 'zurueckgezogen', personId: a.person_id, von: ctx.benutzer.id, jetzt: ctx.jetzt }));
});

/** Gilt der Wille noch? Der Antragsteller vertritt die Person weiterhin und sein Konto besteht. Mit Pass-Nr. stellt auch ein Fremder. */
async function antragGilt(ctx, c, a, konten) {
  if (!a.gestellt_von || a.judopass_nr) return true;
  if (!await konten.aktiv(c, a.gestellt_von)) return false;
  const person = await daten.personSperren(c, a.person_id);
  if (person.benutzer_id === a.gestellt_von) return mindestens(person, 14, heute(ctx));
  const z = await daten.zugriffFuer(c, { personId: person.id, benutzerId: a.gestellt_von });
  return zugriffWirkt(person, z, heute(ctx)) && z.umfang === 'aendern' && VERTRETER.includes(z.art);
}

/** Annahme: Mitgliedschaft mit nächster Nummer; Heimatverein und Pass bleiben unverändert. */
export async function antragEntscheiden(ctx, db, { verein_id, id, version, entscheidung, reaktivieren = false, eintritt = null, grund = null, konten }) {
  await verlangeAuf(ctx, db, 'mitgliedschaftsantrag:AENDERN', { vereine: [verein_id] });
  return schreibe(db, async (c) => {
    const a = await daten.antragSperren(c, id);
    if (!a || a.verein_id !== verein_id) throw notFound();
    if (a.change_seq !== version) throw fehler(412, 'Der Datensatz wurde inzwischen geändert', 'version_veraltet');
    if (a.status !== 'offen') throw conflict('Der Antrag ist schon entschieden', 'status_unzulaessig');
    const verein = await vereinFuer(ctx, c, { id: verein_id });
    const von = ctx.benutzer.id;
    let personId = a.person_id; let mitgliedschaft = null;
    if (entscheidung === 'annehmen') {
      await antragsVerein(ctx, c, verein_id);
      if (!await antragGilt(ctx, c, a, konten)) throw conflict('Der Antragsteller vertritt die Person nicht mehr; der Antrag ist neu zu stellen', 'antrag_hinfaellig');
      if (!personId) personId = (await daten.personAnlegen(c, { ...a.angaben, vereinId: verein_id, von })).id;
      else await daten.personSperren(c, personId);
      const alt = await daten.mitgliedschaftIn(c, { personId, vereinId: verein_id });
      if (alt) {
        await pruefeNichtMitglied(c, personId, verein_id);
        if (!reaktivieren) throw conflict('Die Person war schon Mitglied; zum Reaktivieren bestätigen', 'mitglied_ausgetreten');
        mitgliedschaft = await daten.mitgliedschaftReaktivieren(c, { id: alt.id, eintritt, von });
      } else mitgliedschaft = await daten.mitgliedschaftAnlegen(c, { personId, vereinId: verein_id, vorname: a.vorname, nachname: a.nachname, eintritt, von });
    }
    const status = entscheidung === 'annehmen' ? 'angenommen' : 'abgelehnt';
    const neu = await daten.antragEntscheiden(c, { id, status, personId, grund, von, jetzt: ctx.jetzt });
    const person = a.person_id && await daten.personLesen(c, a.person_id);
    const kreis = [a.gestellt_von, ...(person ? await betroffene(ctx, c, person) : [])].filter(Boolean);
    await benachrichtigung.senden(ctx, c, { empfaenger: empfaengerListe(kreis), art: 'antrag_entschieden', daten: { verein: verein?.name ?? '', ergebnis: status } });
    return { ...vereinsSicht(neu), ...(mitgliedschaft ? { mitgliedschaft } : {}) };
  });
}

/** Zeitpunkt, an dem eine Frist nach `ab` abläuft; Monate kalendarisch. */
function ablauf(ab, { wert, einheit }) {
  if (einheit === 'tage') return new Date(ab.getTime() + wert * 86_400_000);
  const d = new Date(ab); d.setUTCMonth(d.getUTCMonth() + wert);
  return d;
}

/** Job: erinnert die Vereins-Admins einmal und lässt Anträge verfallen (fristFuer je Verein). */
export async function antragsfristen(ctx, db, { adminsVon }) {
  const fristen = new Map(); let erinnert = 0; let verfallen = 0;
  for (const { id, verein_id } of await daten.offeneAntraege(db)) {
    if (!fristen.has(verein_id)) {
      fristen.set(verein_id, {
        erinnerung: await fristFuer(ctx, db, { art: 'mitgliedschaftsantrag_erinnerung', verband_id: verein_id }),
        verfall: await fristFuer(ctx, db, { art: 'mitgliedschaftsantrag_verfall', verband_id: verein_id }),
      });
    }
    const f = fristen.get(verein_id);
    await inTransaktion(db, async (c) => {
      const a = await daten.antragSperren(c, id);
      if (a?.status !== 'offen') return;
      if (ablauf(a.erstellt_am, f.verfall) <= ctx.jetzt) {
        await daten.antragEntscheiden(c, { id, status: 'verfallen', personId: a.person_id, von: null, jetzt: ctx.jetzt });
        const verein = await vereinFuer(ctx, c, { id: verein_id });
        const person = a.person_id && await daten.personLesen(c, a.person_id);
        const ids = a.gestellt_von ? [a.gestellt_von] : (await adminsVon(c, verein_id)).map((x) => x.benutzer_id);
        const empfaenger = empfaengerListe([...ids, ...(person ? await betroffene(ctx, c, person) : [])]);
        await benachrichtigung.senden(ctx, c, { empfaenger, art: 'antrag_verfallen', daten: { verein: verein?.name ?? '' } });
        verfallen++;
      } else if (!a.erinnert_am && ablauf(a.erstellt_am, f.erinnerung) <= ctx.jetzt) {
        await daten.antragErinnert(c, { id, jetzt: ctx.jetzt });
        await benachrichtigung.senden(ctx, c, { empfaenger: await adminsVon(c, verein_id), art: 'antrag_erinnerung', daten: {} });
        erinnert++;
      }
    });
  }
  return { erinnert, verfallen };
}

// ---- Austritt (FR-8, E81, E99) ----
/** Verwaltet der Verein im eigenen Kontext seine Mitgliedschaften? Verbandsrollen und Feldfilter reichen nicht. */
async function verlangeVerein(ctx, db, verein_id, recht) {
  const ziel = await ladeZiel(ctx, db, { vereine: [verein_id] });
  const ohneFeldfilter = { ...ctx, rechte: { ...ctx.rechte, quellen: ctx.rechte.quellen.filter((q) => !q.filter?.[recht]?.felder) } };
  if (ctx.kontext?.art !== 'verein' || ctx.kontext.id !== verein_id || !darf(ohneFeldfilter, recht, ziel)) throw notFound();
}

/** Der Austritt wirkt ab dem Austrittstag: Vereinsrollen und Direktrechte des verknüpften Benutzers enden, die Zugehörigkeit als Mitglied bleibt. */
async function vollzieheAustritt(ctx, c, m, konten) {
  const neu = await daten.austrittVollziehen(c, { id: m.id, von: ctx.benutzer?.id ?? null });
  await daten.gruppenAustragen(c, { mitgliedId: m.id, jetzt: ctx.jetzt, von: ctx.benutzer?.id ?? null });
  const person = await daten.personLesen(c, m.person_id);
  const z = await konten.zuMitglied(c, { verein_id: m.verein_id, mitglied_id: m.id, benutzer_id: person.benutzer_id });
  // Eine offene Einladung darf die beendeten Rechte nicht wieder geben
  await konten.verbraucheEinladungen(c, { verein_id: m.verein_id, mitglied_id: m.id, benutzer_id: z?.benutzer_id, jetzt: ctx.jetzt });
  if (z) {
    await beendeDirektrechte(ctx, c, { benutzer_id: z.benutzer_id, verein_id: m.verein_id });
    if (z.rolle !== 'mitglied') await konten.aufMitgliedsrolle(c, z.id, ctx.benutzer?.id ?? null);
    await audit.schreiben(ctx, c, { aktion: 'recht_entzogen', objekt_art: 'vereinszugehoerigkeit', objekt_id: z.id, alt: { benutzer_id: z.benutzer_id, verein_id: m.verein_id, rolle: z.rolle }, neu: { rolle: 'mitglied' }, grund: 'Austritt' });
  }
  return neu;
}

const pruefeVersion = (m, version) => { if (m.change_seq !== version) throw fehler(412, 'Der Datensatz wurde inzwischen geändert', 'version_veraltet'); };

/** Heimatverein, Person und Historie bleiben. `austritt` null nimmt einen noch nicht wirksamen Austritt zurück. */
export const austrittSetzen = (ctx, db, { verein_id, mitglied_id, version, austritt, kuendigung_am, konten }) => inTransaktion(db, async (c) => {
  await verlangeVerein(ctx, c, verein_id, 'mitglieder:AENDERN');
  const m = await daten.mitgliedSperren(c, { id: mitglied_id, vereinId: verein_id });
  if (!m) throw notFound();
  pruefeVersion(m, version);
  if (m.status === 'ausgetreten') throw conflict('Die Mitgliedschaft ist schon beendet', 'status_unzulaessig');
  if (austritt && m.eintritt && austritt < m.eintritt) throw fehler(422, 'Der Austritt liegt vor dem Eintritt', 'austritt_ungueltig');
  if (austritt && kuendigung_am && kuendigung_am > austritt) throw fehler(422, 'Die Kündigung liegt nach dem Austritt', 'austritt_ungueltig');
  await daten.austrittImVereinSperren(c, verein_id);
  const z = await konten.zuMitglied(c, { verein_id, mitglied_id, benutzer_id: (await daten.personLesen(c, m.person_id)).benutzer_id });
  // Einem Admin nimmt der Austritt die Rolle: dafür reicht die Mitgliederverwaltung nicht
  if (z?.rolle === 'admin') await verlangeAuf(ctx, c, 'zugehoerigkeit:AENDERN', { vereine: [verein_id] });
  const neu = await daten.austrittSetzen(c, { id: m.id, austritt, kuendigung: austritt ? kuendigung_am ?? m.kuendigung_am : null, von: ctx.benutzer.id });
  if (!austritt || austritt > heute(ctx)) return neu;
  if (z?.rolle === 'admin' && z.status === 'freigegeben' && (await konten.adminsVon(c, verein_id)).length === 1) throw conflict('Der letzte Vereins-Admin kann nicht austreten; erst einen anderen einsetzen', 'letzter_admin');
  return vollzieheAustritt(ctx, c, m, konten);
});

/** Job: vollzieht Austritte, deren Tag erreicht ist, je Mitgliedschaft in eigener Transaktion. */
export async function austritteVollziehen(ctx, db, { konten }) {
  let vollzogen = 0;
  for (const { id, verein_id } of await daten.faelligeAustritte(db, heute(ctx))) {
    await inTransaktion(db, async (c) => {
      const m = await daten.mitgliedSperren(c, { id, vereinId: verein_id });
      if (!m || m.status === 'ausgetreten' || !m.austritt || m.austritt > heute(ctx)) return;
      await vollzieheAustritt(ctx, c, m, konten);
      vollzogen++;
    });
  }
  return { vollzogen };
}

// ---- Gruppen (FR-77) ----
// Nur im Kontext des eigenen Vereins; Rechte wie die Mitglieder. Schreiben begrenzt nur der Gruppen-Scope der App, nicht mitglieder:schreiben
async function verlangeGruppen(ctx, db, verein_id, schreiben) {
  if (!ctx.rechte.app_scopes.includes(schreiben ? 'gruppen:schreiben' : 'gruppen:lesen')) throw notFound();
  if (schreiben) return verlangeVerein({ ...ctx, rechte: { ...ctx.rechte, app_scopes: [...ctx.rechte.app_scopes, 'mitglieder:schreiben'] } }, db, verein_id, 'mitglieder:AENDERN');
  if (ctx.kontext?.art !== 'verein' || ctx.kontext.id !== verein_id) throw notFound();
  return verlangeAuf(ctx, db, 'mitglieder:LESEN', mitgliedsZiel(verein_id, 'aktiv'));
}
/** Datenfilter (z. B. nur Aktive) gelten je Mitglied. */
const mitgliedsZiel = (verein_id, status) => ({ vereine: [verein_id], person: { aktiv: status === 'aktiv', rang: null, lizenzen: [] } });
Object.assign(VERSTOSS, { gruppen_name_uq: [409, 'Eine Gruppe mit diesem Namen gibt es schon', 'name_vergeben'] });

export async function gruppenLesen(ctx, db, { verein_id }) {
  await verlangeGruppen(ctx, db, verein_id, false);
  return { gruppen: await daten.gruppenVon(db, verein_id) };
}
export async function gruppenMitgliederLesen(ctx, db, { verein_id, id }) {
  await verlangeGruppen(ctx, db, verein_id, false);
  if (!await daten.gruppeLesen(db, { id, vereinId: verein_id })) throw notFound();
  return { mitglieder: (await daten.gruppenMitglieder(db, { id, vereinId: verein_id })).filter((m) => darf(ctx, 'mitglieder:LESEN', mitgliedsZiel(verein_id, m.status))) };
}
export async function gruppeAnlegen(ctx, db, { verein_id, name, trainingszeiten = null, sortierung = 0 }) {
  await verlangeGruppen(ctx, db, verein_id, true);
  return schreibe(db, (c) => daten.gruppeAnlegen(c, { vereinId: verein_id, name: name.trim(), trainingszeiten, sortierung, von: ctx.benutzer.id }));
}
export async function gruppeAendern(ctx, db, { verein_id, id, version, aenderung }) {
  await verlangeGruppen(ctx, db, verein_id, true);
  return schreibe(db, async (c) => {
    const alt = await daten.gruppeSperren(c, { id, vereinId: verein_id });
    if (!alt) throw notFound();
    pruefeVersion(alt, version);
    const neu = { ...alt, ...aenderung };
    return daten.gruppeAendern(c, { ...neu, name: neu.name.trim(), von: ctx.benutzer.id });
  });
}
/** Löschhinweis statt Löschen, damit Apps es im Abgleich erfahren; die Zuordnungen enden mit. */
export async function gruppeLoeschen(ctx, db, { verein_id, id, version }) {
  await verlangeGruppen(ctx, db, verein_id, true);
  return schreibe(db, async (c) => {
    const alt = await daten.gruppeSperren(c, { id, vereinId: verein_id });
    if (!alt) throw notFound();
    pruefeVersion(alt, version);
    await daten.gruppeLeeren(c, { id, jetzt: ctx.jetzt, von: ctx.benutzer.id });
    await daten.gruppeLoeschen(c, { id, jetzt: ctx.jetzt, von: ctx.benutzer.id });
    return { id, geloescht: true };
  });
}
export async function mitgliedZuordnen(ctx, db, { verein_id, id, mitglied_id, zugeordnet }) {
  await verlangeGruppen(ctx, db, verein_id, true);
  return schreibe(db, async (c) => {
    // Reihenfolge Mitglied, Gruppe: Austritt und Löschen der Gruppe laufen nicht daneben vorbei
    const m = await daten.mitgliedSperren(c, { id: mitglied_id, vereinId: verein_id });
    if (!m || !await daten.gruppeSperren(c, { id, vereinId: verein_id })) throw notFound();
    if (zugeordnet && m.status === 'ausgetreten') throw conflict('Ausgetretene Mitglieder gehören keiner Gruppe an', 'status_unzulaessig');
    if (zugeordnet) await daten.gruppeEintragen(c, { id, vereinId: verein_id, mitgliedId: mitglied_id, von: ctx.benutzer.id });
    else if (!await daten.gruppeAustragen(c, { id, mitgliedId: mitglied_id, jetzt: ctx.jetzt, von: ctx.benutzer.id })) throw notFound();
    return { gruppe_id: id, mitglied_id, zugeordnet };
  });
}
