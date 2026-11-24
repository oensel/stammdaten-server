import { fehler, notFound } from '../../errors.js';
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
  const rollen = await daten.rollenMitRechten(db, schluessel);
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
