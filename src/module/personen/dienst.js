import { inTransaktion } from '../../db.js';
import { badRequest, conflict, fehler, notFound } from '../../errors.js';
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

/**
 * Ziele für darf(): Lesen dürfen alle Vereine der Person (ausgetreten zählt nur beim Heimatverein), ändern nur der Heimatverein.
 * `rang` bleibt leer, bis das Modul graduierung liefert (Epic 6): Rollen mit Gradfilter sehen hier vorerst niemanden.
 */
async function zieleFuer(ctx, db, person) {
  const ms = await daten.mitgliedschaften(db, person.id);
  const selbst = person.benutzer_id === ctx.benutzer.id;
  const vereine = [...new Set([person.heimatverein_id, ...ms.filter((m) => m.status !== 'ausgetreten').map((m) => m.verein_id)])];
  const basis = { heimatverein_id: person.heimatverein_id, person: { aktiv: ms.some((m) => m.status === 'aktiv'), rang: null, lizenzen: [] } };
  return {
    ms, selbst,
    lesen: await ladeZiel(ctx, db, { ...basis, vereine, eigen: selbst }),
    aendern: await ladeZiel(ctx, db, { ...basis, vereine: [person.heimatverein_id], eigen_kontakt: selbst && mindestens(person, 14, heute(ctx)) }),
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
