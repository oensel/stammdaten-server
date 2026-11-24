import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PW, neueApp } from './helper.js';

let t;
beforeAll(async () => { t = await neueApp({ maxFehlversuche: 3 }); });
afterAll(() => t.schliessen());

describe('GET/PATCH /ich', () => {
  it('liefert eigenes Konto mit Vereinen und aktivem Kontext', async () => {
    const l = (await t.login('trainer1')).body;
    const r = await t.api('GET', '/ich', null, l.access_token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ benutzername: 'trainer1', pin_gesetzt: false, super_admin: false });
    expect(r.body.vereine[0]).toMatchObject({ name: 'JC Demo', rolle: 'mitglied', rechte: ['trainer'] });
    expect(r.body.aktiv.scope).toContain('benutzer:schueler');
    expect(r.body.passwort_hash).toBeUndefined();
    expect((await t.api('GET', '/ich')).status).toBe(401);
    expect((await t.api('GET', '/ich', null, 'x.y.z')).status).toBe(401);
  });

  it('Passwort ändern: altes Passwort nötig, andere Geräte werden abgemeldet, eigene Anmeldung bleibt', async () => {
    const a = (await t.login('schueler1')).body;
    const b = (await t.login('schueler1')).body;
    expect((await t.api('PATCH', '/ich', { passwort_alt: 'falsch-falsch', passwort_neu: 'Neues-Passwort-9' }, a.access_token)).status).toBe(401);
    expect((await t.api('PATCH', '/ich', { passwort_alt: PW, passwort_neu: 'kurz' }, a.access_token)).status).toBe(400);
    expect((await t.api('PATCH', '/ich', { passwort_alt: PW, passwort_neu: 'Neues-Passwort-9' }, a.access_token)).status).toBe(200);
    expect((await t.refresh(b.refresh_token)).status).toBe(401);
    expect((await t.refresh(a.refresh_token)).status).toBe(200);
    expect((await t.login('schueler1')).status).toBe(401);
    expect((await t.login('schueler1', {}, 'Neues-Passwort-9')).status).toBe(200);
  });

  it('Name und E-Mail ändern, doppelte E-Mail → 409', async () => {
    const l = (await t.login('pruefer1')).body;
    expect((await t.api('PATCH', '/ich', { vorname: 'Paula', email: 'p@example.org' }, l.access_token)).status).toBe(200);
    expect((await t.api('GET', '/ich', null, l.access_token)).body).toMatchObject({ vorname: 'Paula', email: 'p@example.org', email_bestaetigt: false });
    const k = (await t.login('trainer1')).body;
    expect((await t.api('PATCH', '/ich', { email: 'P@example.org' }, k.access_token)).status).toBe(409);
  });
});

describe('PIN und Gerät (Offline-Entsperren)', () => {
  it('PIN setzen (nur mit Passwort), Anmeldung per PIN am Gerät, Falscheingaben entwerten die PIN', async () => {
    const l = (await t.login('admin1', { geraet: { typ: 'tablet', name: 'Büro' } })).body;
    const { payload } = await t.pruefe(l.access_token);
    expect((await t.api('PATCH', '/ich', { pin: '123456' }, l.access_token)).status).toBe(401);
    expect((await t.api('PATCH', '/ich', { pin: '12ab', passwort_alt: PW }, l.access_token)).status).toBe(400);
    expect((await t.api('PATCH', '/ich', { pin: '2468', passwort_alt: PW }, l.access_token)).status).toBe(200);
    const pin = (pinWert) => t.api('POST', '/auth/pin', { benutzername: 'admin1', pin: pinWert, geraet_id: payload.geraet_id, client_id: 'kyu-manager-pro' });
    const ok = await pin('2468');
    expect(ok.status).toBe(200);
    expect((await t.pruefe(ok.body.access_token)).payload.rolle).toBe('admin');
    expect((await pin('0000')).status).toBe(401);
    expect((await pin('0000')).status).toBe(401);
    const entwertet = await pin('0000');
    expect(entwertet.status).toBe(429);
    expect(entwertet.body.pin_entwertet).toBe(true);
    expect((await pin('2468')).status).toBe(401);
    expect((await t.login('admin1')).status).toBe(200);
  });

  it('PIN gilt nicht an fremdem Gerät', async () => {
    const a = (await t.login('trainer1', { geraet: { typ: 'tablet' } })).body;
    await t.api('PATCH', '/ich', { pin: '1357', passwort_alt: PW }, a.access_token);
    const fremdesGeraet = (await t.pruefe((await t.login('eltern1', { geraet: { typ: 'phone' } })).body.access_token)).payload.geraet_id;
    const r = await t.api('POST', '/auth/pin', { benutzername: 'trainer1', pin: '1357', geraet_id: fremdesGeraet, client_id: 'kyu-manager-pro' });
    expect(r.status).toBe(401);
  });

  it('geraet_token: langlebiges Refresh-Token je Benutzer + Gerät (90 Tage), Rotation behält die Art', async () => {
    const l = (await t.login('trainer1', { geraet: { typ: 'tablet', name: 'Halle' }, geraet_token: true })).body;
    expect(l.geraet_id).toBeTruthy();
    const row = (await t.pool.query(
      `select art, extract(day from laeuft_ab_am - erstellt_am)::int tage from refresh_tokens order by erstellt_am desc limit 1`)).rows[0];
    expect(row.art).toBe('geraet');
    expect(row.tage).toBeGreaterThanOrEqual(89);
    const r = await t.refresh(l.refresh_token);
    expect(r.status).toBe(200);
    expect((await t.pool.query(`select art from refresh_tokens order by erstellt_am desc limit 1`)).rows[0].art).toBe('geraet');
    expect((await t.api('POST', '/auth/login', { benutzername: 'trainer1', passwort: PW, client_id: 'kyu-manager-pro', geraet_token: true })).status).toBe(400);
  });
});

describe('Konto löschen', () => {
  it('braucht das Passwort, danach kein Login/Refresh/Token mehr', async () => {
    const l = (await t.login('eltern1')).body;
    expect((await t.api('DELETE', '/ich', { passwort: 'falsch-falsch' }, l.access_token)).status).toBe(401);
    expect((await t.api('DELETE', '/ich', { passwort: PW }, l.access_token)).status).toBe(204);
    expect((await t.login('eltern1')).status).toBe(401);
    expect((await t.refresh(l.refresh_token)).status).toBe(401);
    expect((await t.api('GET', '/ich', null, l.access_token)).status).toBe(401);
  });
});
