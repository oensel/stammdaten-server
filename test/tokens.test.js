import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neueApp } from './helper.js';

let t;
beforeAll(async () => { t = await neueApp({ wiederverwendungSek: 20 }); });
afterAll(() => t.schliessen());

describe('JWKS', () => {
  it('liefert öffentliche Ed25519-Schlüssel ohne privaten Anteil', async () => {
    const r = await t.api('GET', '/.well-known/jwks.json');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('max-age');
    expect(r.body.keys.length).toBeGreaterThan(0);
    for (const k of r.body.keys) {
      expect(k).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
      expect(k.kid).toBeTruthy();
      expect(k.d).toBeUndefined();
    }
    const cfg = (await t.api('GET', '/.well-known/openid-configuration')).body;
    expect(cfg.jwks_uri).toBe('http://stammdaten.test/.well-known/jwks.json');
  });

  it('privater Schlüssel liegt nur verschlüsselt in der Datenbank', async () => {
    const r = (await t.pool.query('select private_key_verschluesselt from signaturschluessel limit 1')).rows[0];
    expect(r.private_key_verschluesselt.startsWith('enc1:')).toBe(true);
    expect(r.private_key_verschluesselt).not.toContain('PRIVATE KEY');
  });
});

describe('Refresh-Rotation', () => {
  it('liefert ein neues Paar, das alte Token ist danach ungültig', async () => {
    const l = (await t.login('schueler1')).body;
    const r = await t.refresh(l.refresh_token);
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).not.toBe(l.refresh_token);
    expect(r.body.access_token).not.toBe(l.access_token);
    await t.pruefe(r.body.access_token);
    expect((await t.refresh(r.body.refresh_token)).status).toBe(200);
  });

  it('kurz nach der Rotation (z. B. zwei Tabs): nur 401, die Familie bleibt gültig', async () => {
    const l = (await t.login('schueler1')).body;
    const neu = (await t.refresh(l.refresh_token)).body;
    const zweiter = await t.refresh(l.refresh_token);
    expect(zweiter.status).toBe(401);
    expect(zweiter.body.code).toBe('token_ersetzt');
    expect((await t.refresh(neu.refresh_token)).status).toBe(200);
  });

  it('Wiederverwendung nach der Frist widerruft die ganze Familie', async () => {
    const l = (await t.login('schueler1')).body;
    const neu = (await t.refresh(l.refresh_token)).body;
    await t.pool.query(`update refresh_tokens set widerrufen_am = now() - interval '1 minute' where ersetzt_durch is not null`);
    const diebstahl = await t.refresh(l.refresh_token);
    expect(diebstahl.status).toBe(401);
    expect(diebstahl.body.code).toBe('token_wiederverwendet');
    const danach = await t.refresh(neu.refresh_token);
    expect(danach.status).toBe(401);
    expect(danach.body.code).toBe('abgemeldet');
  });

  it('andere Anmeldungen (Familien) bleiben bei der Wiederverwendung unberührt', async () => {
    const a = (await t.login('trainer1')).body;
    const b = (await t.login('trainer1')).body;
    const a2 = (await t.refresh(a.refresh_token)).body;
    await t.pool.query(`update refresh_tokens set widerrufen_am = now() - interval '1 minute' where ersetzt_durch is not null`);
    await t.refresh(a.refresh_token);
    expect((await t.refresh(a2.refresh_token)).status).toBe(401);
    expect((await t.refresh(b.refresh_token)).status).toBe(200);
  });

  it('gleichzeitige Anfragen: höchstens eine gewinnt', async () => {
    const l = (await t.login('pruefer1')).body;
    const rs = await Promise.all([t.refresh(l.refresh_token), t.refresh(l.refresh_token), t.refresh(l.refresh_token)]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('nur Hash in der Datenbank, unbekannte App / Unsinn / abgelaufen → 401', async () => {
    const l = (await t.login('admin1')).body;
    const roh = (await t.pool.query(`select count(*)::int n from refresh_tokens where token_hash = $1`, [l.refresh_token])).rows[0].n;
    expect(roh).toBe(0);
    const unbekannt = await t.refresh(l.refresh_token, 'gibts-nicht');
    expect(unbekannt.status).toBe(401);
    expect(unbekannt.body.code).toBe('unbekannte_anwendung');
    expect((await t.refresh('Unsinn')).status).toBe(401);
    await t.pool.query(`update refresh_tokens set laeuft_ab_am = now() - interval '1 second'`);
    const r = await t.refresh(l.refresh_token);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('token_abgelaufen');
  });

  it('Rechteänderung wirkt beim nächsten Refresh, gesperrte Zugehörigkeit beendet die Anmeldung', async () => {
    const l = (await t.login('trainer1')).body;
    await t.pool.query(`update benutzer_rechte set geloescht_am = now() where benutzer_id = (select id from benutzer where benutzername = 'trainer1')`);
    const r = await t.refresh(l.refresh_token);
    expect(r.status).toBe(200);
    const { payload } = await t.pruefe(r.body.access_token);
    expect(payload.rechte).toEqual([]);
    expect(payload.scope).not.toContain('benutzer:schueler');
    await t.pool.query(`update benutzer_vereine set status = 'gesperrt' where benutzer_id = (select id from benutzer where benutzername = 'trainer1')`);
    const g = await t.refresh(r.body.refresh_token);
    expect(g.status).toBe(401);
    expect(g.body.code).toBe('kein_zugang_zum_verein');
  });
});

describe('Logout', () => {
  it('beendet die Anmeldung (Refresh danach 401), idempotent', async () => {
    const l = (await t.login('eltern1')).body;
    expect((await t.api('POST', '/auth/logout', { refresh_token: l.refresh_token })).status).toBe(204);
    expect((await t.refresh(l.refresh_token)).status).toBe(401);
    expect((await t.api('POST', '/auth/logout', { refresh_token: l.refresh_token })).status).toBe(204);
  });

  it('„alle Geräte“ braucht ein Access-Token und beendet alle Anmeldungen', async () => {
    const a = (await t.login('schueler1', { geraet: { typ: 'phone', name: 'Handy' } })).body;
    const b = (await t.login('schueler1', { geraet: { typ: 'tablet' } })).body;
    expect((await t.api('POST', '/auth/logout', { alle_geraete: true })).status).toBe(401);
    expect((await t.api('POST', '/auth/logout', { alle_geraete: true }, a.access_token)).status).toBe(204);
    expect((await t.refresh(a.refresh_token)).status).toBe(401);
    expect((await t.refresh(b.refresh_token)).status).toBe(401);
  });

  it('ohne Angabe: 400', async () => {
    expect((await t.api('POST', '/auth/logout', {})).status).toBe(400);
  });
});

describe('Gerät', () => {
  it('Login mit Gerät registriert es, ein gesperrtes Gerät beendet den Refresh', async () => {
    const l = (await t.login('pruefer1', { geraet: { typ: 'tablet', name: 'Halle 1' } })).body;
    const { payload } = await t.pruefe(l.access_token);
    expect(payload.geraet_id).toBeTruthy();
    await t.pool.query('update geraete set gesperrt = true where id = $1', [payload.geraet_id]);
    const r = await t.refresh(l.refresh_token);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('geraet_gesperrt');
    expect((await t.login('pruefer1', { geraet: { id: payload.geraet_id } })).status).toBe(403);
  });
});

it('Fehlerformat ist problem+json, CORS erlaubt die App-Origins', async () => {
  const r = await t.app.inject({ method: 'POST', url: '/auth/login', payload: {} });
  expect(r.statusCode).toBe(400);
  expect(r.headers['content-type']).toContain('application/problem+json');
  for (const origin of ['https://localhost', 'capacitor://localhost']) {
    const o = await t.app.inject({ method: 'OPTIONS', url: '/auth/login', headers: { origin, 'access-control-request-method': 'POST' } });
    expect(o.headers['access-control-allow-origin']).toBe(origin);
  }
  const fremd = await t.app.inject({ method: 'OPTIONS', url: '/auth/login', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  expect(fremd.headers['access-control-allow-origin']).toBeUndefined();
});
