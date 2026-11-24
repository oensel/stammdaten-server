// Passwort vergessen, E-Mail bestätigen, Einladungen
//   POST /auth/passwort-vergessen      { kennung }                       immer 202 (verrät nicht, ob es das Konto gibt)
//   POST /auth/passwort-zuruecksetzen  { token, passwort_neu }
//   POST /auth/email-bestaetigen       { token }
//   POST /einladungen                  { email, rolle?, rechte?, mitglied_id? }   Admin (benutzer:verwalten)
//   POST /auth/einladung-annehmen      { token, benutzername?, passwort_neu?, passwort? }
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { pruefeBearer, widerrufeAlle } from '../auth.js';
import { erzeugeEinmalToken, liesEinmalToken, link, verbrauche } from '../einmal.js';
import { PW_MAX, hashSecret, pruefeNeuesPasswort, verifySecret } from '../passwords.js';

const UNGUELTIG = 'Link ungültig oder abgelaufen';
const tokenBody = { type: 'string', minLength: 10, maxLength: 200 };

export default async function einmalRoutes(app) {
  const { pool, cfg, mailer } = app;

  /* ---------- Passwort vergessen ---------- */
  app.post('/auth/passwort-vergessen', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['kennung'], properties: { kennung: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (req, reply) => {
    const u = (await pool.query(
      `select id, benutzername, email from benutzer
        where (lower(benutzername) = lower($1) or lower(email) = lower($1)) and aktiv and geloescht_am is null and email is not null
        order by (lower(benutzername) = lower($1)) desc limit 1`, [req.body.kennung.trim()])).rows[0];
    if (u) {
      // höchstens 3 Anforderungen pro Stunde und Konto (Mail-Flut); ältere offene Links werden entwertet
      const n = (await pool.query(
        `select count(*)::int n from einmal_tokens where benutzer_id = $1 and zweck = 'passwort_reset' and erstellt_am > now() - interval '1 hour'`, [u.id])).rows[0].n;
      if (n < 3) {
        await pool.query(`update einmal_tokens set benutzt_am = now() where benutzer_id = $1 and zweck = 'passwort_reset' and benutzt_am is null`, [u.id]);
        const t = await erzeugeEinmalToken(pool, { benutzerId: u.id, zweck: 'passwort_reset', stunden: cfg.resetStunden });
        await mailer.send({
          to: u.email, subject: 'Passwort zurücksetzen',
          text: `Hallo,\n\nfür das Konto „${u.benutzername}“ wurde ein neues Passwort angefordert. Der Link gilt ${cfg.resetStunden} Stunde(n):\n\n${link(cfg, 'passwort-zuruecksetzen', t)}\n\nWar das nicht dein Wunsch, ignoriere diese Mail – dein Passwort bleibt unverändert.`,
        });
      }
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/auth/passwort-zuruecksetzen', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['token', 'passwort_neu'], properties: { token: tokenBody, passwort_neu: { type: 'string', maxLength: PW_MAX } } } },
  }, async (req) => {
    const t = await liesEinmalToken(pool, req.body.token, 'passwort_reset');
    if (!t) throw unauthorized(UNGUELTIG, 'link_ungueltig');
    const u = (await pool.query('select id, benutzername from benutzer where id = $1 and aktiv and geloescht_am is null', [t.benutzer_id])).rows[0];
    if (!u) throw unauthorized(UNGUELTIG, 'link_ungueltig');
    pruefeNeuesPasswort(req.body.passwort_neu, u.benutzername); // vor dem Verbrauchen: Tippfehler kosten den Link nicht
    const hash = await hashSecret(req.body.passwort_neu);
    await tx(pool, async (db) => {
      if (!(await verbrauche(db, t.id))) throw unauthorized(UNGUELTIG, 'link_ungueltig');
      await db.query(
        `update benutzer set passwort_hash = $2, muss_passwort_aendern = false, fehlversuche = 0, pin_fehlversuche = 0, gesperrt_bis = null, pin_hash = null,
                email_bestaetigt_am = coalesce(email_bestaetigt_am, now()), passwort_geaendert_am = now(), geaendert_am = now() where id = $1`, [u.id, hash]);
      await widerrufeAlle(db, u.id);
    });
    return { ok: true };
  });

  /* ---------- E-Mail bestätigen ---------- */
  app.post('/auth/email-bestaetigen', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: tokenBody } } },
  }, async (req) => {
    const t = await liesEinmalToken(pool, req.body.token, 'email_bestaetigung');
    if (!t || !(await verbrauche(pool, t.id))) throw unauthorized(UNGUELTIG, 'link_ungueltig');
    await pool.query('update benutzer set email_bestaetigt_am = now() where id = $1', [t.benutzer_id]);
    return { ok: true };
  });

  /* ---------- Einladung ---------- */
  app.post('/einladungen', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['email'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 200 },
          rolle: { type: 'string', enum: ['admin', 'mitglied'] },
          rechte: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', maxLength: 40 } },
          mitglied_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (req, reply) => {
    const c = await pruefeBearer(app, req);
    const scopes = (c.scope || '').split(' ');
    if (!scopes.includes('benutzer:verwalten')) throw forbidden('Dafür fehlt die Berechtigung', 'scope_fehlt');
    if (!c.verein_id) throw badRequest('Kein Vereinskontext im Token', 'verein_fehlt');
    const { email, rolle = 'mitglied', rechte = [], mitglied_id: mitgliedId = null } = req.body;
    if (rechte.length && !scopes.includes('rechte:verwalten')) throw forbidden('Rechte vergeben ist nicht erlaubt', 'scope_fehlt');
    if (rechte.length) {
      const ok = (await pool.query('select count(*)::int n from rechte where schluessel = any($1)', [rechte])).rows[0].n;
      if (ok !== rechte.length) throw badRequest('Unbekanntes Recht', 'recht_unbekannt');
    }
    if (mitgliedId && !(await pool.query('select 1 from mitglieder where id = $1 and verein_id = $2 and geloescht_am is null', [mitgliedId, c.verein_id])).rows[0]) {
      throw notFound('Mitglied nicht gefunden');
    }
    const verein = (await pool.query('select name from vereine where id = $1', [c.verein_id])).rows[0];
    const token = await tx(pool, async (db) => {
      let u = (await db.query('select id from benutzer where lower(email) = lower($1) and geloescht_am is null', [email])).rows[0];
      if (!u) {
        // neues Konto ohne Passwort; Benutzername wählt die Person beim Annehmen
        u = (await db.query(
          `insert into benutzer (benutzername, email, geaendert_von) values ($1,$2,$3) returning id`, [`einladung-${randomUUID().slice(0, 8)}`, email, c.sub])).rows[0];
      }
      return erzeugeEinmalToken(db, { benutzerId: u.id, zweck: 'einladung', stunden: cfg.einladungTage * 24, vereinId: c.verein_id, rolle, rechte, mitgliedId, erstelltVon: c.sub });
    });
    await mailer.send({
      to: email, subject: `Einladung zu ${verein.name}`,
      text: `Hallo,\n\ndu wurdest zu „${verein.name}“ eingeladen. Der Link gilt ${cfg.einladungTage} Tage:\n\n${link(cfg, 'einladung', token)}\n`,
    });
    return reply.code(202).send({ ok: true });
  });

  app.post('/auth/einladung-annehmen', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['token'],
        properties: {
          token: tokenBody,
          benutzername: { type: 'string', minLength: 3, maxLength: 60, pattern: '^[A-Za-z0-9._-]+$' },
          passwort_neu: { type: 'string', maxLength: PW_MAX },
          passwort: { type: 'string', maxLength: PW_MAX },
        },
      },
    },
  }, async (req) => {
    const t = await liesEinmalToken(pool, req.body.token, 'einladung');
    if (!t) throw unauthorized(UNGUELTIG, 'link_ungueltig');
    const u = (await pool.query('select id, passwort_hash, email, email_bestaetigt_am from benutzer where id = $1 and aktiv and geloescht_am is null', [t.benutzer_id])).rows[0];
    if (!u) throw unauthorized(UNGUELTIG, 'link_ungueltig');
    // Das Konto führt die eingeladene Adresse, hat sie aber nie bewiesen: Es könnte jemand anderem gehören. Entweder weist sich die
    // Person mit dem Passwort dieses Kontos aus, oder sie legt ein eigenes an und die (per Link bewiesene) Adresse zieht dorthin um.
    let umzug = false;
    if (u.passwort_hash && !u.email_bestaetigt_am) {
      if (req.body.passwort) {
        if (!(await verifySecret(u.passwort_hash, req.body.passwort))) throw unauthorized('Passwort falsch', 'passwort_falsch');
      } else umzug = true;
    }
    const neu = !u.passwort_hash || umzug; // neues Konto → Benutzername + Passwort festlegen
    let hash = null;
    if (neu) {
      if (!req.body.benutzername || !req.body.passwort_neu) throw badRequest('benutzername und passwort_neu angeben', 'angaben_fehlen');
      pruefeNeuesPasswort(req.body.passwort_neu, req.body.benutzername);
      hash = await hashSecret(req.body.passwort_neu);
    }
    try {
      await tx(pool, async (db) => {
        // erst die Zugehörigkeit, dann den Link sperren: gleiche Reihenfolge wie beim Entzug (zugang), der offene Einladungen verbraucht
        await db.query('select 1 from benutzer_vereine where benutzer_id = $1 and verein_id = $2 for update', [u.id, t.verein_id]);
        if (!(await verbrauche(db, t.id))) throw unauthorized(UNGUELTIG, 'link_ungueltig');
        if (umzug) {
          // nur, wenn das alte Konto die Adresse noch unbestätigt führt
          const frei = await db.query('update benutzer set email = null where id = $1 and email = $2 and email_bestaetigt_am is null', [u.id, u.email]);
          if (!frei.rowCount) throw unauthorized(UNGUELTIG, 'link_ungueltig');
          u.id = (await db.query('insert into benutzer (benutzername, email) values ($1,$2) returning id', [`einladung-${randomUUID().slice(0, 8)}`, u.email])).rows[0].id;
        }
        if (neu) {
          await db.query(
            `update benutzer set benutzername = $2, passwort_hash = $3, email_bestaetigt_am = now(), passwort_geaendert_am = now(), geaendert_am = now() where id = $1`,
            [u.id, req.body.benutzername, hash]);
        } else {
          await db.query('update benutzer set email_bestaetigt_am = coalesce(email_bestaetigt_am, now()) where id = $1', [u.id]);
        }
        await db.query(
          `insert into benutzer_vereine (benutzer_id, verein_id, rolle, mitglied_id, status, angefragt_ueber, entschieden_von, entschieden_am, geaendert_von)
           values ($1,$2,$3,$4,'freigegeben','einladung',$5, now(), $5)
           on conflict (benutzer_id, verein_id) do update set status = 'freigegeben', rolle = excluded.rolle, geloescht_am = null,
             mitglied_id = coalesce(excluded.mitglied_id, benutzer_vereine.mitglied_id), entschieden_am = now()`,
          [u.id, t.verein_id, t.rolle || 'mitglied', t.mitglied_id, t.erstellt_von]);
        for (const r of t.rechte) {
          await db.query(
            `insert into benutzer_rechte (benutzer_id, verein_id, recht_id, vergeben_von) select $1, $2, id, $4 from rechte where schluessel = $3
             on conflict (benutzer_id, verein_id, recht_id) do update set geloescht_am = null`, [u.id, t.verein_id, r, t.erstellt_von]);
        }
      });
    } catch (e) {
      if (e.code === '23505') throw conflict(/mitglied/.test(e.constraint || '') ? 'Dieses Mitglied hat schon einen Zugang' : 'Benutzername schon vergeben', 'schon_vorhanden');
      throw e;
    }
    return { ok: true, neues_konto: neu };
  });
}
