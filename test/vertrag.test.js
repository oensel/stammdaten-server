// Vertragstest: hält Form und Typen der eingefrorenen Antworten und Token-Claims fest (test/vertrag/form.json).
// Ein Unterschied heißt: Vertrag verletzt. form.json nur bewusst ändern: `VERTRAG_SCHREIBEN=1 npx vitest run test/vertrag.test.js`.
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLIENT, cfgDefault, neueApp } from './helper.js';

const DATEI = path.resolve(import.meta.dirname, 'vertrag', 'form.json');
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Form eines Werts: Feldname → Typ; UUID-Schlüssel (Maps) werden zu "*", Listen zur Form ihrer verschiedenen Elemente. */
function form(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return [...new Set(v.map((x) => JSON.stringify(form(x))))].sort().map((x) => JSON.parse(x));
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [UUID.test(k) ? '*' : k, form(v[k])]));
  if (typeof v === 'string') return UUID.test(v) ? 'uuid' : /^\d{4}-\d{2}-\d{2}T/.test(v) ? 'zeitpunkt' : /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'datum' : 'text';
  return typeof v === 'number' ? 'zahl' : typeof v;
}
const teil = (jwt, i) => JSON.parse(Buffer.from(jwt.split('.')[i], 'base64url').toString());

let t; let empfaenger; const logout = [];
beforeAll(async () => {
  t = await neueApp({ backchannelWartenMs: [0] });
  empfaenger = http.createServer((req, res) => {
    let d = ''; req.on('data', (c) => { d += c; });
    req.on('end', () => { logout.push(JSON.parse(d)); res.end(); });
  });
  await new Promise((r) => empfaenger.listen(0, '127.0.0.1', r));
  await t.pool.query(`update anwendungen set backchannel_url = $1 where schluessel = $2`, [`http://127.0.0.1:${empfaenger.address().port}/`, CLIENT]);
});
afterAll(async () => { await t.schliessen(); await new Promise((r) => empfaenger.close(r)); });

it('Antworten und Claims entsprechen dem Vertrag', async () => {
  const ist = {};
  const halte = (name, r) => { ist[name] = { status: r.status ?? r.statusCode, form: form(r.body) }; return r; };
  const claims = (name, jwt) => { ist[name] = { kopf: form(teil(jwt, 0)), claims: form(teil(jwt, 1)) }; };

  const verein = (await t.pool.query(`select id from vereine where name = 'JC Demo'`)).rows[0].id;
  const mitglied = (await t.pool.query('select id from mitglieder where verein_id = $1 and mitgliedsnr = 1', [verein])).rows[0].id;

  for (const name of ['admin1', 'trainer1', 'schueler1', 'eltern1']) {
    const l = halte(`POST /auth/login ${name}`, await t.login(name));
    claims(`Access-Token ${name}`, l.body.access_token);
    halte(`GET /ich ${name}`, await t.api('GET', '/ich', null, l.body.access_token));
  }
  const l = await t.login('admin1');
  const neu = halte('POST /oauth/token refresh_token', await t.refresh(l.body.refresh_token));
  claims('Access-Token nach Refresh', neu.body.access_token);
  const admin = neu.body.access_token;
  halte('GET /mitglieder', await t.api('GET', '/mitglieder', null, admin));
  halte('GET /mitglieder/:id', await t.api('GET', `/mitglieder/${mitglied}`, null, admin));
  halte('POST /auth/verein-wechseln', await t.api('POST', '/auth/verein-wechseln', { verein_id: verein }, admin));

  const geraet = halte('POST /auth/login Gerät', await t.login('admin1', { geraet: { typ: 'tablet', name: 'T' }, geraet_token: true }));
  claims('Access-Token Gerät', geraet.body.access_token);

  const cc = halte('POST /oauth/token client_credentials', await t.api('POST', '/oauth/token',
    { grant_type: 'client_credentials', client_id: CLIENT, client_secret: cfgDefault.demoClientSecret }));
  claims('Client-Token', cc.body.access_token);
  const app = cc.body.access_token;
  halte('POST /v1/graduierungen', await t.api('POST', '/v1/graduierungen', { verein_id: verein, mitglied_id: mitglied, art: 'kyu', stufe: 5, datum: '2025-03-01' }, app));
  await t.pool.query(`insert into lizenzen (verein_id, mitglied_id, art, nummer) values ($1,$2,'judopass','J-1')`, [verein, mitglied]);
  halte('GET /v1/abgleich', await t.api('GET', `/v1/abgleich?verein_id=${verein}`, null, app));
  halte('GET /v1/anwendungen', await t.api('GET', '/v1/anwendungen'));

  halte('Fehler 401', await t.api('GET', '/ich'));
  halte('Fehler 403', await t.api('GET', `/v1/abgleich?verein_id=${verein}`, null, admin));

  const web = await t.login('admin1', { client_typ: 'web' });
  halte('POST /auth/login web', web);
  const cookie = /sd_refresh=([^;]*)/.exec(web.headers['set-cookie'])[1];
  await t.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: `sd_refresh=${cookie}` } });
  await t.app.backchannelFertig();
  expect(logout).toHaveLength(1);
  claims('Logout-Token', logout[0].logout_token);

  if (process.env.VERTRAG_SCHREIBEN) await writeFile(DATEI, `${JSON.stringify(ist, null, 1)}\n`);
  expect(ist).toEqual(JSON.parse(await readFile(DATEI, 'utf8')));
});

// nach dem Formvergleich, weil dieser Test Daten anlegt
it('Fehlercodes, Werte und DELETE entsprechen dem Vertrag', async () => {
  const verein = (await t.pool.query(`select id from vereine where name = 'JC Demo'`)).rows[0].id;
  const mitglied = (await t.pool.query('select id from mitglieder where verein_id = $1 and mitgliedsnr = 2', [verein])).rows[0].id;
  const l = (await t.login('trainer1')).body;
  expect(l).toMatchObject({ token_type: 'Bearer', expires_in: 600 });
  const c = teil(l.access_token, 1);
  expect(c).toMatchObject({ iss: 'http://stammdaten.test', azp: CLIENT, rolle: 'mitglied', rechte: ['trainer'], verein_id: verein, super_admin: false });
  expect(Object.keys(c.vereine)).toEqual([verein]);
  expect(c.scope.split(' ')).toEqual(expect.arrayContaining(['mitglieder:lesen', 'benutzer:schueler']));
  expect(teil(l.access_token, 0)).toMatchObject({ alg: 'EdDSA' });

  const app = (await t.api('POST', '/oauth/token', { grant_type: 'client_credentials', client_id: CLIENT, client_secret: cfgDefault.demoClientSecret })).body.access_token;
  const post = (x) => t.api('POST', '/v1/graduierungen', { verein_id: verein, mitglied_id: mitglied, art: 'kyu', stufe: 7, datum: '2025-03-01', ...x }, app);
  const code = async (r, status, erwartet) => expect({ status: (await r).status, code: (await r).body.code }).toEqual({ status, code: erwartet });
  const { id } = (await post()).body;
  expect((await post()).status).toBe(200);
  await code(post({ stufe: 10 }), 400, 'stufe_ungueltig');
  await code(post({ mitglied_id: verein }), 404, 'mitglied_unbekannt');
  expect((await t.api('DELETE', `/v1/graduierungen/${id}?verein_id=${verein}`, null, app)).status).toBe(204);
  await code(t.api('DELETE', `/v1/graduierungen/${verein}?verein_id=${verein}`, null, app), 404, 'graduierung_unbekannt');
  await code(t.api('GET', `/v1/abgleich?verein_id=${verein}&seit=kaputt`, null, app), 409, 'abgleich_neu_starten');
  await code(t.api('GET', `/v1/abgleich?verein_id=${mitglied}`, null, app), 403, 'verein_nicht_freigegeben');
  await code(t.api('GET', `/v1/abgleich?verein_id=${verein}`, null, l.access_token), 403, 'nur_anwendung');
  await code(t.login('trainer1', {}, 'falsch-falsch'), 401, 'anmeldung_fehlgeschlagen');
  await code(t.refresh('x'.repeat(43)), 401, 'ungueltiges_token');
});
