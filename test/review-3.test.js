// Review-Befunde 23–26 (niedrig): QR bei aufgelöstem Verein, Groß-UUIDs, NUL-Zeichen, QR-Limit parallel
import { afterAll, beforeAll, expect, it } from 'vitest';
import { neueApp, PW } from './helper.js';

let t; let verein; let admin;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
beforeAll(async () => {
  t = await neueApp();
  verein = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  admin = (await t.login('admin1')).body.access_token;
});
afterAll(() => t.schliessen());

const registriere = (token, benutzername, extra = {}) => t.api('POST', '/v2/auth/registrieren', { token, benutzername, vorname: 'Nora', nachname: 'Neu', passwort: PW, ...extra });
const neuerCode = async () => (await t.api('POST', `/v2/vereine/${verein}/qr-codes`, {}, admin)).body.token;

it('23: der QR-Code eines aufgelösten Vereins gilt nicht mehr', async () => {
  const c = await neuerCode();
  await q(`update vereine set aufgeloest_am = '2020-01-01' where id = $1`, [verein]);
  expect((await registriere(c, 'spaet')).status).toBe(404);
  expect((await t.api('POST', `/v2/vereine/${verein}/qr-codes`, {}, admin)).body).toMatchObject({ status: 409, code: 'verein_aufgeloest' });
  expect(await q(`select 1 from benutzer where benutzername = 'spaet'`)).toEqual([]);
});

it('24: UUIDs in Großbuchstaben bezeichnen dieselbe ID', async () => {
  const frisch = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  await q('update vereine set aufgeloest_am = null where id = $1', [frisch]);
  const r = await t.api('GET', `/v2/vereine/${frisch.toUpperCase()}`, null, admin);
  expect(r.status).toBe(200);
  expect(r.body.id).toBe(frisch);
});

it('24: ein Passwort in UUID-Form bleibt unverändert', async () => {
  const passwort = 'ABCDEFAB-1234-1234-1234-ABCDEFABCDEF';
  expect((await registriere(await neuerCode(), 'uuidpw', { passwort })).status).toBe(201);
  await q(`update benutzer_vereine set status = 'freigegeben' where benutzer_id = (select id from benutzer where benutzername = 'uuidpw')`);
  expect((await t.login('uuidpw', {}, passwort)).status).toBe(200);
});

it('25: NUL-Zeichen sind eine fehlerhafte Eingabe (400), kein Serverfehler', async () => {
  const c = await neuerCode();
  expect((await registriere(c, 'nul1', { vorname: 'a\u0000' })).status).toBe(400);
});

it('26: parallele Anfragen überschreiten das Limit offener Anfragen nicht', async () => {
  const codes = await Promise.all([1, 2, 3, 4].map(neuerCode)); // je Code eine eigene Zeilensperre: nur die Vereinssperre hält das Limit
  await q(`insert into benutzer (benutzername, passwort_hash) select 'fuell' || g, 'x' from generate_series(1, 98) g`);
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, status) select id, $1, 'angefragt' from benutzer where benutzername like 'fuell%'`, [verein]);
  const rs = await Promise.all(['paral1', 'paral2', 'paral3', 'paral4'].map((n, i) => registriere(codes[i], n)));
  expect(rs.map((r) => r.status).sort()).toEqual([201, 201, 429, 429]);
  expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
  expect(rs.filter((r) => r.status === 429)).toHaveLength(2);
});

it('28: /v2/ich nennt keine Rechte, die die App-Obergrenze verbietet', async () => {
  const vorher = (await t.api('GET', '/v2/ich', null, admin)).body.berechtigungen;
  expect(vorher).toContain('zugehoerigkeit:AENDERN');
  await q(`update anwendungen set client_scopes = '{}', scopes = array_remove(scopes, 'benutzer:verwalten') where schluessel = 'kyu-manager-pro'`);
  const nachher = (await t.api('GET', '/v2/ich', null, admin)).body.berechtigungen;
  expect(nachher).not.toContain('zugehoerigkeit:AENDERN');
  expect(nachher).toContain('verbandsbaum:LESEN'); // Basisrechte bleiben
});
