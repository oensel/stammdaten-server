import { notFound } from '../../errors.js';
import * as daten from './daten.js';
import { BASISRECHTE, KATALOG, kennt } from './katalog.js';

/** Aktive Verbandsrollen eines Benutzers; die Pipeline lädt sie einmal in ctx.rechte.verbandsrollen (ctx ist dann noch null). */
export const ladeVerbandsrollen = (_ctx, db, { benutzer_id }) => daten.verbandsrollen(db, benutzer_id);

/** Benutzer mit einer aktiven Verbandsrolle in einem der Verbände: [{ benutzer_id }]. */
export const rollentraeger = (_ctx, db, { verband_ids, rolle }) => daten.rollentraeger(db, { verbandIds: verband_ids, rolle });

/** Beendet alle direkt vergebenen Rechte eines Benutzers in einem Verein (Entzug oder Neuanfrage der Zugehörigkeit). */
export const beendeDirektrechte = (ctx, db, { benutzer_id, verein_id }) =>
  daten.direktrechteBeenden(db, { benutzerId: benutzer_id, vereinId: verein_id, von: ctx.benutzer?.id ?? null, jetzt: ctx.jetzt });

// Die App-Obergrenze (scopes) gilt wie unter /v1
const istVereinsAdmin = (ctx, { verein_id }) => ctx.rechte.super_admin
  || (ctx.kontext?.art === 'verein' && ctx.kontext.id === verein_id && ctx.rechte.rolle === 'admin' && ctx.rechte.scopes.includes('benutzer:verwalten'));

const istDjbAdmin = (ctx) => ctx.rechte.super_admin || ctx.rechte.verbandsrollen.some((r) => r.rolle === 'djb_admin');

const REGELN = {
  'verbandsbaum:AENDERN': istDjbAdmin,
  'zugehoerigkeit:LESEN': istVereinsAdmin,
  'zugehoerigkeit:AENDERN': istVereinsAdmin,
  // ziel = { verband_id }: DJB-Admins überall, LV-Admins im eigenen Landesverband
  'fristen:AENDERN': (ctx, { verband_id }) =>
    istDjbAdmin(ctx) || ctx.rechte.verbandsrollen.some((r) => r.rolle === 'lv_admin' && r.verband_id === verband_id),
};

/** Einzige Rechteentscheidung (AD-3). Ein unbekanntes Recht ist ein Programmierfehler. Ausbau in Epic 2. */
export function darf(ctx, recht, ziel) {
  if (!kennt(recht)) throw new Error(`Unbekanntes Recht: ${recht}`);
  if (ctx.benutzer !== null && BASISRECHTE.includes(recht)) return true;
  return Object.hasOwn(REGELN, recht) && REGELN[recht](ctx, ziel);
}

/** Wirft 404 (nie 403), wenn darf() nein sagt. */
export function verlange(ctx, recht, ziel) {
  if (!darf(ctx, recht, ziel)) throw notFound();
}

/** Katalog der Rechte mit Operationen und Systemrollen (Super-Admin, Verbandsrollen, Vereins-Admins). */
export async function katalogLesen(ctx, db) {
  if (!ctx.rechte.super_admin && !ctx.rechte.verbandsrollen.length && ctx.rechte.rolle !== 'admin') throw notFound();
  return { rechte: KATALOG, rollen: await daten.systemrollen(db) };
}
