import { inTransaktion } from '../../db.js';
import { fehler, notFound } from '../../errors.js';
import * as audit from '../audit/dienst.js';
import { verlange } from '../rechte/dienst.js';
import * as daten from './daten.js';

// DB-Invariante → fachlicher Fehler (AD-4)
const VERSTOSS = {
  verein_braucht_kreis: [422, 'Ein Verein braucht einen Kreis', 'verein_braucht_kreis'],
  ebenenfolge_verletzt: [422, 'Die Ebenenfolge DJB › Landesverband › Bezirk › Kreis › Verein ist nicht eingehalten', 'ebenenfolge_verletzt'],
  verbaende_ein_dachverband_uq: [409, 'Es gibt schon einen Dachverband', 'dachverband_vorhanden'],
  verbaende_name_uq: [409, 'Der Name ist schon vergeben', 'name_vergeben'],
  vereine_name_uq: [409, 'Der Name ist schon vergeben', 'name_vergeben'],
};

/** Transaktion, in der Verstöße gegen DB-Invarianten als fachliche Fehler ankommen. */
async function schreibe(db, fn) {
  try {
    return await inTransaktion(db, fn);
  } catch (e) {
    const v = Object.hasOwn(VERSTOSS, e.constraint ?? '') && VERSTOSS[e.constraint];
    throw v ? fehler(...v) : e;
  }
}

const pruefeVersion = (zeile, version) => {
  if (!zeile) throw notFound();
  if (zeile.change_seq !== version) throw fehler(412, 'Der Datensatz wurde inzwischen geändert', 'version_veraltet');
};
const ohneVersion = ({ change_seq: _weg, ...rest }) => rest;

export async function baumLesen(ctx, db) {
  verlange(ctx, 'verbandsbaum:LESEN');
  return { verbaende: await daten.alleVerbaende(db), vereine: await daten.alleVereine(db) };
}

export function verbandAnlegen(ctx, db, { name, kurzname = null, typ, uebergeordnet_id = null }) {
  verlange(ctx, 'verbandsbaum:AENDERN');
  return schreibe(db, async (c) => {
    const neu = await daten.verbandAnlegen(c, { name, kurzname, typ, uebergeordnet_id, geaendert_von: ctx.benutzer?.id });
    await audit.schreiben(ctx, c, { aktion: 'verband_angelegt', objekt_art: 'verband', objekt_id: neu.id, neu: ohneVersion(neu) });
    return neu;
  });
}

export function verbandAendern(ctx, db, { id, version, aenderung }) {
  verlange(ctx, 'verbandsbaum:AENDERN');
  return schreibe(db, async (c) => {
    const alt = await daten.verbandSperren(c, id);
    pruefeVersion(alt, version);
    const neu = await daten.verbandAendern(c, { ...alt, ...aenderung, id, geaendert_von: ctx.benutzer?.id });
    await audit.schreiben(ctx, c, { aktion: 'verband_geaendert', objekt_art: 'verband', objekt_id: id, alt: ohneVersion(alt), neu: ohneVersion(neu) });
    return neu;
  });
}

export function vereinAnlegen(ctx, db, { name, kurzname = null, vereinsnummer = null, ort = null, verband_id = null }) {
  verlange(ctx, 'verbandsbaum:AENDERN');
  return schreibe(db, async (c) => {
    const neu = await daten.vereinAnlegen(c, { name, kurzname, vereinsnummer, ort, verband_id, geaendert_von: ctx.benutzer?.id });
    await audit.schreiben(ctx, c, { aktion: 'verein_angelegt', objekt_art: 'verein', objekt_id: neu.id, neu: ohneVersion(neu) });
    return neu;
  });
}

export function vereinAendern(ctx, db, { id, version, aenderung }) {
  verlange(ctx, 'verbandsbaum:AENDERN');
  return schreibe(db, async (c) => {
    const alt = await daten.vereinSperren(c, id);
    pruefeVersion(alt, version);
    const neu = await daten.vereinAendern(c, { ...alt, ...aenderung, id, geaendert_von: ctx.benutzer?.id });
    await audit.schreiben(ctx, c, { aktion: 'verein_geaendert', objekt_art: 'verein', objekt_id: id, alt: ohneVersion(alt), neu: ohneVersion(neu) });
    return neu;
  });
}

/** Liegt ein Verband oder Verein unter (oder gleich) einem Verband? */
export const liegtUnter = (ctx, db, { nachfahr_id, vorfahr_id }) => daten.pfadVorhanden(db, vorfahr_id, nachfahr_id);
