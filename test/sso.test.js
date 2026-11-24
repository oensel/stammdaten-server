// Single Sign-on (docs/sso-entscheidung.md): Token-Inhalt, Refresh durch eine zweite App, Logout → Back-Channel, Geräte unverändert
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { CLIENT, neueApp } from './helper.js';

let t; let jcDemo; let zweit; let adminId;
const cookieAus = (r) => /sd_refresh=([^;]*)/.exec(r.headers['set-cookie'] || '')?.[1];
const web = { client_typ: 'web' };

beforeAll(async () => {
  t = await neueApp({ backchannelWartenMs: [0, 20, 40] });
  jcDemo = (await t.pool.query(`select id from vereine where name = 'JC Demo'`)).rows[0].id;
  adminId = (await t.pool.query(`select id from benutzer where benutzername = 'admin1'`)).rows[0].id;
  zweit = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('JC Zweit', true) returning id`)).rows[0].id;
  await t.pool.query(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'mitglied','freigegeben')`, [adminId, zweit]);
  await t.pool.query(`insert into benutzer_rechte (benutzer_id, verein_id, recht_id) select $1,$2,id from rechte where schluessel = 'pruefer'`, [adminId, zweit]);
  // JC Zweit nutzt Kyu-Manager und Dojo-Master; JC Demo nur Kyu-Manager (bereits aus dem Seed)
  await t.pool.query(`insert into anwendung_vereine (anwendung_id, verein_id) select id, $1 from anwendungen where schluessel in ('kyu-manager-pro','dojo-master-pro')`, [zweit]);
});
afterAll(() => t.schliessen());

describe('Access-Token (SSO)', () => {
  it('Web-Login ohne Vereinswahl: aud-Array, sid, heimatverein_id, vereine-Map mit apps→scope, alte Claims gelten weiter', async () => {
    const r = await t.login('admin1', web);
    expect(r.status).toBe(200); // kein 409 verein_waehlen
    const { payload } = await t.pruefe(r.body.access_token);
    expect(payload.aud).toEqual(['dojo-master-pro', 'kyu-manager-pro']);
    expect(payload.azp).toBe(CLIENT);
    expect(payload.sid).toBeTruthy();
    expect(Object.keys(payload.vereine).sort()).toEqual([jcDemo, zweit].sort());
    const demo = payload.vereine[jcDemo]; const z = payload.vereine[zweit];
    expect(demo).toMatchObject({ name: 'JC Demo', rolle: 'admin', rechte: [] });
    expect(Object.keys(demo.apps)).toEqual(['kyu-manager-pro']);
    expect(demo.apps['kyu-manager-pro'].split(' ')).toContain('benutzer:verwalten');
    expect(z).toMatchObject({ name: 'JC Zweit', rolle: 'mitglied', rechte: ['pruefer'] });
    expect(Object.keys(z.apps).sort()).toEqual(['dojo-master-pro', 'kyu-manager-pro']);
    expect(z.apps['kyu-manager-pro'].split(' ')).not.toContain('benutzer:verwalten');
    expect(demo.mitglied_ids).toHaveLength(1);
    // Übergang: alte Claims für den ersten Verein (ohne Heimatverein: JC Demo, alphabetisch)
    expect(payload.heimatverein_id).toBe(jcDemo);
    expect(payload).toMatchObject({ verein_id: jcDemo, rolle: 'admin', super_admin: false });
    expect(payload.scope.split(' ')).toContain('benutzer:verwalten');
    expect(payload.mitglied_ids).toEqual(demo.mitglied_ids);
  });

  it('ohne client_typ web bleibt die Vereinswahl Pflicht (409), mit Heimatverein nicht', async () => {
    expect((await t.login('admin1')).status).toBe(409);
    await t.pool.query(`update benutzer set heimatverein_id = $1 where id = $2`, [zweit, adminId]);
    const r = await t.login('admin1', web);
    const { payload } = await t.pruefe(r.body.access_token);
    expect(payload.heimatverein_id).toBe(zweit);
    expect(payload.verein_id).toBe(zweit);
    await t.pool.query(`update benutzer set heimatverein_id = null where id = $1`, [adminId]);
  });

  it('Verein ohne freigegebene App erscheint nicht; ohne jede App bleiben aud und vereine leer', async () => {
    const leer = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('Ohne App', true) returning id`)).rows[0].id;
    await t.pool.query(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'mitglied','freigegeben')`, [adminId, leer]);
    const { payload } = await t.pruefe((await t.login('admin1', web)).body.access_token);
    expect(Object.keys(payload.vereine)).not.toContain(leer);
    await t.pool.query(`update benutzer_vereine set status = 'gesperrt' where benutzer_id = $1 and verein_id = $2`, [adminId, leer]).catch(() => {});
  });

  it('Geräte-Anmeldung unverändert: aud ist ein String, ein Verein, Refresh nur für die eigene App', async () => {
    const g = (await t.pool.query(
      `insert into geraete (verein_id, anwendung_id, benutzer_id, name, typ) select $1, id, null, 'Hallentablet', 'tablet' from anwendungen where schluessel = $2 returning id`,
      [jcDemo, CLIENT])).rows[0].id;
    const trainerPin = (await t.pool.query(`select id from benutzer where benutzername = 'trainer1'`)).rows[0].id;
    expect(trainerPin).toBeTruthy();
    const r = await t.login('trainer1', { geraet: { id: g }, geraet_token: true, verein_id: jcDemo });
    expect(r.status).toBe(200);
    const { payload } = await t.pruefe(r.body.access_token);
    expect(payload.aud).toBe(CLIENT);
    expect(payload.geraet_id).toBe(g);
    expect(Object.keys(payload.vereine)).toEqual([jcDemo]);
    expect(payload.verein_id).toBe(jcDemo);
    // Geräte-Tokens gehören zur App: eine andere App darf sie nicht erneuern
    expect((await t.refresh(r.body.refresh_token, 'dojo-master-pro')).status).toBe(401);
    expect((await t.refresh(r.body.refresh_token)).status).toBe(200);
  });
});

describe('Refresh gehört zur Sitzung', () => {
  it('eine zweite App erneuert mit demselben Cookie; ?verein= wählt den Verein der alten Claims; sid bleibt gleich', async () => {
    const l = await t.login('admin1', web);
    const cookie = cookieAus(l);
    const sid = (await t.pruefe(l.body.access_token)).payload.sid;
    const r = await t.app.inject({
      method: 'POST', url: `/oauth/token?verein=${zweit}`, headers: { cookie: `sd_refresh=${cookie}` },
      payload: { grant_type: 'refresh_token', client_id: 'dojo-master-pro' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    const { payload } = await t.pruefe(body.access_token, 'dojo-master-pro');
    expect(payload.sid).toBe(sid);
    expect(payload.azp).toBe('dojo-master-pro');
    expect(payload.verein_id).toBe(zweit);
    expect(Object.keys(payload.vereine).sort()).toEqual([jcDemo, zweit].sort());
    expect(body.refresh_token).toBeUndefined(); // Web: nur im Cookie
    expect(cookieAus(r)).toBeTruthy();
    // fremder Verein → 403, Anmeldung bleibt bestehen
    const fremd = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('Fremd', true) returning id`)).rows[0].id;
    const neu = cookieAus(r);
    const f = await t.app.inject({ method: 'POST', url: `/oauth/token?verein=${fremd}`, headers: { cookie: `sd_refresh=${neu}` }, payload: { grant_type: 'refresh_token' } });
    expect(f.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/oauth/token', headers: { cookie: `sd_refresh=${neu}` }, payload: { grant_type: 'refresh_token' } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('Logout und Back-Channel', () => {
  let empfaenger; let port; let erhalten; let antwortCode;
  beforeAll(async () => {
    erhalten = []; antwortCode = 200;
    empfaenger = http.createServer((req, res) => {
      let d = ''; req.on('data', (c) => { d += c; });
      req.on('end', () => { erhalten.push({ url: req.url, body: JSON.parse(d) }); res.writeHead(antwortCode).end(); });
    });
    await new Promise((r) => empfaenger.listen(0, '127.0.0.1', r));
    port = empfaenger.address().port;
    await t.pool.query(`update anwendungen set backchannel_url = $1 where schluessel = 'kyu-manager-pro'`, [`http://127.0.0.1:${port}/api/auth/backchannel-logout`]);
  });
  afterAll(() => new Promise((r) => empfaenger.close(r)));

  it('POST /auth/logout widerruft die ganze sid, löscht das Cookie und schickt ein signiertes Logout-Token an die App', async () => {
    erhalten.length = 0;
    const l = await t.login('admin1', web);
    const cookie = cookieAus(l);
    const { payload: at } = await t.pruefe(l.body.access_token);
    const r = await t.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: `sd_refresh=${cookie}` } });
    expect(r.statusCode).toBe(204);
    expect(r.headers['set-cookie']).toMatch(/Max-Age=0/);
    await t.app.backchannelFertig();

    expect(erhalten).toHaveLength(1);
    expect(erhalten[0].url).toBe('/api/auth/backchannel-logout');
    const jwks = createLocalJWKSet((await t.api('GET', '/.well-known/jwks.json')).body);
    const { payload, protectedHeader } = await jwtVerify(erhalten[0].body.logout_token, jwks, { issuer: 'http://stammdaten.test', audience: CLIENT });
    expect(protectedHeader.typ).toBe('logout+jwt');
    expect(payload).toMatchObject({ sid: at.sid, sub: at.sub, aud: CLIENT });
    expect(payload.exp - payload.iat).toBe(120);
    expect(payload.events).toBeTruthy();
    // die Sitzung ist beendet – auch für jede andere App
    const nach = await t.app.inject({ method: 'POST', url: '/oauth/token', headers: { cookie: `sd_refresh=${cookie}` }, payload: { grant_type: 'refresh_token', client_id: 'dojo-master-pro' } });
    expect(nach.statusCode).toBe(401);
  });

  it('Zustellung wird 3× wiederholt, danach aufgegeben; Logout selbst klappt trotzdem', async () => {
    erhalten.length = 0; antwortCode = 500;
    const l = await t.login('admin1', web);
    const r = await t.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: `sd_refresh=${cookieAus(l)}` } });
    expect(r.statusCode).toBe(204);
    await t.app.backchannelFertig();
    expect(erhalten).toHaveLength(3);
    antwortCode = 200;
  });

  it('alle_geraete beendet jede Web-Sitzung des Benutzers, je Sitzung ein Logout-Token', async () => {
    // Altlasten aus den Tests davor beenden, dann zählen
    await t.api('POST', '/auth/logout', { alle_geraete: true }, (await t.login('admin1', web)).body.access_token);
    await t.app.backchannelFertig();
    erhalten.length = 0;
    const a = await t.login('admin1', web); const b = await t.login('admin1', web);
    const r = await t.api('POST', '/auth/logout', { alle_geraete: true }, a.body.access_token);
    expect(r.status).toBe(204);
    await t.app.backchannelFertig();
    expect(erhalten).toHaveLength(2);
    const sids = erhalten.map((e) => JSON.parse(Buffer.from(e.body.logout_token.split('.')[1], 'base64url').toString()).sid).sort();
    const erwartet = [(await t.pruefe(a.body.access_token)).payload.sid, (await t.pruefe(b.body.access_token)).payload.sid].sort();
    expect(sids).toEqual(erwartet);
  });

  it('App ohne backchannel_url wird übersprungen (kein Fehler)', async () => {
    await t.pool.query(`update anwendungen set backchannel_url = null where schluessel = 'kyu-manager-pro'`);
    erhalten.length = 0;
    const l = await t.login('admin1', web);
    expect((await t.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: `sd_refresh=${cookieAus(l)}` } })).statusCode).toBe(204);
    await t.app.backchannelFertig();
    expect(erhalten).toHaveLength(0);
  });
});

describe('GET /v1/anwendungen', () => {
  it('öffentlich: nur aktive Apps mit Startadresse (schluessel, name, url, icon)', async () => {
    await t.pool.query(`update anwendungen set url = null where schluessel not in ('kyu-manager-pro', 'dojo-master-pro')`); // Migration 007 setzt Entwicklungsadressen
    await t.pool.query(`update anwendungen set url = 'https://kyu.example.org', icon = 'kyu' where schluessel = 'kyu-manager-pro'`);
    await t.pool.query(`update anwendungen set url = 'https://dojo.example.org' where schluessel = 'dojo-master-pro'`);
    const r = await t.api('GET', '/v1/anwendungen');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { schluessel: 'dojo-master-pro', name: 'Dojo-Master-Pro', url: 'https://dojo.example.org', icon: null },
      { schluessel: 'kyu-manager-pro', name: 'Kyu-Manager-Pro', url: 'https://kyu.example.org', icon: 'kyu' },
    ]);
    await t.pool.query(`update anwendungen set aktiv = false where schluessel = 'dojo-master-pro'`);
    expect((await t.api('GET', '/v1/anwendungen')).body.map((a) => a.schluessel)).toEqual(['kyu-manager-pro']);
  });
});
