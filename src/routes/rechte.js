// Rechte (Funktionen wie trainer, pruefer) einem Benutzer im Verein des Tokens geben oder entziehen – nur Admins (Scope rechte:verwalten).
//   PUT    /benutzer/:id/rechte/:schluessel   { gueltig_von?, gueltig_bis?, attribute? }  idempotent, 200
//   DELETE /benutzer/:id/rechte/:schluessel   weich löschen, idempotent, 204
// Bestehende Anmeldungen bleiben gültig; Rechte stehen im nächsten Access-Token (Refresh liest sie neu, siehe auth.js ladeKontext).
import { tx } from '../db.js';
import { badRequest, fehler, forbidden } from '../errors.js';
import { pruefeBearer } from '../auth.js';

export default async function rechteRoutes(app) {
  const pool = app.pool;

  /** Admin-Prüfung + Ziel prüfen (freigegebene Zugehörigkeit im Verein des Tokens, kein Super-Admin, nicht man selbst) + Recht suchen. */
  async function vorbereiten(req) {
    const claims = await pruefeBearer(app, req);
    if (!(claims.scope || '').split(' ').includes('rechte:verwalten')) throw forbidden('Dafür fehlt die Berechtigung', 'scope_fehlt');
    if (!claims.verein_id) throw badRequest('Kein Vereinskontext im Token', 'verein_fehlt');
    const { id, schluessel } = req.params;
    if (id === claims.sub) throw forbidden('Das eigene Konto kann hier nicht geändert werden', 'konto_geschuetzt');
    const ziel = (await pool.query(
      `select b.ist_super_admin from benutzer b join benutzer_vereine bv on bv.benutzer_id = b.id
        where b.id = $1 and b.aktiv and b.geloescht_am is null and bv.verein_id = $2 and bv.status = 'freigegeben' and bv.geloescht_am is null`,
      [id, claims.verein_id])).rows[0];
    if (!ziel) throw fehler(404, 'Benutzer nicht im Verein', 'benutzer_unbekannt');
    if (ziel.ist_super_admin) throw forbidden('Super-Admin-Konten sind geschützt', 'konto_geschuetzt');
    const recht = (await pool.query('select id, schluessel from rechte where schluessel = $1', [schluessel])).rows[0];
    if (!recht) throw fehler(404, 'Dieses Recht gibt es nicht', 'recht_unbekannt');
    return { claims, recht, vereinId: claims.verein_id, benutzerId: id };
  }

  const params = { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, schluessel: { type: 'string', maxLength: 50 } } };

  app.put('/benutzer/:id/rechte/:schluessel', {
    schema: {
      params,
      body: {
        type: ['object', 'null'], additionalProperties: false,
        properties: {
          gueltig_von: { type: ['string', 'null'], format: 'date' }, gueltig_bis: { type: ['string', 'null'], format: 'date' },
          attribute: { type: 'object' },
        },
      },
    },
  }, async (req) => {
    const { claims, recht, vereinId, benutzerId } = await vorbereiten(req);
    const b = req.body || {};
    if (b.gueltig_von && b.gueltig_bis && b.gueltig_bis < b.gueltig_von) throw badRequest('gueltig_bis liegt vor gueltig_von', 'zeitraum_ungueltig');
    const r = await tx(pool, (db) => db.query(
      `insert into benutzer_rechte (benutzer_id, verein_id, recht_id, gueltig_von, gueltig_bis, attribute, vergeben_von, geaendert_von)
       values ($1,$2,$3,$4,$5,$6,$7,$7)
       on conflict (benutzer_id, verein_id, recht_id) do update
         set gueltig_von = excluded.gueltig_von, gueltig_bis = excluded.gueltig_bis, attribute = excluded.attribute,
             geloescht_am = null, geaendert_von = excluded.geaendert_von, geaendert_am = now()
       returning gueltig_von, gueltig_bis, attribute`,
      [benutzerId, vereinId, recht.id, b.gueltig_von ?? null, b.gueltig_bis ?? null, JSON.stringify(b.attribute ?? {}), claims.sub]));
    return { benutzer_id: benutzerId, verein_id: vereinId, recht: recht.schluessel, ...r.rows[0] };
  });

  app.delete('/benutzer/:id/rechte/:schluessel', { schema: { params } }, async (req, reply) => {
    const { claims, recht, vereinId, benutzerId } = await vorbereiten(req);
    await pool.query(
      `update benutzer_rechte set geloescht_am = now(), geaendert_am = now(), geaendert_von = $4
        where benutzer_id = $1 and verein_id = $2 and recht_id = $3 and geloescht_am is null`,
      [benutzerId, vereinId, recht.id, claims.sub]);
    return reply.code(204).send();
  });
}
