// Anmelde-Kern: Kontext (Verein, Rolle, Rechte, Mitglieder) laden, Access-/Refresh-Token ausstellen, rotieren, widerrufen.
import { randomUUID } from 'node:crypto';
import { inTransaktion } from './db.js';
import { conflict, fehler, forbidden, unauthorized } from './errors.js';
import { signJwt, verifyJwt } from './jwt.js';
import * as audit from './module/audit/dienst.js';
import { baueCtx } from './pipeline/ctx.js';
import { ladeVerbandsrollen } from './module/rechte/dienst.js';
import { neuesToken, sha256 } from './passwords.js';
import { wirksameScopes } from './scopes.js';

export const HEADER_RE = /^Bearer (.+)$/;

export async function ladeAnwendung(db, schluessel) {
  const r = await db.query('select id, schluessel, scopes from anwendungen where schluessel = $1 and aktiv', [schluessel]);
  if (!r.rows[0]) throw unauthorized('Unbekannte oder deaktivierte Anwendung', 'unbekannte_anwendung');
  return r.rows[0];
}

/**
 * Vereinskontext eines Benutzers: freigegebene Zugehörigkeit, Rolle, wirksame Rechte, eigenes Mitglied (`mitglied_id`)
 * und eigenes Mitglied + Kinder (`mitglied_ids`). Ohne vereinId: bei genau einer Zugehörigkeit diese, sonst der Heimatverein,
 * sonst bei mehreren 409 (mit `ohneWahl`: der erste Verein).
 */
export async function ladeKontext(db, benutzer, vereinId, { ohneWahl = false } = {}) {
  const z = (await db.query(
    `select bv.verein_id, bv.rolle, bv.mitglied_id, v.name as verein_name
       from benutzer_vereine bv join vereine v on v.id = bv.verein_id
      where bv.benutzer_id = $1 and bv.status = 'freigegeben' and bv.geloescht_am is null and v.geloescht_am is null
      order by v.name`, [benutzer.id])).rows;
  let wahl;
  if (vereinId) {
    wahl = z.find((x) => x.verein_id === vereinId);
    if (!wahl) throw forbidden('Keine freigegebene Zugehörigkeit zu diesem Verein', 'kein_zugang_zum_verein');
  } else if (z.length === 1) wahl = z[0];
  else if (z.length > 1 && benutzer.heimatverein_id && z.some((x) => x.verein_id === benutzer.heimatverein_id)) {
    wahl = z.find((x) => x.verein_id === benutzer.heimatverein_id); // Heimatverein: Standard bei der Anmeldung
  } else if (z.length > 1 && ohneWahl) {
    wahl = z[0]; // SSO (Web): keine Pflicht-Vereinswahl, die App wählt den aktiven Verein selbst aus dem Token
  } else if (z.length > 1) {
    throw conflict('Bitte einen Verein wählen', 'verein_waehlen', { vereine: z.map((x) => ({ id: x.verein_id, name: x.verein_name })) });
  } else if (!benutzer.ist_super_admin) {
    throw forbidden('Kein freigegebener Verein – bitte beim Verein freischalten lassen', 'kein_verein');
  }
  if (!wahl) {
    return { verein_id: null, rolle: null, rechte: [], mitglied_id: null, mitglied_ids: [], super_admin: true };
  }
  const rechte = (await db.query(
    `select distinct recht from benutzer_wirksame_rechte where benutzer_id = $1 and verein_id = $2 order by 1`,
    [benutzer.id, wahl.verein_id])).rows.map((r) => r.recht);
  const kinder = (await db.query(
    `select e.mitglied_id from erziehungsberechtigte e
       join mitglieder m on m.id = e.mitglied_id and m.geloescht_am is null
      where e.benutzer_id = $1 and e.verein_id = $2 and e.geloescht_am is null`, [benutzer.id, wahl.verein_id])).rows.map((r) => r.mitglied_id);
  const ids = [...new Set([...(wahl.mitglied_id ? [wahl.mitglied_id] : []), ...kinder])];
  return {
    verein_id: wahl.verein_id, rolle: wahl.rolle, rechte, mitglied_id: wahl.mitglied_id || null, mitglied_ids: ids,
    super_admin: benutzer.ist_super_admin,
  };
}

/** Benutzerzeile, wie sie ladeKontext braucht. */
export const ladeBenutzerFuerKontext = async (db, id) =>
  (await db.query('select id, ist_super_admin, muss_passwort_aendern, heimatverein_id from benutzer where id = $1', [id])).rows[0];

/**
 * Verbandskontext (FR-15): nur wählbar, wenn der Benutzer dort eine aktive Rolle hat und einem Verein angehört (FR-14), sonst null. Vereinsrechte wirken darin nicht;
 * die alten Claims bleiben leer.
 */
export async function ladeVerbandskontext(db, benutzer, verbandId) {
  const imVerein = benutzer.ist_super_admin || (await db.query(
    `select 1 from benutzer_vereine bv join vereine v on v.id = bv.verein_id and v.geloescht_am is null
      where bv.benutzer_id = $1 and bv.status = 'freigegeben' and bv.geloescht_am is null limit 1`, [benutzer.id])).rowCount;
  if (!imVerein) return null;
  const rollen = (await ladeVerbandsrollen(null, db, { benutzer_id: benutzer.id })).filter((r) => r.verband_id === verbandId).map((r) => r.rolle).sort();
  if (!rollen.length) return null;
  return { verein_id: null, verband_id: verbandId, verbandsrollen: rollen, rolle: null, rechte: [], mitglied_id: null, mitglied_ids: [], super_admin: benutzer.ist_super_admin };
}

/** Hat der Benutzer eine aktive Verbandsrolle? Solche Konten darf ein Verein nicht zurücksetzen. */
export const hatVerbandsrolle = async (db, id) => (await ladeVerbandsrollen(null, db, { benutzer_id: id })).length > 0;

/** Audit der Altwege (NFR-18): Akteur, Rolle und Verein aus den Claims. Immer in der Transaktion der Änderung. */
export const auditiere = (db, claims, eintrag) => audit.schreiben(baueCtx({
  benutzer: { id: claims.sub }, kontext: claims.verein_id ? { art: 'verein', id: claims.verein_id } : null,
  rechte: { rolle: claims.rolle ?? null, super_admin: !!claims.super_admin }, anwendung: claims.azp || claims.aud, jetzt: new Date(),
}), db, eintrag);

/** Aktuelle Mail-Adresse eines aktiven Benutzers, sonst null. */
export const ladeMailAdresse = async (db, id) =>
  (await db.query('select email from benutzer where id = $1 and aktiv and geloescht_am is null', [id])).rows[0]?.email || null;

/** Alle freigegebenen Zugehörigkeiten: Verein, Rolle, wirksame Rechte, Mitglied und Kinder. */
async function ladeZugehoerigkeiten(db, benutzerId) {
  return (await db.query(
    `select bv.verein_id, v.name, bv.rolle, bv.mitglied_id,
            coalesce((select array_agg(w.recht order by w.recht) from benutzer_wirksame_rechte w
                       where w.benutzer_id = bv.benutzer_id and w.verein_id = bv.verein_id), '{}') as rechte,
            coalesce((select array_agg(e.mitglied_id) from erziehungsberechtigte e
                       join mitglieder m on m.id = e.mitglied_id and m.geloescht_am is null
                      where e.benutzer_id = bv.benutzer_id and e.verein_id = bv.verein_id and e.geloescht_am is null), '{}') as kinder
       from benutzer_vereine bv join vereine v on v.id = bv.verein_id
      where bv.benutzer_id = $1 and bv.status = 'freigegeben' and bv.geloescht_am is null and v.geloescht_am is null
      order by v.name`, [benutzerId])).rows;
}
const mitgliedIds = (x) => [...new Set([...(x.mitglied_id ? [x.mitglied_id] : []), ...x.kinder])];

/**
 * Benutzer-Objekt für die App: Stammdaten + ALLE freigegebenen Vereine mit Rolle, Rechten, wirksamen Scopes (für diese App)
 * und Mitgliedern. Die App entscheidet damit selbst (z. B. Vereinswahl, Menüs); der Server prüft weiterhin nur das Token.
 */
export async function ladeBenutzerObjekt(db, benutzerId, anwendung, aktivVereinId = null) {
  const u = (await db.query(
    `select id, benutzername, email, vorname, nachname, ist_super_admin, heimatverein_id from benutzer where id = $1`, [benutzerId])).rows[0];
  const z = await ladeZugehoerigkeiten(db, benutzerId);
  return {
    id: u.id, benutzername: u.benutzername, email: u.email, vorname: u.vorname, nachname: u.nachname, super_admin: u.ist_super_admin, heimatverein_id: u.heimatverein_id,
    aktiver_verein_id: aktivVereinId,
    vereine: z.map((x) => ({
      id: x.verein_id, name: x.name, rolle: x.rolle, rechte: x.rechte,
      scope: wirksameScopes({ rolle: x.rolle, rechte: x.rechte, superAdmin: u.ist_super_admin }, anwendung.scopes),
      mitglied_id: x.mitglied_id || null,
      mitglied_ids: mitgliedIds(x),
    })),
  };
}

/**
 * SSO-Claim `vereine` (docs/sso-entscheidung.md 2): Map verein_id → { name, rolle, rechte, mitglied_id, mitglied_ids, apps: { schluessel: scope } }.
 * apps = aktive Apps aus anwendung_vereine für den Verein, scope = Benutzer-Scopes ∩ anwendungen.scopes. Vereine ohne freigegebene App fehlen.
 * Liefert { vereine, aud } (aud = alle Apps, die die Person in mindestens einem Verein nutzen darf).
 */
export async function ladeVereineMap(db, benutzer) {
  const z = await ladeZugehoerigkeiten(db, benutzer.id);
  const apps = z.length ? (await db.query(
    `select av.verein_id, a.schluessel, a.scopes from anwendung_vereine av join anwendungen a on a.id = av.anwendung_id and a.aktiv
      where av.verein_id = any($1::uuid[]) order by a.schluessel`, [z.map((x) => x.verein_id)])).rows : [];
  const vereine = {}; const aud = new Set();
  for (const x of z) {
    const meine = apps.filter((a) => a.verein_id === x.verein_id);
    if (!meine.length) continue;
    const eintrag = { name: x.name, rolle: x.rolle, rechte: x.rechte, mitglied_id: x.mitglied_id || null, mitglied_ids: mitgliedIds(x), apps: {} };
    for (const a of meine) {
      eintrag.apps[a.schluessel] = wirksameScopes({ rolle: x.rolle, rechte: x.rechte, superAdmin: benutzer.ist_super_admin }, a.scopes).join(' ');
      aud.add(a.schluessel);
    }
    vereine[x.verein_id] = eintrag;
  }
  return { vereine, aud: [...aud].sort() };
}

/**
 * Access-Token (docs/sso-entscheidung.md 2). Neu: `aud`-Array, `azp` (App, die das Token angefordert hat), `heimatverein_id`, `vereine`.
 * Übergang: die alten Claims (verein_id, rolle, rechte, scope, mitglied_id/-ids) gelten weiter für den aktiven Verein der Anmeldung.
 * Geräte-Tokens (geraetId) bleiben an eine App und einen Verein gebunden: `aud` ist ein String, `vereine` enthält nur diesen Verein.
 * Bei Passwortwechsel-Pflicht: keine Vereine, leerer Scope, nur /ich nutzbar.
 */
export function baueAccessToken(app, { benutzer, kontext, anwendung, geraetId, sid, vereineInfo = { vereine: {}, aud: [] } }) {
  const cfg = app.cfg;
  const jetzt = Math.floor(Date.now() / 1000);
  const muss = benutzer.muss_passwort_aendern;
  const scope = muss || (kontext.verband_id && !kontext.super_admin) ? [] : wirksameScopes(
    { rolle: kontext.rolle, rechte: kontext.rechte, superAdmin: kontext.super_admin }, anwendung.scopes);
  let vereine = muss ? {} : vereineInfo.vereine;
  let aud = muss ? [anwendung.schluessel] : vereineInfo.aud;
  if (geraetId) {
    vereine = kontext.verein_id && vereine[kontext.verein_id] ? { [kontext.verein_id]: vereine[kontext.verein_id] } : {};
    aud = anwendung.schluessel;
  }
  const ids = Object.keys(vereine);
  const heimat = benutzer.heimatverein_id && vereine[benutzer.heimatverein_id] ? benutzer.heimatverein_id : (ids[0] ?? null);
  const gekuerzt = ids.length > 20;
  if (gekuerzt) vereine = Object.fromEntries(ids.map((id) => { const { mitglied_ids: _weg, ...rest } = vereine[id]; return [id, rest]; }));
  const claims = {
    iss: cfg.issuer, sub: benutzer.id, aud, azp: anwendung.schluessel, iat: jetzt, exp: jetzt + cfg.accessTtlSek, jti: randomUUID(),
    sid, super_admin: kontext.super_admin, heimatverein_id: heimat, vereine, ...(gekuerzt ? { mitglied_ids_gekuerzt: true } : {}),
    verein_id: kontext.verein_id, rolle: kontext.rolle, rechte: kontext.rechte,
    scope: scope.join(' '), mitglied_id: kontext.mitglied_id, mitglied_ids: kontext.mitglied_ids,
    ...(kontext.verband_id ? { kontext: { art: 'verband', id: kontext.verband_id }, verbandsrollen: kontext.verbandsrollen } : {}),
    ...(geraetId ? { geraet_id: geraetId } : {}), ...(muss ? { muss_passwort_aendern: true } : {}),
  };
  return { token: signJwt(claims, app.keys), claims };
}

/** Refresh-Token speichern + Antwort bauen. prev = bisheriges Token derselben Familie (Rotation). */
export async function stelleAus(app, db, { benutzer, kontext, anwendung, sitzungAnwendungId = anwendung.id, geraetId = null, art = 'normal', familieId = randomUUID(), prevId = null }) {
  const cfg = app.cfg;
  const rt = neuesToken();
  const tage = art === 'geraet' ? cfg.geraetTokenTage : cfg.refreshTage;
  const ins = await db.query(
    `insert into refresh_tokens (benutzer_id, anwendung_id, verein_id, geraet_id, familie_id, art, token_hash, laeuft_ab_am, verband_id)
     values ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(days => $8), $9) returning id`,
    [benutzer.id, sitzungAnwendungId, kontext.verein_id, geraetId, familieId, art, sha256(rt), tage, kontext.verband_id ?? null]);
  if (prevId) await db.query('update refresh_tokens set ersetzt_durch = $2 where id = $1', [prevId, ins.rows[0].id]);
  const vereineInfo = benutzer.muss_passwort_aendern ? undefined : await ladeVereineMap(db, benutzer);
  const { token, claims } = baueAccessToken(app, { benutzer, kontext, anwendung, geraetId, sid: familieId, vereineInfo });
  const benutzerObjekt = await ladeBenutzerObjekt(db, benutzer.id, anwendung, kontext.verein_id);
  return {
    benutzer: benutzerObjekt,
    access_token: token, token_type: 'Bearer', expires_in: cfg.accessTtlSek, refresh_token: rt,
    scope: claims.scope, verein_id: kontext.verein_id, muss_passwort_aendern: !!benutzer.muss_passwort_aendern,
    ...(art === 'geraet' ? { geraet_id: geraetId } : {}),
  };
}

// Rotation und Widerruf eines Benutzers laufen nacheinander; sonst übersähe ein Widerruf das gerade entstehende Refresh-Token.
const sperreSitzungen = (db, benutzerId) => db.query('select pg_advisory_xact_lock(hashtextextended($1, 1))', [`sitzungen:${benutzerId}`]);

export const widerrufeFamilie = (db, familieId) => inTransaktion(db, async (c) => {
  const b = (await c.query('select benutzer_id from refresh_tokens where familie_id = $1 limit 1', [familieId])).rows[0];
  if (b) await sperreSitzungen(c, b.benutzer_id);
  return c.query('update refresh_tokens set widerrufen_am = now() where familie_id = $1 and widerrufen_am is null', [familieId]);
});
/** Alle Anmeldungen des Benutzers beenden; liefert die Sitzungen (familie_id), die dabei neu widerrufen wurden (ohne Geräte-Anmeldungen). */
export const widerrufeAlle = (db, benutzerId, ausserFamilie = null) => inTransaktion(db, async (c) => {
  await sperreSitzungen(c, benutzerId);
  return [...new Set((await c.query(
    `update refresh_tokens set widerrufen_am = now() where benutzer_id = $1 and widerrufen_am is null and ($2::uuid is null or familie_id <> $2)
      returning familie_id, art`,
    [benutzerId, ausserFamilie])).rows.filter((r) => r.art !== 'geraet').map((r) => r.familie_id))];
});

/**
 * Refresh mit Rotation. Wiederverwendung eines schon rotierten Tokens widerruft die ganze Familie.
 * SSO: Web-/App-Sitzungen (art normal) gehören zur Sitzung, nicht zur App – jede App darf mit dem Cookie erneuern (`clientId` bestimmt nur
 * die App im Token, `azp`/alte Claims). Geräte-Tokens bleiben an ihre App gebunden. `vereinId` (?verein=) wählt den Verein für die alten Claims.
 */
export async function rotiere(app, refreshToken, { clientId = null, vereinId = null } = {}) {
  const cfg = app.cfg;
  const pool = app.pool;
  const rt = (await pool.query('select * from refresh_tokens where token_hash = $1', [sha256(refreshToken)])).rows[0];
  if (!rt) throw unauthorized('Ungültiges Refresh-Token', 'ungueltiges_token');
  const sitzungsApp = (await pool.query('select id, schluessel, scopes, aktiv from anwendungen where id = $1', [rt.anwendung_id])).rows[0];
  if (!sitzungsApp?.aktiv) throw unauthorized('Ungültiges Refresh-Token', 'ungueltiges_token');
  let anw = sitzungsApp;
  if (clientId && clientId !== sitzungsApp.schluessel) {
    if (rt.art === 'geraet') throw unauthorized('Ungültiges Refresh-Token', 'ungueltiges_token');
    anw = (await pool.query('select id, schluessel, scopes, aktiv from anwendungen where schluessel = $1 and aktiv', [clientId])).rows[0];
    if (!anw) throw unauthorized('Unbekannte oder deaktivierte Anwendung', 'unbekannte_anwendung');
  }

  if (rt.geraet_id && vereinId && vereinId.toLowerCase() !== rt.verein_id) {
    throw fehler(400, 'Geräte-Anmeldungen sind an einen Verein gebunden – am Gerät neu anmelden', 'geraet_gebunden');
  }

  if (rt.widerrufen_am) {
    if (rt.ersetzt_durch) {
      const sek = (Date.now() - new Date(rt.widerrufen_am).getTime()) / 1000;
      if (sek <= cfg.wiederverwendungSek) throw unauthorized('Token wurde gerade erneuert', 'token_ersetzt'); // z. B. zwei Tabs oder zwei Apps
      await widerrufeFamilie(pool, rt.familie_id); // Diebstahl-Verdacht: ganze Anmeldung beenden
      if (rt.art !== 'geraet') app.sitzungBeendet(rt.benutzer_id, [rt.familie_id]);
      throw unauthorized('Token wiederverwendet – Anmeldung beendet', 'token_wiederverwendet');
    }
    throw unauthorized('Abgemeldet', 'abgemeldet');
  }
  if (new Date(rt.laeuft_ab_am) <= new Date()) throw unauthorized('Refresh-Token abgelaufen', 'token_abgelaufen');

  const benutzer = (await pool.query(
    `select id, ist_super_admin, muss_passwort_aendern, heimatverein_id from benutzer where id = $1 and aktiv and geloescht_am is null`, [rt.benutzer_id])).rows[0];
  const beenden = async (msg, code) => {
    await widerrufeFamilie(pool, rt.familie_id);
    if (rt.art !== 'geraet') app.sitzungBeendet(rt.benutzer_id, [rt.familie_id]);
    return unauthorized(msg, code);
  };
  if (!benutzer) throw await beenden('Konto nicht mehr aktiv', 'konto_inaktiv');
  if (rt.geraet_id) {
    const g = (await pool.query('select gesperrt, verein_id from geraete where id = $1', [rt.geraet_id])).rows[0];
    if (!g || g.gesperrt || g.verein_id !== rt.verein_id) { await widerrufeFamilie(pool, rt.familie_id); throw unauthorized('Gerät gesperrt', 'geraet_gesperrt'); }
  }
  let kontext;
  const ohneWahl = !rt.geraet_id; // Web: kein Pflicht-Verein, die App wählt aus dem Token
  try {
    // Verbandskontext: bleibt, solange die Rolle besteht; sonst zurück zum Startkontext
    kontext = (!vereinId && rt.verband_id && await ladeVerbandskontext(pool, benutzer, rt.verband_id))
      || await ladeKontext(pool, benutzer, vereinId || rt.verein_id, { ohneWahl });
  } catch (e) {
    if (e.status !== 403 && e.status !== 409) throw e;
    if (vereinId) throw e; // ?verein= gehört der Person nicht: Anfrage ablehnen, Anmeldung bleibt bestehen
    if (!rt.geraet_id) { // gemerkter Verein nicht mehr gültig → Heimatverein/erster Verein
      try { kontext = await ladeKontext(pool, benutzer, null, { ohneWahl }); } catch { /* unten */ }
    }
    if (!kontext) throw await beenden('Zugang zum Verein nicht mehr gültig', 'kein_zugang_zum_verein');
  }
  // atomar „beanspruchen“: nur eine von zwei gleichzeitigen Anfragen gewinnt
  const client = await pool.connect();
  try {
    await client.query('begin');
    await sperreSitzungen(client, rt.benutzer_id);
    const claim = await client.query('update refresh_tokens set widerrufen_am = now() where id = $1 and widerrufen_am is null returning id', [rt.id]);
    if (!claim.rows[0]) { await client.query('rollback'); throw unauthorized('Token wurde gerade erneuert', 'token_ersetzt'); }
    const out = await stelleAus(app, client, {
      benutzer, kontext, anwendung: anw, sitzungAnwendungId: sitzungsApp.id, geraetId: rt.geraet_id, art: rt.art, familieId: rt.familie_id, prevId: rt.id,
    });
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Bearer-Token prüfen (Signatur, Ablauf, iss); Konto muss noch existieren. Liefert die Claims. */
export async function pruefeBearer(app, req, { erlaubeMussPasswort = false } = {}) {
  const m = HEADER_RE.exec(req.headers.authorization || '');
  const claims = m && verifyJwt(m[1], app.keys, { iss: app.cfg.issuer });
  if (!claims) throw unauthorized();
  if (claims.client) throw forbidden('Dieser Endpunkt gilt nur für Benutzer-Tokens', 'nur_benutzer');
  const ok = (await app.pool.query('select 1 from benutzer where id = $1 and aktiv and geloescht_am is null', [claims.sub])).rows[0];
  if (!ok) throw unauthorized();
  if (claims.muss_passwort_aendern && !erlaubeMussPasswort) {
    throw fehler(403, 'Bitte zuerst ein eigenes Passwort festlegen', 'passwort_aendern');
  }
  return claims;
}

/**
 * Client-Credentials-Token einer App prüfen (Abgleich, Rückschreiben): Benutzer-Tokens → 403 nur_anwendung; optional Scope aus
 * anwendungen.client_scopes (403 scope_fehlt); der Verein muss der App in anwendung_vereine zugeordnet sein (403 verein_nicht_freigegeben).
 */
export async function pruefeAnwendungsToken(app, req, { vereinId, scope = null }) {
  const m = HEADER_RE.exec(req.headers.authorization || '');
  const claims = m && verifyJwt(m[1], app.keys, { iss: app.cfg.issuer });
  if (!claims) throw unauthorized();
  if (!claims.client) throw forbidden('Dieser Endpunkt ist nur für Anwendungen (client_credentials) gedacht', 'nur_anwendung');
  const anw = (await app.pool.query(
    'select id, schluessel, client_scopes, lizenz_arten from anwendungen where schluessel = $1 and aktiv', [claims.aud])).rows[0];
  if (!anw) throw unauthorized();
  if (scope && !anw.client_scopes.includes(scope)) throw forbidden('Dafür fehlt die Berechtigung', 'scope_fehlt');
  const frei = (await app.pool.query('select 1 from anwendung_vereine where anwendung_id = $1 and verein_id = $2', [anw.id, vereinId])).rows[0];
  if (!frei) throw forbidden('Dieser Verein ist der Anwendung nicht freigegeben', 'verein_nicht_freigegeben');
  return { anw, claims };
}
