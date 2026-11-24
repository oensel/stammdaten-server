import { notFound } from '../../errors.js';
import * as daten from './daten.js';

/** Aktive Verbandsrollen eines Benutzers; die Pipeline lädt sie einmal in ctx.rechte.verbandsrollen (ctx ist dann noch null). */
export const ladeVerbandsrollen = (_ctx, db, { benutzer_id }) => daten.verbandsrollen(db, benutzer_id);

/** Benutzer mit einer aktiven Verbandsrolle in einem der Verbände: [{ benutzer_id }]. */
export const rollentraeger = (_ctx, db, { verband_ids, rolle }) => daten.rollentraeger(db, { verbandIds: verband_ids, rolle });

const istDjbAdmin = (ctx) => ctx.rechte.super_admin || ctx.rechte.verbandsrollen.some((r) => r.rolle === 'djb_admin');

const REGELN = {
  'verbandsbaum:LESEN': (ctx) => ctx.benutzer !== null,
  'verbandsbaum:AENDERN': istDjbAdmin,
};

/** Einzige Rechteentscheidung (AD-3). Ein unbekanntes Recht ist ein Programmierfehler. Ausbau in Epic 2. */
export function darf(ctx, recht, ziel) {
  if (!Object.hasOwn(REGELN, recht)) throw new Error(`Unbekanntes Recht: ${recht}`);
  return REGELN[recht](ctx, ziel);
}

/** Wirft 404 (nie 403), wenn darf() nein sagt. */
export function verlange(ctx, recht, ziel) {
  if (!darf(ctx, recht, ziel)) throw notFound();
}
