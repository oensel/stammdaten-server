import { inTransaktion } from '../../db.js';
import { conflict, fehler, notFound } from '../../errors.js';
import { landesverbandVon, vereinFuer } from '../organisation/dienst.js';
import { darfFelder, ladeZiel } from '../rechte/dienst.js';
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
