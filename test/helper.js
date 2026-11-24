import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export const cfgDefault = loadConfig();
export const PW = cfgDefault.demoPasswort;
export const CLIENT = 'kyu-manager-pro';

const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

/** Eigene Datenbank (Klon der Vorlage) + App mit Test-Konfiguration. */
export async function neueApp(overrides = {}) {
  const base = inject('pgBase');
  const name = `t_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query(`create database ${name} template vorlage`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: `${base}/${name}`, max: 5 });
  const app = await buildApp({ pool, issuer: 'http://stammdaten.test', zweiFaktorPflicht: false, ...overrides });
  const api = (method, url, body, token) =>
    app.inject({ method, url, payload: body ?? undefined, headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => ({
      status: r.statusCode, body: r.body ? safeJson(r.body) : null, headers: r.headers,
    }));
  const login = (benutzername, extra = {}, passwort = PW) =>
    api('POST', '/auth/login', { benutzername, passwort, client_id: CLIENT, ...extra });
  const refresh = (refresh_token, client_id = CLIENT) => api('POST', '/oauth/token', { grant_type: 'refresh_token', refresh_token, client_id });
  const pruefe = async (token, audience = CLIENT) => {
    const jwks = (await api('GET', '/.well-known/jwks.json')).body;
    return jwtVerify(token, createLocalJWKSet(jwks), { issuer: 'http://stammdaten.test', audience });
  };
  const schliessen = async () => { await app.close(); await pool.end().catch(() => {}); };
  return { app, pool, api, login, refresh, pruefe, schliessen };
}
