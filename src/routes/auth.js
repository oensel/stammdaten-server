// Anmeldung: POST /auth/login, /auth/pin, /auth/logout, /oauth/token (refresh_token)
import { tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from '../errors.js';
import { ladeAnwendung, ladeBenutzerFuerKontext, ladeKontext, ladeVerbandskontext, pruefeBearer, rotiere, stelleAus, widerrufeAlle, widerrufeFamilie } from '../auth.js';
import { PIN_RE, PW_MAX, sha256, verifyDummy, verifySecret } from '../passwords.js';
import { v2Fehler, zweiterFaktor } from '../pipeline/index.js';
import { signJwt, verifyJwt } from '../jwt.js';
import { randomUUID } from 'node:crypto';

const geraetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    typ: { type: 'string', enum: ['tablet', 'phone', 'pc'] },
    name: { type: 'string', maxLength: 100 },
  },
};
// Web-Clients (gleiche Domain): Refresh-Token als HttpOnly-Cookie statt im Body
const clientTyp = { type: 'string', enum: ['web', 'app'] };
const FALSCH = 'Benutzername oder Passwort falsch';

export default async function authRoutes(app) {
  const cfg = app.cfg;
  const pool = app.pool;

  const cookieAttr = (maxAge) => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cfg.cookieSecure ? '; Secure' : ''}`;
  const cookieLesen = (req) => {
    const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${cfg.cookieName}=`));
    return m ? decodeURIComponent(m.slice(cfg.cookieName.length + 1)) : null;
  };
  const cookieLoeschen = (reply) => reply.header('Set-Cookie', `${cfg.cookieName}=; ${cookieAttr(0)}`);
  /** Web: Refresh-Token nur im Cookie, nie im Body. */
  const ausliefern = (reply, out, web) => {
    if (!web) return out;
    const { refresh_token: rt, ...rest } = out;
    const tage = out.geraet_id ? cfg.geraetTokenTage : cfg.refreshTage;
    reply.header('Set-Cookie', `${cfg.cookieName}=${encodeURIComponent(rt)}; ${cookieAttr(tage * 86400)}`);
    return rest;
  };

  /** Konto per Benutzername oder E-Mail finden. */
  const sucheBenutzer = async (kennung) =>
    (await pool.query(
      `select id, benutzername, passwort_hash, pin_hash, ist_super_admin, totp_aktiv_am, totp_secret_verschluesselt, heimatverein_id, muss_passwort_aendern, fehlversuche, pin_fehlversuche, gesperrt_bis,
              gesperrt_bis > now() as gesperrt, ceil(extract(epoch from gesperrt_bis - now()) / 60)::int as min
         from benutzer
        where (lower(benutzername) = lower($1) or lower(email) = lower($1)) and aktiv and geloescht_am is null and anonymisiert_am is null
        order by (lower(benutzername) = lower($1)) desc limit 1`, [kennung.trim()])).rows[0];

  /** Fehlversuch zählen; nach maxFehlversuchen Sperre. Ein einziges UPDATE – auch bei parallelen Anfragen korrekt. */
  async function fehlversuch(u) {
    const r = await pool.query(
      `update benutzer set
         gesperrt_bis = case when fehlversuche + 1 >= $2 then now() + make_interval(mins => $3) else gesperrt_bis end,
         fehlversuche = case when fehlversuche + 1 >= $2 then 0 else fehlversuche + 1 end
       where id = $1 returning gesperrt_bis > now() as gesperrt`,
      [u.id, cfg.maxFehlversuche, cfg.sperreMinuten]);
    if (r.rows[0]?.gesperrt) throw tooMany(`Zu viele Fehlversuche – Zugang für ${cfg.sperreMinuten} Min. gesperrt`, { gesperrt_minuten: cfg.sperreMinuten });
    throw unauthorized(FALSCH, 'anmeldung_fehlgeschlagen');
  }

  /** Gerät registrieren bzw. wiederverwenden (gehört dem Benutzer; Vereinsgeräte legt ein Admin an – später). */
  async function geraetFuer(db, { benutzer, kontext, anwendung, geraet }) {
    if (!geraet) return null;
    if (!kontext.verein_id) throw badRequest('Geräte gibt es nur im Vereinskontext', 'geraet_ohne_verein');
    if (geraet.id) {
      const g = (await db.query(
        `select id, gesperrt from geraete where id = $1 and anwendung_id = $2 and verein_id = $3 and (benutzer_id = $4 or benutzer_id is null)`,
        [geraet.id, anwendung.id, kontext.verein_id, benutzer.id])).rows[0];
      if (g) {
        if (g.gesperrt) throw forbidden('Dieses Gerät ist gesperrt', 'geraet_gesperrt');
        return g.id;
      }
    }
    const typ = geraet.typ || 'pc';
    const name = (geraet.name || '').trim() || { pc: 'Browser', phone: 'Handy', tablet: 'Tablet' }[typ];
    return (await db.query(
      `insert into geraete (verein_id, anwendung_id, benutzer_id, name, typ) values ($1,$2,$3,$4,$5) returning id`,
      [kontext.verein_id, anwendung.id, benutzer.id, name, typ])).rows[0].id;
  }

  async function melde({ benutzer, vereinId, anwendung, geraet, geraetToken, web = false }) {
    return tx(pool, async (db) => {
      // SSO: Web-Anmeldung ohne Pflicht-Vereinswahl (die App wählt aus `vereine` im Token); Geräte bleiben an einen Verein gebunden
      const kontext = await ladeKontext(db, benutzer, vereinId, { ohneWahl: web && !geraet });
      const geraetId = await geraetFuer(db, { benutzer, kontext, anwendung, geraet });
      if (geraetToken && !geraetId) throw badRequest('geraet_token braucht ein Gerät', 'geraet_fehlt');
      await db.query(
        'update benutzer set fehlversuche = 0, pin_fehlversuche = 0, gesperrt_bis = null, letzte_anmeldung_am = now() where id = $1', [benutzer.id]);
      if (geraetId) await db.query('update geraete set letzter_sync_am = now() where id = $1', [geraetId]);
      return stelleAus(app, db, { benutzer, kontext, anwendung, geraetId, art: geraetToken ? 'geraet' : 'normal' });
    });
  }

  /* ---------- Zweiter Faktor des Super-Admins (Story 2.9, NFR-16) ---------- */
  const MFA_AUD = 'stammdaten-2fa';
  const einrichtungsToken = (u) => signJwt(
    { iss: cfg.issuer, aud: MFA_AUD, sub: u.id, exp: Math.floor(Date.now() / 1000) + 600 }, app.keys, 'mfa+jwt');

  const mfa = zweiterFaktor(pool, cfg);
  const zweitenFaktorPruefen = (u, eingabe) => mfa.pruefen(u.id, eingabe);

  const mfaBenutzer = async (token) => {
    const p = verifyJwt(token, app.keys, { aud: MFA_AUD, iss: cfg.issuer });
    const u = p && await mfa.benutzer(p.sub);
    if (!u?.ist_super_admin) throw unauthorized('Einrichtungs-Token ungültig oder abgelaufen', 'einrichtung_abgelaufen');
    if (u.gesperrt) throw tooMany('Zu viele Fehlversuche – bitte später erneut versuchen');
    return u;
  };

  app.post('/auth/2fa/einrichten', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['einrichtungs_token'], properties: { einrichtungs_token: { type: 'string', maxLength: 2000 } } } },
  }, async (req, reply) => {
    const u = await mfaBenutzer(req.body.einrichtungs_token);
    if (u.totp_aktiv_am) throw conflict('Der zweite Faktor ist schon eingerichtet', 'zweiter_faktor_vorhanden');
    reply.header('Cache-Control', 'no-store');
    return mfa.einrichten(u);
  });

  app.post('/auth/2fa/bestaetigen', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['einrichtungs_token', 'code'], properties: { einrichtungs_token: { type: 'string', maxLength: 2000 }, code: { type: 'string', maxLength: 10 } } } },
  }, async (req, reply) => {
    const u = await mfaBenutzer(req.body.einrichtungs_token);
    if (u.totp_aktiv_am) throw conflict('Der zweite Faktor ist schon eingerichtet', 'zweiter_faktor_vorhanden');
    const codes = await mfa.bestaetigen(u, req.body.code);
    if (!codes) return fehlversuch(u); // zählt wie ein falsches Passwort, sonst ließe sich der Code durchprobieren
    reply.header('Cache-Control', 'no-store');
    return { backup_codes: codes };
  });

  /* ---------- Login ---------- */
  app.post('/auth/login', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['benutzername', 'passwort', 'client_id'],
        properties: {
          benutzername: { type: 'string', minLength: 1, maxLength: 200 },
          passwort: { type: 'string', minLength: 1, maxLength: PW_MAX },
          client_id: { type: 'string', maxLength: 100 },
          verein_id: { type: 'string', format: 'uuid' },
          geraet: geraetSchema,
          geraet_token: { type: 'boolean' },
          client_typ: clientTyp,
          code: { type: 'string', minLength: 1, maxLength: 30 },
        },
      },
    },
  }, async (req, reply) => {
    const { benutzername, passwort, client_id: clientId, verein_id: vereinId, geraet, geraet_token: geraetToken } = req.body;
    const anwendung = await ladeAnwendung(pool, clientId);
    const u = await sucheBenutzer(benutzername);
    if (!u) { await verifyDummy(passwort); throw unauthorized(FALSCH, 'anmeldung_fehlgeschlagen'); }
    if (u.gesperrt) throw tooMany(`Zu viele Fehlversuche – bitte in ${u.min} Min. erneut versuchen`, { gesperrt_minuten: u.min });
    if (!(await verifySecret(u.passwort_hash, passwort))) return fehlversuch(u);
    if (cfg.zweiFaktorPflicht && u.ist_super_admin) {
      // Ohne eingerichteten zweiten Faktor gibt es keine Sitzung, nur den Weg zur Einrichtung
      if (!u.totp_aktiv_am) return { zweiter_faktor: 'einrichten', einrichtungs_token: einrichtungsToken(u) };
      if (!await zweitenFaktorPruefen(u, req.body.code)) return fehlversuch(u);
    }
    const web = req.body.client_typ === 'web';
    return ausliefern(reply, await melde({ benutzer: u, vereinId, anwendung, geraet, geraetToken, web }), web);
  });

  /* ---------- PIN-Anmeldung am registrierten Gerät (online) ---------- */
  app.post('/auth/pin', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['benutzername', 'pin', 'geraet_id', 'client_id'],
        properties: {
          benutzername: { type: 'string', minLength: 1, maxLength: 200 },
          pin: { type: 'string', maxLength: 12 },
          geraet_id: { type: 'string', format: 'uuid' },
          client_id: { type: 'string', maxLength: 100 },
          geraet_token: { type: 'boolean' },
          client_typ: clientTyp,
        },
      },
    },
  }, async (req, reply) => {
    const { benutzername, pin, geraet_id: geraetId, client_id: clientId, geraet_token: geraetToken } = req.body;
    const anwendung = await ladeAnwendung(pool, clientId);
    const u = await sucheBenutzer(benutzername);
    const g = u && (await pool.query(
      `select id, verein_id, gesperrt from geraete where id = $1 and anwendung_id = $2 and (benutzer_id = $3 or benutzer_id is null)`,
      [geraetId, anwendung.id, u.id])).rows[0];
    if (!u || !g || !u.pin_hash || g.gesperrt) { await verifyDummy(pin); throw unauthorized('PIN falsch oder nicht eingerichtet', 'pin_fehlgeschlagen'); }
    if (u.gesperrt) throw tooMany(`Zu viele Fehlversuche – bitte in ${u.min} Min. erneut versuchen`, { gesperrt_minuten: u.min });
    if (!PIN_RE.test(pin) || !(await verifySecret(u.pin_hash, pin))) {
      // PIN nach maxFehlversuchen entwerten → nur noch Passwort-Anmeldung
      const r = await pool.query(
        `update benutzer set pin_fehlversuche = case when pin_fehlversuche + 1 >= $2 then 0 else pin_fehlversuche + 1 end,
                pin_hash = case when pin_fehlversuche + 1 >= $2 then null else pin_hash end
          where id = $1 returning pin_hash is null as entwertet`, [u.id, cfg.maxFehlversuche]);
      if (r.rows[0]?.entwertet) throw tooMany('PIN entwertet – bitte mit Passwort anmelden', { pin_entwertet: true });
      throw unauthorized('PIN falsch oder nicht eingerichtet', 'pin_fehlgeschlagen');
    }
    return ausliefern(reply, await melde({ benutzer: u, vereinId: g.verein_id, anwendung, geraet: { id: geraetId }, geraetToken }), req.body.client_typ === 'web');
  });

  /**
   * Server-zu-Server (Abgleich): client_id + client_secret (Body oder HTTP Basic) → Token ohne Benutzer, ohne Refresh-Token.
   * scope = anwendungen.client_scopes, Claim `lizenz_arten` = erlaubte Lizenzarten (null = alle), `client: true`.
   */
  async function clientCredentials(req, reply) {
    let id = req.body.client_id; let secret = req.body.client_secret;
    const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
    if (basic) {
      const [i, ...rest] = Buffer.from(basic[1], 'base64').toString().split(':');
      id ||= decodeURIComponent(i); secret ||= decodeURIComponent(rest.join(':'));
    }
    if (!id || !secret) throw unauthorized('client_id und client_secret angeben', 'client_ungueltig');
    const a = (await pool.query('select schluessel, client_secret_hash, client_scopes, lizenz_arten from anwendungen where schluessel = $1 and aktiv', [id])).rows[0];
    if (!a?.client_secret_hash) { await verifyDummy(secret); throw unauthorized('Client-Anmeldung fehlgeschlagen', 'client_ungueltig'); }
    if (!(await verifySecret(a.client_secret_hash, secret))) throw unauthorized('Client-Anmeldung fehlgeschlagen', 'client_ungueltig');
    const jetzt = Math.floor(Date.now() / 1000);
    reply.header('Cache-Control', 'no-store');
    return {
      access_token: signJwt({
        iss: cfg.issuer, sub: `app:${a.schluessel}`, aud: a.schluessel, iat: jetzt, exp: jetzt + cfg.accessTtlSek, jti: randomUUID(),
        client: true, scope: a.client_scopes.join(' '), lizenz_arten: a.lizenz_arten,
      }, app.keys),
      token_type: 'Bearer', expires_in: cfg.accessTtlSek, scope: a.client_scopes.join(' '),
    };
  }

  /* ---------- Token-Endpunkt (grant_type=refresh_token | client_credentials) ---------- */
  app.post('/oauth/token', {
    schema: {
      querystring: { type: 'object', properties: { verein: { type: 'string', format: 'uuid' } } }, // SSO: aktiver Verein für die alten Claims
      body: {
        type: 'object', required: ['grant_type'],
        properties: {
          grant_type: { type: 'string' }, client_secret: { type: 'string', maxLength: 200 }, refresh_token: { type: 'string', maxLength: 200 }, client_id: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (req, reply) => {
    const { grant_type: grant, refresh_token: token, client_id: clientId } = req.body;
    if (grant === 'client_credentials') return clientCredentials(req, reply);
    if (grant !== 'refresh_token') {
      throw badRequest('Unterstützt: refresh_token, client_credentials (authorization_code folgt)', 'nicht_unterstuetzter_grant');
    }
    const cookie = !token ? cookieLesen(req) : null;
    if (!token && !cookie) throw badRequest('refresh_token fehlt');
    reply.header('Cache-Control', 'no-store');
    try {
      return ausliefern(reply, await rotiere(app, token || cookie, { clientId, vereinId: req.query.verein }), !!cookie);
    } catch (e) {
      if (cookie && e.status === 401) cookieLoeschen(reply);
      throw e;
    }
  });

  /* ---------- Vereinssicht wechseln (neue Anmeldung im anderen Verein, ohne Passwort) ---------- */
  app.post('/auth/verein-wechseln', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['verein_id'], properties: { verein_id: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => {
    const claims = await pruefeBearer(app, req);
    if (claims.geraet_id) throw badRequest('Geräte-Anmeldungen sind an einen Verein gebunden – am Gerät neu anmelden', 'geraet_gebunden');
    const anwendung = await ladeAnwendung(pool, claims.azp || claims.aud);
    const benutzer = (await pool.query(
      'select id, ist_super_admin, muss_passwort_aendern, heimatverein_id from benutzer where id = $1', [claims.sub])).rows[0];
    const web = !!cookieLesen(req);
    const out = await tx(pool, async (db) => {
      const kontext = await ladeKontext(db, benutzer, req.body.verein_id);
      const offen = await widerrufeFamilie(db, claims.sid);
      if (!offen.rowCount) throw unauthorized('Abgemeldet', 'abgemeldet');
      return stelleAus(app, db, { benutzer, kontext, anwendung, familieId: claims.sid }); // gleiche sid: Back-Channel-Logout erreicht alle Apps
    });
    reply.header('Cache-Control', 'no-store');
    return ausliefern(reply, out, web);
  });

  /* ---------- /v2: Kontext wechseln (Verein oder Verband, FR-15); liegt beim Altcode, weil es Tokens ausstellt ---------- */
  app.post('/v2/auth/kontext-wechseln', {
    errorHandler: v2Fehler,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['art', 'id'],
        properties: { art: { type: 'string', enum: ['verein', 'verband'] }, id: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (req, reply) => {
    const claims = await pruefeBearer(app, req);
    if (claims.geraet_id) throw badRequest('Geräte-Anmeldungen sind an einen Verein gebunden – am Gerät neu anmelden', 'geraet_gebunden');
    const anwendung = await ladeAnwendung(pool, claims.azp);
    const benutzer = await ladeBenutzerFuerKontext(pool, claims.sub);
    const { art } = req.body; const id = req.body.id.toLowerCase();
    const web = !!cookieLesen(req);
    const out = await tx(pool, async (db) => {
      let kontext;
      if (art === 'verband') kontext = await ladeVerbandskontext(db, benutzer, id);
      else {
        kontext = await ladeKontext(db, benutzer, id).catch((e) => {
          if (e.status === 403) return null;
          throw e;
        });
      }
      if (!kontext) throw notFound();
      // Nur eine noch offene Sitzung darf wechseln: ein abgemeldetes Token eröffnet keine neue
      const offen = await widerrufeFamilie(db, claims.sid);
      if (!offen.rowCount) throw unauthorized('Abgemeldet', 'abgemeldet');
      return stelleAus(app, db, { benutzer, kontext, anwendung, familieId: claims.sid }); // gleiche sid: Back-Channel-Logout erreicht alle Apps
    });
    reply.header('Cache-Control', 'no-store');
    return ausliefern(reply, out, web);
  });

  /* ---------- Logout: beendet die ganze Anmeldesitzung (alle Apps) und löst den Back-Channel-Logout aus ---------- */
  app.post('/auth/logout', {
    schema: {
      body: {
        type: ['object', 'null'], additionalProperties: false,
        properties: { refresh_token: { type: 'string', maxLength: 200 }, alle_geraete: { type: 'boolean' } },
      },
    },
  }, async (req, reply) => {
    const { alle_geraete: alle } = req.body || {};
    const token = req.body?.refresh_token || cookieLesen(req);
    cookieLoeschen(reply);
    if (alle) {
      const claims = await pruefeBearer(app, req, { erlaubeMussPasswort: true });
      app.sitzungBeendet(claims.sub, await widerrufeAlle(pool, claims.sub));
    } else if (token) {
      const rt = (await pool.query('select familie_id, benutzer_id, art from refresh_tokens where token_hash = $1', [sha256(token)])).rows[0];
      if (rt) {
        await widerrufeFamilie(pool, rt.familie_id);
        if (rt.art !== 'geraet') app.sitzungBeendet(rt.benutzer_id, [rt.familie_id]);
      }
    } else {
      throw badRequest('refresh_token oder alle_geraete angeben');
    }
    return reply.code(204).send();
  });
}
