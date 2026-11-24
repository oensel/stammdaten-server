// Zugänge verwalten: Trainer (Scope benutzer:schueler) legen Schüler-Zugänge an und setzen Passwörter zurück; Admins (benutzer:verwalten) dürfen das ebenfalls.
//   POST /benutzer                                  Zugang anlegen (Startpasswort, Wechselpflicht)
//   POST /benutzer/:id/passwort-zuruecksetzen       neues Startpasswort (Kinder ohne E-Mail)
import { tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { auditiere, hatVerbandsrolle, pruefeBearer, widerrufeAlle } from '../auth.js';
import { hashSecret, startpasswort } from '../passwords.js';

export default async function benutzerRoutes(app) {
  const pool = app.pool;

  async function berechtigt(req) {
    const claims = await pruefeBearer(app, req);
    const scopes = claims.scope ? claims.scope.split(' ') : [];
    const admin = scopes.includes('benutzer:verwalten');
    if (!admin && !scopes.includes('benutzer:schueler')) throw forbidden('Dafür fehlt die Berechtigung', 'scope_fehlt');
    if (!claims.verein_id) throw badRequest('Kein Vereinskontext im Token', 'verein_fehlt');
    return { claims, admin };
  }

  app.post('/benutzer', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['benutzername'],
        properties: {
          benutzername: { type: 'string', minLength: 3, maxLength: 60, pattern: '^[A-Za-z0-9._-]+$' },
          vorname: { type: 'string', maxLength: 100 },
          nachname: { type: 'string', maxLength: 100 },
          email: { type: 'string', maxLength: 200, format: 'email' },
          mitglied_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (req, reply) => {
    const { claims } = await berechtigt(req);
    const b = req.body;
    const start = startpasswort();
    const hash = await hashSecret(start);
    try {
      const id = await tx(pool, async (db) => {
        if (b.mitglied_id) {
          const m = (await db.query('select 1 from mitglieder where id = $1 and verein_id = $2 and geloescht_am is null', [b.mitglied_id, claims.verein_id])).rows[0];
          if (!m) throw notFound('Mitglied nicht gefunden');
        }
        const u = (await db.query(
          `insert into benutzer (benutzername, email, vorname, nachname, passwort_hash, muss_passwort_aendern, geaendert_von)
           values ($1,$2,$3,$4,$5,true,$6) returning id`,
          [b.benutzername, b.email || null, b.vorname || null, b.nachname || null, hash, claims.sub])).rows[0].id;
        await db.query(
          `insert into benutzer_vereine (benutzer_id, verein_id, rolle, mitglied_id, status, angefragt_ueber, entschieden_von, entschieden_am, geaendert_von)
           values ($1,$2,'mitglied',$3,'freigegeben','verwaltung',$4, now(), $4)`, [u, claims.verein_id, b.mitglied_id || null, claims.sub]);
        await auditiere(db, claims, { aktion: 'recht_vergeben', objekt_art: 'vereinszugehoerigkeit', objekt_id: u, neu: { benutzer_id: u, verein_id: claims.verein_id, rolle: 'mitglied', status: 'freigegeben' } });
        return u;
      });
      return reply.code(201).send({ id, benutzername: b.benutzername, startpasswort: start, muss_passwort_aendern: true });
    } catch (e) {
      if (e.code === '23505') {
        throw conflict(/mitglied/.test(e.constraint || '') ? 'Dieses Mitglied hat schon einen Zugang' : 'Benutzername oder E-Mail schon vergeben', 'schon_vorhanden');
      }
      throw e;
    }
  });

  app.post('/benutzer/:id/passwort-zuruecksetzen', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req) => {
    const { claims, admin } = await berechtigt(req);
    const ziel = (await pool.query(
      `select b.id, b.ist_super_admin,
              (select count(*) from benutzer_vereine x where x.benutzer_id = b.id and x.geloescht_am is null)::int as vereine,
              bv.rolle,
              (select count(*) from benutzer_wirksame_rechte w where w.benutzer_id = b.id)::int as rechte
         from benutzer b join benutzer_vereine bv on bv.benutzer_id = b.id and bv.verein_id = $2 and bv.geloescht_am is null
        where b.id = $1 and b.aktiv and b.geloescht_am is null`, [req.params.id, claims.verein_id])).rows[0];
    if (!ziel) throw notFound('Benutzer nicht gefunden'); // auch: anderer Verein
    // Nie Konten übernehmbar machen, die mehr sind als ein reiner Vereinszugang: Super-Admins, Konten in mehreren Vereinen oder mit Verbandsrolle
    if (ziel.ist_super_admin || ziel.vereine !== 1 || await hatVerbandsrolle(pool, ziel.id)) throw forbidden('Dieses Konto darf nicht zurückgesetzt werden', 'konto_geschuetzt');
    // Trainer: nur reine Schüler-Zugänge (Rolle Mitglied, keine Rechte)
    if (!admin && (ziel.rolle !== 'mitglied' || ziel.rechte > 0)) throw forbidden('Trainer dürfen nur Schüler-Zugänge zurücksetzen', 'konto_geschuetzt');
    if (ziel.id === claims.sub) throw forbidden('Das eigene Passwort bitte unter „Mein Konto“ ändern', 'eigenes_konto');
    const start = startpasswort();
    await tx(pool, async (db) => {
      await db.query(
        `update benutzer set passwort_hash = $2, muss_passwort_aendern = true, pin_hash = null, fehlversuche = 0, pin_fehlversuche = 0, gesperrt_bis = null,
                geaendert_am = now(), geaendert_von = $3 where id = $1`, [ziel.id, await hashSecret(start), claims.sub]);
      await widerrufeAlle(db, ziel.id);
    });
    return { id: ziel.id, startpasswort: start, muss_passwort_aendern: true };
  });
}
