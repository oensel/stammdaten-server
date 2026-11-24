// Vereinsgeräte (z. B. Hallen-Tablet): gehören dem Verein, mehrere Personen melden sich daran an (jede mit eigenem Geräte-Token).
//   POST /geraete          registrieren (Admin, Scope benutzer:verwalten) – Gerät gilt für die App im Token (aud)
//   GET /geraete           Liste des Vereins
//   PATCH /geraete/:id     { gesperrt } – Sperre beendet die Anmeldungen am Gerät beim nächsten Refresh
import { badRequest, forbidden, notFound } from '../errors.js';
import { pruefeBearer } from '../auth.js';

export default async function geraeteRoutes(app) {
  const pool = app.pool;
  const admin = async (req) => {
    const claims = await pruefeBearer(app, req);
    if (!(claims.scope || '').split(' ').includes('benutzer:verwalten')) throw forbidden('Dafür fehlt die Berechtigung', 'scope_fehlt');
    if (!claims.verein_id) throw badRequest('Kein Vereinskontext im Token', 'verein_fehlt');
    return claims;
  };

  app.post('/geraete', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, typ: { type: 'string', enum: ['tablet', 'phone', 'pc'] } },
      },
    },
  }, async (req, reply) => {
    const c = await admin(req);
    const r = (await pool.query(
      `insert into geraete (verein_id, anwendung_id, benutzer_id, name, typ)
       select $1, id, null, $2, $3 from anwendungen where schluessel = $4 returning id, name, typ`,
      [c.verein_id, req.body.name.trim(), req.body.typ || 'tablet', c.azp || c.aud])).rows[0];
    return reply.code(201).send(r);
  });

  app.get('/geraete', async (req) => {
    const c = await admin(req);
    return { daten: (await pool.query(
      `select g.id, g.name, g.typ, g.gesperrt, g.letzter_sync_am, g.benutzer_id is null as vereinsgeraet, a.schluessel as anwendung
         from geraete g join anwendungen a on a.id = g.anwendung_id where g.verein_id = $1 order by g.name`, [c.verein_id])).rows };
  });

  app.patch('/geraete/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['gesperrt'], properties: { gesperrt: { type: 'boolean' } } },
    },
  }, async (req) => {
    const c = await admin(req);
    const r = await pool.query('update geraete set gesperrt = $3 where id = $1 and verein_id = $2 returning id, gesperrt', [req.params.id, c.verein_id, req.body.gesperrt]);
    if (!r.rows[0]) throw notFound('Gerät nicht gefunden');
    return r.rows[0];
  });
}
