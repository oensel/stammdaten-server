import { inTransaktion } from '../../db.js';
import { fehler, notFound } from '../../errors.js';
import * as audit from '../audit/dienst.js';
import * as daten from './daten.js';
import { darf, darfFelder, imKontext, listenbereich, projiziere } from './entscheidung.js';
import { BASISRECHTE, KATALOG } from './katalog.js';

export { darf, darfFelder, listenbereich, projiziere };

/** Aktive Verbandsrollen eines Benutzers; die Pipeline lädt sie einmal in ctx.rechte.verbandsrollen (ctx ist dann noch null). */
export const ladeVerbandsrollen = (_ctx, db, { benutzer_id }) => daten.verbandsrollen(db, benutzer_id);

/** Benutzer mit einer aktiven Verbandsrolle in einem der Verbände: [{ benutzer_id }]. */
export const rollentraeger = (_ctx, db, { verband_ids, rolle }) => daten.rollentraeger(db, { verbandIds: verband_ids, rolle });

/** Beendet alle direkt vergebenen Rechte eines Benutzers in einem Verein (Entzug oder Neuanfrage der Zugehörigkeit). */
export const beendeDirektrechte = (ctx, db, { benutzer_id, verein_id }) =>
  daten.direktrechteBeenden(db, { benutzerId: benutzer_id, vereinId: verein_id, von: ctx.benutzer?.id ?? null, jetzt: ctx.jetzt });

/** Quellen des aktiven Kontexts; die Pipeline lädt sie einmal in ctx.rechte.quellen. Das Ist-Recht `pruefer` wird Lizenz, keine Rolle. */
export async function ladeQuellen(_ctx, db, { kontext, rolle, rechte = [], verbandsrollen = [] }) {
  if (!kontext) return [];
  const art = kontext.art === 'verein' ? 'vereinsrolle' : 'verbandsrolle';
  const schluessel = art === 'vereinsrolle' ? [rolle, ...rechte.filter((r) => r !== 'pruefer')] : verbandsrollen.map((r) => r.rolle);
  // Stellvertreter haben die Rechte des Amts, aber kein DELEGIEREN
  const nurStv = new Set(verbandsrollen.filter((r) => r.stellvertreter_von).map((r) => r.rolle));
  for (const r of verbandsrollen) if (!r.stellvertreter_von) nurStv.delete(r.rolle);
  const ohneDelegieren = (r) => (nurStv.has(r.schluessel)
    ? { ...r, rechte: r.rechte.filter((x) => !x.endsWith(':DELEGIEREN')), filter: Object.fromEntries(Object.entries(r.filter).filter(([k]) => !k.endsWith(':DELEGIEREN'))) } : r);
  const rollen = (await daten.rollenMitRechten(db, [...new Set(schluessel)])).map(ohneDelegieren);
  const ebene = kontext.art === 'verband' ? EBENEN[await daten.ebene(db, kontext.id)] : undefined;
  const bereich = Object.freeze(ebene ? { ...kontext, ebene } : { ...kontext });
  return rollen
    .map((r) => imKontext({ art, schluessel: r.schluessel, rechte: r.rechte, bereich, filter: r.filter }, kontext))
    .filter(Boolean).map(Object.freeze);
}
const EBENEN = { 1: 'dachverband', 2: 'landesverband', 3: 'bezirk', 4: 'kreis' };

/** Ergänzt ein Ziel um die Verbände über seinen Vereinen und Verbänden (verband_pfade). */
export async function ladeZiel(_ctx, db, ziel) {
  const ids = [...(ziel.vereine ?? []), ...(ziel.verbaende ?? []), ...(ziel.heimatverein_id ? [ziel.heimatverein_id] : [])];
  return { ...ziel, vorfahren: await daten.vorfahren(db, ids) };
}

/** Wirft 404 (nie 403), wenn darf() nein sagt. */
export function verlange(ctx, recht, ziel) {
  if (!darf(ctx, recht, ziel)) throw notFound();
}

/** Schreiben bestimmter Felder: kein Zugriff → 404, Zugriff aber unerlaubtes Feld → 422. */
export function verlangeFelder(ctx, recht, art, namen, ziel) {
  verlange(ctx, recht, ziel);
  if (!darfFelder(ctx, recht, art, namen, ziel)) throw fehler(422, 'Mindestens ein Feld darf nicht geändert werden', 'feld_nicht_erlaubt');
}

/** Wie verlange(), lädt vorher die Verbände über dem Ziel. */
export const verlangeAuf = async (ctx, db, recht, ziel) => verlange(ctx, recht, await ladeZiel(ctx, db, ziel));

/** Katalog der Rechte mit Operationen und Systemrollen (Super-Admin, Verbandsrollen, Vereins-Admins). */
export async function katalogLesen(ctx, db) {
  if (!ctx.rechte.super_admin && !ctx.rechte.verbandsrollen.length && ctx.rechte.rolle !== 'admin') throw notFound();
  return { rechte: KATALOG, rollen: await daten.systemrollen(db) };
}

/** Wirksame Rollenschlüssel und Berechtigungen im aktiven Kontext (FR-16). */
export function wirksameBerechtigungen(ctx) {
  const { quellen } = ctx.rechte;
  return { rollen: quellen.map((q) => q.schluessel).sort(), berechtigungen: [...new Set([...BASISRECHTE, ...quellen.flatMap((q) => q.rechte)])].sort() };
}

// ---- Verbandsrollen und Stellvertreter (FR-21, Story 2.6) ----
const VERSTOSS = {
  verbandsrolle_benutzer_unbekannt: [404, 'Benutzer nicht gefunden', 'benutzer_unbekannt'],
  verbandsrolle_verband_unbekannt: [404, 'Verband nicht gefunden', 'nicht_gefunden'],
  verbandsrolle_ebene_unzulaessig: [422, 'Diese Rolle ist in diesem Verband nicht vergebbar', 'rolle_nicht_vergebbar'],
  stellvertretung_ungueltig: [422, 'Stellvertreter gibt es nur für ein aktives Amt', 'stellvertretung_ungueltig'],
  stellvertreter_ist_amtsinhaber: [422, 'Der Amtsinhaber kann nicht sein eigener Stellvertreter sein', 'selbsternennung'],
  stellvertreter_hoechstens_zwei: [409, 'Ein Amt hat höchstens zwei Stellvertreter', 'stellvertreter_limit'],
  benutzer_verbandsrollen_uq: [409, 'Der Benutzer hat diese Rolle in diesem Verband schon', 'rolle_vergeben'],
};
async function schreibe(db, fn) {
  try {
    return await inTransaktion(db, fn);
  } catch (e) {
    const v = Object.hasOwn(VERSTOSS, e.constraint ?? '') && VERSTOSS[e.constraint];
    throw v ? fehler(...v) : e;
  }
}
// LV-Admins und DJB-Admins setzt nur der DJB-Admin oder der Super-Admin ein und ab
const OBERE = ['lv_admin', 'djb_admin'];
const hoehereBerechtigung = (ctx) => ctx.rechte.super_admin || ctx.rechte.quellen.some((q) => q.art === 'verbandsrolle' && q.schluessel === 'djb_admin');
const verlangeRolle = (ctx, rolle) => {
  if (OBERE.includes(rolle) && !hoehereBerechtigung(ctx)) throw fehler(422, 'Diese Rolle setzt nur der DJB-Admin ein', 'rolle_nicht_vergebbar');
};

export async function verbandsrollenLesen(ctx, db, { verband_id }) {
  await verlangeAuf(ctx, db, 'verbandsrolle:LESEN', { verbaende: [verband_id] });
  return { rollen: await daten.rollenImVerband(db, verband_id) };
}

export async function verbandsrolleVergeben(ctx, db, { verband_id, benutzer_id, rolle, grund = null }) {
  await verlangeAuf(ctx, db, 'verbandsrolle:ANLEGEN', { verbaende: [verband_id] });
  verlangeRolle(ctx, rolle);
  return schreibe(db, async (c) => {
    const neu = await daten.rolleEinfuegen(c, { benutzerId: benutzer_id, verbandId: verband_id, rolle, von: ctx.benutzer.id, grund, jetzt: ctx.jetzt });
    await audit.schreiben(ctx, c, { aktion: 'recht_vergeben', objekt_art: 'verbandsrolle', objekt_id: neu.id, neu, grund });
    return neu;
  });
}

export async function verbandsrolleEntziehen(ctx, db, { verband_id, id, grund = null }) {
  await verlangeAuf(ctx, db, 'verbandsrolle:LOESCHEN', { verbaende: [verband_id] });
  return schreibe(db, async (c) => {
    const alt = await daten.rolleSperren(c, { id, verbandId: verband_id });
    if (!alt || alt.stellvertreter_von) throw notFound();
    verlangeRolle(ctx, alt.rolle);
    const stv = await daten.stellvertreterAktiv(c, id);
    const ende = await daten.rolleBeenden(c, { id, von: ctx.benutzer.id, grund, jetzt: ctx.jetzt });
    await audit.schreiben(ctx, c, { aktion: 'recht_entzogen', objekt_art: 'verbandsrolle', objekt_id: id, alt: ende, grund });
    for (const s of stv) await audit.schreiben(ctx, c, { aktion: 'stellvertreter_entzogen', objekt_art: 'verbandsrolle', objekt_id: s.id, alt: { benutzer_id: s.benutzer_id, amt: id }, grund: 'Amt beendet' });
    return ende;
  });
}

/** Amtsinhaber (nur im Verbandskontext, nicht als Stellvertreter) oder wer Verbandsrollen vergeben darf. */
async function verlangeAmtsverwaltung(ctx, db, verband_id, amtId) {
  const ziel = await ladeZiel(ctx, db, { verbaende: [verband_id] });
  if (darf(ctx, 'verbandsrolle:ANLEGEN', ziel)) return;
  const eigene = ctx.kontext?.art === 'verband' && ctx.kontext.id === verband_id ? ctx.rechte.verbandsrollen : [];
  if (eigene.some((r) => r.id === amtId && !r.stellvertreter_von)) return;
  if (eigene.some((r) => r.stellvertreter_von === amtId)) throw fehler(422, 'Stellvertreter dürfen keine Stellvertreter ernennen', 'stellvertreter_darf_nicht_ernennen');
  throw notFound();
}

export async function stellvertreterErnennen(ctx, db, { verband_id, id, benutzer_id, grund }) {
  await verlangeAmtsverwaltung(ctx, db, verband_id, id);
  if (benutzer_id === ctx.benutzer.id) throw fehler(422, 'Selbsternennung ist nicht möglich', 'selbsternennung');
  try {
    return await schreibe(db, async (c) => {
      const amt = await daten.rolleSperren(c, { id, verbandId: verband_id });
      if (!amt || amt.stellvertreter_von) throw notFound();
      const neu = await daten.rolleEinfuegen(c, { benutzerId: benutzer_id, verbandId: verband_id, rolle: amt.rolle, stellvertreterVon: id, von: ctx.benutzer.id, grund, jetzt: ctx.jetzt });
      await audit.schreiben(ctx, c, { aktion: 'stellvertreter_ernannt', objekt_art: 'verbandsrolle', objekt_id: neu.id, neu, grund });
      return neu;
    });
  } catch (e) {
    // Der abgewiesene Versuch ist in einer eigenen Transaktion auditiert, die erste hat ihn verworfen
    if (e.code === 'stellvertreter_limit') {
      await inTransaktion(db, (c) => audit.schreiben(ctx, c, { aktion: 'stellvertreter_abgewiesen', objekt_art: 'verbandsrolle', objekt_id: id, neu: { benutzer_id, grund: e.code }, grund }));
    }
    throw e;
  }
}

export async function stellvertreterEntziehen(ctx, db, { verband_id, id, stellvertreter_id, grund }) {
  await verlangeAmtsverwaltung(ctx, db, verband_id, id);
  return schreibe(db, async (c) => {
    const alt = await daten.rolleSperren(c, { id: stellvertreter_id, verbandId: verband_id });
    if (!alt || alt.stellvertreter_von !== id) throw notFound();
    const ende = await daten.rolleBeenden(c, { id: stellvertreter_id, von: ctx.benutzer.id, grund, jetzt: ctx.jetzt });
    await audit.schreiben(ctx, c, { aktion: 'stellvertreter_entzogen', objekt_art: 'verbandsrolle', objekt_id: stellvertreter_id, alt: ende, grund });
    return ende;
  });
}
