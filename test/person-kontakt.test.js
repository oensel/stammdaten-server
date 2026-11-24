// Story 3.2 (FR-5, NFR-1): Kontaktdaten an der Person
import { afterEach, beforeEach, expect, it } from 'vitest';
import { gibRolle, verbandsbaum, verbandsToken, verein as neuerVerein } from './fabrik.js';
import { CLIENT, neueApp } from './helper.js';

let t; let jc; let b; let baum; let lena; let uhr;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const tok = async (n) => (await t.login(n, n === 'trainer1' ? { verein_id: jc } : {})).body.access_token;
const uid = async (n) => (await q('select id from benutzer where benutzername = $1', [n]))[0].id;
beforeEach(async () => {
  uhr = new Date();
  t = await neueApp({ uhr: () => uhr });
  baum = await verbandsbaum(t.pool);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  await q('update vereine set verband_id = $2 where id = $1', [jc, baum.kreis]);
  b = await neuerVerein(t.pool, baum.kreis);
  await q(`update anwendungen set scopes = scopes || '{mitglieder:schreiben}' where schluessel = $1 and not scopes @> '{mitglieder:schreiben}'`, [CLIENT]);
  lena = (await q(`update personen set email = 'alt@example.org' where vorname = 'Lena' returning id`))[0].id;
  // Zweitverein B mit eigener Admin (trainer1 ist dort Admin)
  await q(`insert into mitglieder (person_id, verein_id, mitgliedsnr, vorname, nachname) values ($1,$2,1,'x','x')`, [lena, b]);
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'admin','freigegeben')`, [await uid('trainer1'), b]);
});
afterEach(() => t.schliessen());

const imVerein = (method, token, v, payload, ifMatch) => t.app.inject({
  method, url: `/v2/personen/${lena}${method === 'PATCH' ? '/kontakt' : ''}`, payload,
  headers: { authorization: `Bearer ${token}`, ...(v ? { 'x-verein': v } : {}), ...(ifMatch ? { 'if-match': `"${ifMatch}"` } : {}) },
}).then((r) => ({ status: r.statusCode, body: r.json(), etag: r.headers.etag }));
const lesen = (token, v) => imVerein('GET', token, v);
const version = async () => (await q('select change_seq from personen where id = $1', [lena]))[0].change_seq;
const aendern = async (token, v, payload = { email: 'neu@example.org' }, seq) => imVerein('PATCH', token, v, payload, seq ?? await version());

it('der Heimatverein ändert; beide Vereine sehen die Änderung, auch unter /v1', async () => {
  const admin = await tok('admin1');
  const r = await aendern(admin, jc, { email: 'neu@example.org', ort: null });
  expect(r).toMatchObject({ status: 200, body: { email: 'neu@example.org', ort: null } });
  expect(r.etag).toBe(`"${r.body.change_seq}"`);
  expect((await lesen(await tok('trainer1'), b)).body.email).toBe('neu@example.org');
  expect((await q('select distinct email from mitglieder where person_id = $1', [lena]))).toEqual([{ email: 'neu@example.org' }]);
});

it('der andere Verein liest, ändert aber nicht; veralteter Stand wird abgewiesen', async () => {
  const adminB = await tok('trainer1');
  expect((await lesen(adminB, b)).status).toBe(200);
  expect((await aendern(adminB, b)).body).toMatchObject({ status: 422, code: 'feld_nicht_erlaubt' });
  expect((await aendern(await tok('admin1'), jc, undefined, '1')).status).toBe(412);
  expect((await q('select email from personen where id = $1', [lena]))[0].email).toBe('alt@example.org');
});

it('jeder Verein sieht nur seine eigene Mitgliedschaft', async () => {
  const vereine = async (token, v) => (await lesen(token, v)).body.mitgliedschaften.map((m) => m.verein_id);
  expect(await vereine(await tok('admin1'), jc)).toEqual([jc]);
  expect(await vereine(await tok('trainer1'), b)).toEqual([b]);
  expect((await vereine(await tok('schueler1'), jc)).sort()).toEqual([b, jc].sort());
});

it('die Person selbst ändert ab 14, vorher nur lesen; Stammdaten nie', async () => {
  const s = await tok('schueler1');
  await q(`update personen set geburtsdatum = '2014-05-02' where id = $1`, [lena]);
  uhr = new Date('2028-05-01T12:00:00Z');
  expect((await lesen(s)).body.email).toBe('alt@example.org');
  expect((await aendern(s)).status).toBe(422);
  uhr = new Date('2028-05-02T12:00:00Z');
  expect((await aendern(s)).status).toBe(200);
  expect((await aendern(s, null, { vorname: 'Anna' })).status).toBe(400);
  await q('update personen set geburtsdatum = null where id = $1', [lena]);
  expect((await aendern(s)).status).toBe(422);
});

it('Trainer und Verbandsrolle sehen keine Kontaktdaten; Fremde bekommen 404', async () => {
  const trainer = await lesen(await tok('trainer1'), jc);
  expect(trainer.status).toBe(200);
  expect(trainer.body).not.toHaveProperty('email');
  await gibRolle(t.pool, 'pruefer1', 'landesvertreter', baum.lv);
  const lv = await lesen(await verbandsToken(t, 'pruefer1', baum.lv));
  expect(lv.body).toMatchObject({ vorname: 'Lena' });
  for (const f of ['email', 'ort', 'telefon', 'strasse', 'plz', 'land']) expect(lv.body).not.toHaveProperty(f);
  expect((await aendern(await verbandsToken(t, 'pruefer1', baum.lv))).status).toBe(422);
  const fremd = await tok('eltern1');
  await q(`update erziehungsberechtigte set geloescht_am = now()`);
  expect((await lesen(fremd)).status).toBe(404);
  expect((await aendern(fremd)).status).toBe(404);
  await q(`update mitglieder set status = 'ausgetreten' where person_id = $1 and verein_id = $2`, [lena, b]);
  expect((await lesen(await tok('trainer1'), b)).status).toBe(404);
});

it('ein anderer Verein verschafft niemandem den Zugriff der Person selbst', async () => {
  const m = (await q('select id from mitglieder where person_id = $1 and verein_id = $2', [lena, b]))[0].id;
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status, mitglied_id) values ($1,$2,'mitglied','freigegeben',$3)`, [await uid('pruefer1'), b, m]);
  expect((await q('select benutzer_id from personen where id = $1', [lena]))[0].benutzer_id).toBe(await uid('schueler1'));
  await q(`update benutzer_vereine set status = 'gesperrt' where benutzer_id = $1 and verein_id = $2`, [await uid('schueler1'), jc]);
  expect((await q('select benutzer_id from personen where id = $1', [lena]))[0].benutzer_id).toBe(null);
});
