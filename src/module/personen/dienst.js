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
    aendern: await ladeZiel(ctx, db, { ...basis, vereine: [person.heimatverein_id], eigen_kontakt: !ctx.rechte.unbestaetigt && ((selbst && mindestens(person, 14, tag)) || zugriff?.umfang === 'aendern') }),
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
  if (bestaetigt && z.selbst && mindestens(person, 18, heute(ctx))) return 'person';
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
  if (!person || ctx.rechte.geraet || !appSchreibt(ctx)) throw notFound();
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
  const eigen = eigenLesen && !ctx.rechte.unbestaetigt;
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
 * Schickt dem unbestätigten Konto den Link. Reihenfolge: eigene, vorher bestätigte Adresse; Adresse der Person, wenn sie nicht der
 * Vergebende gesetzt hat; bei Minderjährigen die Adressen der Erziehungsberechtigten. Die Adresse wird nicht verraten.
 */
export async function bestaetigungAnfordern(ctx, db, { konten }) {
  if (ctx.rechte.geraet) throw notFound();
  const benutzer_id = ctx.benutzer.id;
  const { an, token } = await inTransaktion(db, async (c) => {
    const person = await daten.personZuKonto(c, benutzer_id);
    const tag = heute(ctx);
    const eltern = person?.geburtsdatum && !mindestens(person, 18, tag) ? (await daten.zugriffeVon(c, person.id)).filter((x) => x.art === 'erziehungsberechtigt') : [];
    const a = await konten.adresse(ctx, c, { benutzer_id, eltern_ids: eltern.map((x) => x.benutzer_id) });
    if (!a) throw conflict('Das Konto ist schon bestätigt', 'schon_bestaetigt');
    const eigene = a.eigene ?? (person?.email && a.fremd_von && person.email_gesetzt_von !== a.fremd_von ? person.email : null);
    const ziel = eigene ? [eigene] : a.eltern;
    if (!ziel.length) throw conflict('Keine Adresse für die Bestätigung hinterlegt', 'adresse_fehlt');
    return { an: ziel, token: await konten.linkAnlegen(ctx, c, { benutzer_id }) };
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

async function abfrageStand(ctx, c, person) {
  const z = await mitZielen(ctx, c, person);
  if (verwaltetAls(ctx, person, z) !== 'person') throw notFound();
  const zugriffe = (await daten.zugriffeVon(c, person.id)).filter((x) => x.art !== 'vormund');
  const zuletzt = person.zugriffe_abgefragt_am;
  return { faellig: zugriffe.length > 0 && (!zuletzt || plusJahre(zuletzt, 1) <= heute(ctx)), zugriffe };
}

/** Jahresfrage der volljährigen Person; die Oberfläche fragt nach der Anmeldung. */
export const abfrageLesen = (ctx, db, { id }) => inTransaktion(db, async (c) => abfrageStand(ctx, c, await daten.personLesen(c, id)));

export const abfrageBeantworten = (ctx, db, { id, entscheidungen }) => inTransaktion(db, async (c) => {
  const person = await daten.personSperren(c, id);
  const { zugriffe } = await abfrageStand(ctx, c, person);
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
