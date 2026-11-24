import { verlangeTransaktion } from '../../db.js';
import { AKTIONEN } from './aktionen.js';
import * as daten from './daten.js';

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

/** Schreibt den Audit-Eintrag in der Transaktion des Aufrufers; Akteur, Rolle und Ebene kommen aus ctx. */
export async function schreiben(ctx, db, { aktion, objekt_art, objekt_id = null, alt, neu, grund = null }) {
  verlangeTransaktion(db, 'audit.schreiben');
  if (!AKTIONEN.includes(aktion)) throw new Error(`Unbekannte Audit-Aktion: ${aktion}`);
  if (!objekt_art) throw new Error('audit.schreiben: objekt_art fehlt');
  await daten.einfuegen(db, {
    zeitpunkt: ctx.jetzt, akteur: ctx.benutzer?.id ?? ctx.anwendung, benutzer_id: ctx.benutzer?.id ?? null, anwendung: ctx.anwendung,
    rolle: ctx.rechte.rolle ?? (ctx.rechte.verbandsrollen.map((r) => r.rolle).sort().join(',') || (ctx.rechte.super_admin ? 'super_admin' : null)), stellvertreter: ctx.rechte.stellvertreter,
    ebene_art: ctx.kontext?.art ?? null, ebene_id: ctx.kontext?.id ?? null,
    aktion, objekt_art, objekt_id, alt: json(alt), neu: json(neu), grund,
  });
}
