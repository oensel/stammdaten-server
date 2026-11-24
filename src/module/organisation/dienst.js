import { inTransaktion } from '../../db.js';
import { fehler, notFound } from '../../errors.js';
import * as audit from '../audit/dienst.js';
import * as benachrichtigung from '../benachrichtigung/dienst.js';
import { rollentraeger, verlange } from '../rechte/dienst.js';
import * as daten from './daten.js';

// DB-Invariante → fachlicher Fehler (AD-4)
const VERSTOSS = {
  verein_braucht_kreis: [422, 'Ein Verein braucht einen Kreis', 'verein_braucht_kreis'],
  ebenenfolge_verletzt: [422, 'Die Ebenenfolge DJB › Landesverband › Bezirk › Kreis › Verein ist nicht eingehalten', 'ebenenfolge_verletzt'],
  frist_ebene_unzulaessig: [422, 'Nur der DJB und Landesverbände setzen Fristen', 'frist_ebene_unzulaessig'],
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

/** FR-2: beide Landesverbände erfahren vom Wechsel; innerhalb eines Landesverbands niemand. */
async function meldeVerbandswechsel(ctx, c, verein, altLv) {
  const neuLv = await daten.landesverbandVon(c, verein.id);
  if (altLv?.id === neuLv?.id) return;
  const lvs = [altLv, neuLv].filter(Boolean);
  const empfaenger = await rollentraeger(ctx, c, { verband_ids: lvs.map((v) => v.id), rolle: 'lv_admin' });
  await benachrichtigung.senden(ctx, c, {
    empfaenger, art: 'verein_verbandswechsel', daten: { verein: verein.name, alt: altLv?.name ?? 'ohne Verband', neu: neuLv.name },
  });
}

export function vereinAendern(ctx, db, { id, version, aenderung }) {
  verlange(ctx, 'verbandsbaum:AENDERN');
  return schreibe(db, async (c) => {
    const alt = await daten.vereinSperren(c, id);
    pruefeVersion(alt, version);
    const altLv = await daten.landesverbandVon(c, id);
    const neu = await daten.vereinAendern(c, { ...alt, ...aenderung, id, geaendert_von: ctx.benutzer?.id });
    const wechsel = alt.verband_id !== neu.verband_id;
    await audit.schreiben(ctx, c, { aktion: wechsel ? 'verein_verbandswechsel' : 'verein_geaendert', objekt_art: 'verein', objekt_id: id, alt: ohneVersion(alt), neu: ohneVersion(neu) });
    if (wechsel) await meldeVerbandswechsel(ctx, c, neu, altLv);
    return neu;
  });
}

/** Liegt ein Verband oder Verein unter (oder gleich) einem Verband? */
export const liegtUnter = (_ctx, db, { nachfahr_id, vorfahr_id }) => daten.pfadVorhanden(db, vorfahr_id, nachfahr_id);

/** Einzige Fristauflösung (AD-11). `verband_id` darf auch ein Verein sein. Liefert { art, wert, einheit, quelle_verband_id }. */
export async function fristFuer(_ctx, db, { art, verband_id }) {
  const [frist] = await daten.fristenAufloesen(db, { art, verbandId: verband_id });
  if (!frist) throw new Error(`Unbekannte Fristart: ${art}`);
  return frist;
}

export async function fristenLesen(ctx, db, { verband_id }) {
  verlange(ctx, 'fristen:LESEN');
  if (!await daten.verbandLesen(db, verband_id)) throw notFound();
  return { fristen: await daten.fristenAufloesen(db, { art: null, verbandId: verband_id }) };
}

/** DJB setzt den Standard, ein Landesverband überschreibt für sein Gebiet. */
export function fristSetzen(ctx, db, { verband_id, art, wert }) {
  verlange(ctx, 'fristen:AENDERN', { verband_id });
  return schreibe(db, async (c) => {
    const ziel = await daten.verbandLesen(c, verband_id);
    if (!ziel) throw notFound();
    const standard = await daten.fristArtSperren(c, art);
    if (!standard) throw notFound();
    const verbandId = ziel.typ === 'dachverband' ? null : verband_id;
    const alt = await daten.fristLesen(c, art, verbandId);
    const { id, ...neu } = await daten.fristSetzen(c, { art, verbandId, wert, einheit: standard.einheit });
    await audit.schreiben(ctx, c, { aktion: 'frist_geaendert', objekt_art: 'frist', objekt_id: id, alt: alt && { art, verband_id, ...alt }, neu: { art, verband_id, ...neu } });
    return { art, ...neu, quelle_verband_id: verbandId };
  });
}
