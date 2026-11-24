import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT, cfgDefault, neueApp } from './helper.js';

let t;
beforeAll(async () => { t = await neueApp(); });
afterAll(() => t.schliessen());

const holen = (extra = {}, headers = {}) =>
  t.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'client_credentials', client_id: CLIENT, client_secret: cfgDefault.demoClientSecret, ...extra }, headers })
    .then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

describe('Client-Credentials (Server-zu-Server)', () => {
  it('liefert ein Token ohne Benutzer: scope = client_scopes, aud, lizenz_arten, kein Refresh-Token', async () => {
    const r = await holen();
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).toBeUndefined();
    const { payload } = await t.pruefe(r.body.access_token);
    const a = (await t.pool.query(`select client_scopes, lizenz_arten from anwendungen where schluessel = $1`, [CLIENT])).rows[0];
    expect(payload.sub).toBe(`app:${CLIENT}`);
    expect(payload.client).toBe(true);
    expect(payload.scope.split(' ').sort()).toEqual([...a.client_scopes].sort());
    expect(payload.lizenz_arten).toEqual(a.lizenz_arten);
    expect(payload.scope).not.toContain('benutzer:verwalten');
    expect(payload.scope).not.toContain('mitglieder:kontakt');
    expect(payload.verein_id).toBeUndefined();
  });

  it('auch per HTTP Basic', async () => {
    const basic = Buffer.from(`${CLIENT}:${cfgDefault.demoClientSecret}`).toString('base64');
    const r = await t.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'client_credentials' }, headers: { authorization: `Basic ${basic}` } });
    expect(r.statusCode).toBe(200);
  });

  it('falsches/fehlendes Secret, unbekannte oder deaktivierte App, App ohne Secret → 401', async () => {
    expect((await holen({ client_secret: 'falsch' })).status).toBe(401);
    expect((await holen({ client_secret: undefined })).status).toBe(401);
    expect((await holen({ client_id: 'unbekannt' })).status).toBe(401);
    await t.pool.query(`update anwendungen set client_secret_hash = null where schluessel = 'hajime-pro'`);
    expect((await holen({ client_id: 'hajime-pro' })).status).toBe(401);
    await t.pool.query(`update anwendungen set aktiv = false where schluessel = $1`, [CLIENT]);
    expect((await holen()).status).toBe(401);
    await t.pool.query(`update anwendungen set aktiv = true where schluessel = $1`, [CLIENT]);
  });

  it('Client-Token taugt nicht für Benutzer-Endpunkte (/ich, /benutzer, /einladungen)', async () => {
    const tok = (await holen()).body.access_token;
    expect((await t.api('GET', '/ich', null, tok)).status).toBe(403);
    expect((await t.api('POST', '/benutzer', { benutzername: 'abc' }, tok)).status).toBe(403);
    expect((await t.api('POST', '/auth/logout', { alle_geraete: true }, tok)).status).toBe(403);
  });

  it('Secret liegt nur als argon2-Hash in der Datenbank', async () => {
    const h = (await t.pool.query(`select client_secret_hash from anwendungen where schluessel = $1`, [CLIENT])).rows[0].client_secret_hash;
    expect(h.startsWith('$argon2id$')).toBe(true);
  });
});
