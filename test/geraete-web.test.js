import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT, PW, neueApp } from './helper.js';

let t;
beforeAll(async () => { t = await neueApp(); });
afterAll(() => t.schliessen());

const cookieVon = (r) => String(r.headers['set-cookie'] || '').split(';')[0];

describe('Vereinsgerät mit mehreren Personen', () => {
  it('Admin registriert Gerät; Trainer und Prüfer melden sich daran an, je mit eigenem Geräte-Token', async () => {
    const ad = (await t.login('admin1')).body;
    const g = await t.api('POST', '/geraete', { name: 'Hallen-Tablet', typ: 'tablet' }, ad.access_token);
    expect(g.status).toBe(201);
    const ids = [];
    for (const n of ['trainer1', 'pruefer1']) {
      const l = await t.login(n, { geraet: { id: g.body.id }, geraet_token: true });
      expect(l.status).toBe(200);
      expect(l.body.geraet_id).toBe(g.body.id);
      expect((await t.pruefe(l.body.access_token)).payload.geraet_id).toBe(g.body.id);
      ids.push(l.body.refresh_token);
    }
    expect(ids[0]).not.toBe(ids[1]);
    expect((await t.pool.query(`select count(*)::int n from geraete`)).rows[0].n).toBe(1);
    // PIN am Vereinsgerät
    const tr = (await t.login('trainer1')).body;
    await t.api('PATCH', '/ich', { pin: '4711', passwort_alt: PW }, tr.access_token);
    expect((await t.api('POST', '/auth/pin', { benutzername: 'trainer1', pin: '4711', geraet_id: g.body.id, client_id: CLIENT })).status).toBe(200);
    // Sperre beendet beide Anmeldungen
    expect((await t.api('PATCH', `/geraete/${g.body.id}`, { gesperrt: true }, ad.access_token)).status).toBe(200);
    expect((await t.refresh(ids[0])).status).toBe(401);
    expect((await t.refresh(ids[1])).status).toBe(401);
  });

  it('nur Admins verwalten Geräte; fremder Verein bleibt unsichtbar', async () => {
    const tr = (await t.login('trainer1')).body;
    expect((await t.api('POST', '/geraete', { name: 'X' }, tr.access_token)).status).toBe(403);
    expect((await t.api('GET', '/geraete', null, tr.access_token)).status).toBe(403);
    const ad = (await t.login('admin1')).body;
    expect((await t.api('PATCH', '/geraete/00000000-0000-4000-8000-000000000000', { gesperrt: true }, ad.access_token)).status).toBe(404);
    expect((await t.api('GET', '/geraete', null, ad.access_token)).body.daten.length).toBeGreaterThan(0);
  });
});

describe('Web: Refresh-Token als Cookie', () => {
  it('Login setzt HttpOnly-Cookie, Body ohne refresh_token; Refresh und Logout über Cookie', async () => {
    const l = await t.login('schueler1', { client_typ: 'web' });
    expect(l.status).toBe(200);
    expect(l.body.refresh_token).toBeUndefined();
    const set = String(l.headers['set-cookie']);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    const cookie = cookieVon(l);
    expect(cookie.startsWith('sd_refresh=')).toBe(true);

    const r = await t.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', client_id: CLIENT }, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).refresh_token).toBeUndefined();
    const neu = String(r.headers['set-cookie']).split(';')[0];
    expect(neu).not.toBe(cookie);
    // altes Cookie nach der Frist wiederverwendet → Familie widerrufen, Cookie gelöscht
    await t.pool.query(`update refresh_tokens set widerrufen_am = now() - interval '1 minute' where ersetzt_durch is not null`);
    const dieb = await t.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', client_id: CLIENT }, headers: { cookie } });
    expect(dieb.statusCode).toBe(401);
    expect(String(dieb.headers['set-cookie'])).toMatch(/Max-Age=0/);
    const logout = await t.app.inject({ method: 'POST', url: '/auth/logout', payload: {}, headers: { cookie: neu } });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toMatch(/Max-Age=0/);
  });

  it('App-Clients bekommen weiter das Token im Body, kein Cookie', async () => {
    const l = await t.login('schueler1');
    expect(l.body.refresh_token).toBeTruthy();
    expect(l.headers['set-cookie']).toBeUndefined();
  });
});
