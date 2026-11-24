import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fehler } from '../src/errors.js';
import { systemCtx } from '../src/pipeline/ctx.js';
import { neueApp } from './helper.js';

const JETZT = new Date('2030-01-02T03:04:05Z');
let t; let token; let verein; let uhrAufrufe = 0; let letzterCtx;
beforeAll(async () => {
  t = await neueApp({
    uhr: () => { uhrAufrufe++; return JETZT; },
    v2Routen: [(v2) => {
      v2({ method: 'GET', url: '/probe', handler: (ctx) => { letzterCtx = ctx; return { ok: true }; } });
      v2({ method: 'POST', url: '/probe', status: 201, schema: { body: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } } }, handler: (_c, _db, { body }) => body });
      v2({ method: 'GET', url: '/fachfehler', handler: () => { throw fehler(409, 'Geht nicht', 'geht_nicht'); } });
      v2({ method: 'GET', url: '/dbfehler', handler: (_c, db) => db.query('select * from gibt_es_nicht') });
    }],
  });
  const r = await t.login('admin1');
  token = r.body.access_token; verein = r.body.verein_id;
});
afterAll(() => t.schliessen());
const hole = (url, headers = {}, method = 'GET', payload) =>
  t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, ...headers } });
const problem = (r, status, code) => {
  expect(r.headers['content-type']).toContain('application/problem+json');
  expect(r.json()).toMatchObject({ status, code, type: expect.any(String), title: expect.any(String) });
  expect(r.statusCode).toBe(status);
};

describe('/v2-Pipeline', () => {
  it('übergibt ctx mit genau einem jetzt', async () => {
    uhrAufrufe = 0;
    expect((await hole('/v2/probe')).statusCode).toBe(200);
    expect(uhrAufrufe).toBe(1);
    expect(Object.keys(letzterCtx).sort()).toEqual(['anwendung', 'benutzer', 'jetzt', 'kontext', 'rechte']);
    expect(letzterCtx.jetzt).toBe(JETZT);
    expect(letzterCtx.kontext).toEqual({ art: 'verein', id: verein });
    expect(letzterCtx.anwendung).toBe('kyu-manager-pro');
    expect(letzterCtx.rechte.rolle).toBe('admin');
  });
  it('lädt Rechte frisch: Widerruf wirkt vor Ablauf des Tokens', async () => {
    const u = letzterCtx.benutzer.id;
    await t.pool.query(`update benutzer_vereine set rolle = 'mitglied' where benutzer_id = $1`, [u]);
    await hole('/v2/probe');
    expect(letzterCtx.rechte.rolle).toBe('mitglied');
    await t.pool.query(`update benutzer_vereine set rolle = 'admin' where benutzer_id = $1`, [u]);
  });
  it('X-Verein: eigener Verein ja, fremder 404, ungültiger 400', async () => {
    expect((await hole('/v2/probe', { 'x-verein': verein })).statusCode).toBe(200);
    problem(await hole('/v2/probe', { 'x-verein': '00000000-0000-4000-8000-000000000000' }), 404, 'nicht_gefunden');
    problem(await hole('/v2/probe', { 'x-verein': 'x' }), 400, 'ungueltige_anfrage');
  });
  it('gibt jeden Fehler als Problem-JSON mit stabilem code aus', async () => {
    problem(await t.app.inject({ method: 'GET', url: '/v2/probe' }), 401, 'nicht_angemeldet');
    problem(await hole('/v2/probe', {}, 'POST', {}), 400, 'ungueltige_anfrage');
    problem(await hole('/v2/probe', { 'content-type': 'application/json' }, 'POST', '{kaputt'), 400, 'ungueltige_anfrage');
    problem(await hole('/v2/probe', { 'content-type': 'text/xml' }, 'POST', '<a/>'), 415, 'medientyp_nicht_unterstuetzt');
    problem(await hole('/v2/fachfehler'), 409, 'geht_nicht');
    const db = await hole('/v2/dbfehler');
    problem(db, 500, 'interner_fehler');
    expect(db.body).not.toContain('gibt_es_nicht');
    problem(await hole('/v2/nirgends'), 404, 'nicht_gefunden');
  });
  it('setzt den Erfolgsstatus der Route', async () => {
    expect((await hole('/v2/probe', {}, 'POST', { a: 'b' })).statusCode).toBe(201);
  });
});

describe('systemCtx', () => {
  it('hat keinen Benutzer, den Systemnamen und eine setzbare Zeit', () => {
    expect(systemCtx('probe', { jetzt: JETZT })).toMatchObject({ benutzer: null, kontext: null, anwendung: 'system:probe', jetzt: JETZT });
    expect(systemCtx('probe').jetzt).toBeInstanceOf(Date);
  });
});
