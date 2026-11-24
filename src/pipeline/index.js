// Anfrage-Pipeline für /v2 (AD-2, AD-9): Token → Kontext → ctx → genau ein Dienst; Fehler als Problem-JSON.
import { ladeAnwendung, ladeBenutzerFuerKontext, ladeKontext, ladeVerbandskontext, pruefeBearer } from '../auth.js';
import { badRequest, errorHandler, fehler, notFound } from '../errors.js';
import { wirksameScopes } from '../scopes.js';
import { ladeQuellen, ladeVerbandsrollen } from '../module/rechte/dienst.js';
import { baueCtx, systemCtx } from './ctx.js';
import { entschluessele, verschluessele } from '../keys.js';
import * as zugang from '../module/zugang/dienst.js';

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CODE = {
  400: 'ungueltige_anfrage', 401: 'nicht_angemeldet', 403: 'verboten', 404: 'nicht_gefunden', 409: 'konflikt',
  413: 'anfrage_zu_gross', 415: 'medientyp_nicht_unterstuetzt', 428: 'if_match_fehlt', 429: 'zu_viele_versuche',
};

/** Wie errorHandler, garantiert aber einen stabilen snake_case-`code` (nie Fastify-/PostgreSQL-Codes). */
export function v2Fehler(err, req, reply) {
  const status = err.validation ? 400 : err.status || err.statusCode || 500;
  if (status < 500 && !/^[a-z][a-z0-9_]*$/.test(err.code || '')) err.code = CODE[status] || 'fehler';
  return errorHandler(err, req, reply);
}

async function ladeCtx(app, req) {
  const jetzt = app.cfg.uhr();
  const claims = await pruefeBearer(app, req);
  const gewaehlt = req.headers['x-verein']?.toLowerCase();
  if (gewaehlt !== undefined && !UUID.test(gewaehlt)) throw badRequest('X-Verein ist keine gültige ID');
  // Geräte-Tokens sind an ihren Verein gebunden
  if (claims.geraet_id && gewaehlt && gewaehlt !== claims.verein_id) throw notFound();
  const anwendung = await ladeAnwendung(app.pool, claims.azp);
  const benutzer = await ladeBenutzerFuerKontext(app.pool, claims.sub);
  // Geräte-Tokens (PIN am Tablet) tragen keine Verbands- und Super-Admin-Rechte
  if (claims.geraet_id) benutzer.ist_super_admin = false;
  const alleVerbandsrollen = claims.geraet_id ? [] : await ladeVerbandsrollen(null, app.pool, { benutzer_id: benutzer.id });
  const app_scopes = anwendung.scopes;
  const basis = { benutzer: Object.freeze({ id: benutzer.id }), anwendung: anwendung.schluessel, jetzt };
  const vereinId = gewaehlt || claims.verein_id;
  // FR-15: genau ein Kontext. Verbandsrollen wirken nur im Kontext ihres Verbands, Vereinsrechte nur im Verein.
  if (!gewaehlt && claims.kontext?.art === 'verband') {
    const verbandsrollen = alleVerbandsrollen.filter((r) => r.verband_id === claims.kontext.id);
    // frisch geprüft: Rolle und Zugehörigkeit zu einem Verein (FR-14)
    if (!verbandsrollen.length || !await ladeVerbandskontext(app.pool, benutzer, claims.kontext.id)) throw notFound();
    const kontext = Object.freeze({ art: 'verband', id: claims.kontext.id });
    const quellen = await ladeQuellen(null, app.pool, { kontext, benutzerId: benutzer.id, jetzt, verbandsrollen });
    return baueCtx({ ...basis, kontext, rechte: {
      app_scopes, quellen, verbandsrollen, stellvertreter: verbandsrollen.some((r) => r.stellvertreter_von), super_admin: benutzer.ist_super_admin,
      scopes: benutzer.ist_super_admin ? wirksameScopes({ superAdmin: true }, anwendung.scopes) : [],
    } });
  }
  if (!vereinId) {
    const superAdmin = benutzer.ist_super_admin;
    return baueCtx({ ...basis, rechte: { app_scopes, super_admin: superAdmin, scopes: superAdmin ? wirksameScopes({ superAdmin }, anwendung.scopes) : [] } });
  }
  let k;
  try {
    k = await ladeKontext(app.pool, benutzer, vereinId);
  } catch (e) {
    if (e.status === 403) throw notFound();
    throw e;
  }
  const kontext = Object.freeze({ art: 'verein', id: k.verein_id });
  return baueCtx({
    ...basis, kontext,
    rechte: {
      app_scopes,
      quellen: await ladeQuellen(null, app.pool, { kontext, benutzerId: benutzer.id, jetzt, rolle: k.rolle, rechte: k.rechte }),
      rolle: k.rolle, rechte: k.rechte, super_admin: k.super_admin,
      scopes: wirksameScopes({ rolle: k.rolle, rechte: k.rechte, superAdmin: k.super_admin }, anwendung.scopes),
    },
  });
}

const IF_MATCH = /^"(\d{1,19})"$/;
function leseIfMatch(req) {
  const wert = req.headers['if-match'];
  if (wert === undefined) throw fehler(428, 'If-Match fehlt', 'if_match_fehlt');
  const m = IF_MATCH.exec(wert);
  if (!m) throw badRequest('If-Match ist ungültig');
  return m[1];
}

/**
 * Registriert /v2-Routen: `registriereV2(app, (v2) => v2({ method, url, schema, status, ifMatch, handler }))`.
 * `handler(ctx, db, { params, query, body, version })` ruft genau einen Dienst auf; `db` ist der Pool.
 * `oeffentlich`: ohne Anmeldung, ctx ist dann system:oeffentlich ohne Rechte. Mit `ifMatch` ist der Header Pflicht (428), `version` ist dann die change_seq daraus. Ein Ergebnis mit change_seq bekommt ein ETag.
 */
export async function registriereV2(app, definiere) {
  await app.register(async (scope) => {
    scope.setErrorHandler(v2Fehler);
    scope.setNotFoundHandler((req, reply) => v2Fehler(notFound(), req, reply));
    scope.decorateRequest('ctx', null);
    // Anmeldung vor Körper und Schema: Unangemeldete erfahren nichts über die Route
    scope.addHook('onRequest', async (req) => { 
      if (req.is404) return;
      req.ctx = req.routeOptions.config.oeffentlich ? systemCtx('oeffentlich', { jetzt: app.cfg.uhr() }) : await ladeCtx(app, req);
    });
    // Review 24: IDs sind kleingeschrieben, Großbuchstaben in einer UUID sind dieselbe ID (sonst 404 bzw. Vergleich verfehlt)
    scope.addHook('preValidation', async (req) => {
      for (const teil of [req.params, req.query, req.body]) {
        if (teil && typeof teil === 'object') for (const [k, v] of Object.entries(teil)) if (typeof v === 'string' && UUID.test(v)) teil[k] = v.toLowerCase();
      }
    });
    definiere(({ method, url, schema, status = 200, ifMatch = false, oeffentlich = false, handler }) => scope.route({
      method, url, schema, config: { oeffentlich },
      handler: async (req, reply) => {
        const ergebnis = await handler(req.ctx, app.pool, { params: req.params, query: req.query, body: req.body, cfg: app.cfg, ...(ifMatch ? { version: leseIfMatch(req) } : {}) });
        if (ergebnis?.change_seq) reply.header('ETag', `"${ergebnis.change_seq}"`);
        reply.status(status);
        return ergebnis;
      },
    }));
  }, { prefix: '/v2' });
}

/** Zweiter Faktor (Story 2.9): Brücke vom Altcode (`/auth/login`) in den Dienst des Moduls zugang; die Schlüsselarbeit bleibt hier. */
export const zweiterFaktor = (pool, cfg) => {
  const ctx = () => ({ ...systemCtx('auth'), jetzt: cfg.uhr() });
  const krypto = { verschluesseln: (t) => verschluessele(t, cfg.schluesselKek), entschluesseln: (w) => entschluessele(w, cfg.schluesselKek) };
  return {
    benutzer: (id) => zugang.mfaBenutzerLesen(ctx(), pool, { id }),
    pruefen: (id, eingabe) => zugang.zweitenFaktorPruefen(ctx(), pool, { id, eingabe, ...krypto }),
    einrichten: (u) => zugang.totpEinrichten(ctx(), pool, { id: u.id, benutzername: u.benutzername, ...krypto }),
    neueBackupCodes: (id) => zugang.backupCodesErneuern(ctx(), pool, { id }),
    bestaetigen: (u, eingabe) => zugang.totpBestaetigen(ctx(), pool, { id: u.id, eingabe, ...krypto }),
  };
};
