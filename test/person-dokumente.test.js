// Story 3.4 (FR-75): Dokumente der Person
import { afterEach, beforeEach, expect, it } from 'vitest';
import { gibRolle, verbandsbaum, verbandsToken, verein as neuerVerein } from './fabrik.js';
import { CLIENT, neueApp } from './helper.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('bild-1')]);
const PNG2 = Buffer.concat([PNG, Buffer.from('-neu')]);
const PDF = Buffer.from('%PDF-1.7 scan');

let t; let jc; let b; let baum; let lena; let lenaM; let lenaB; let uhr;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const tok = async (n, v) => (await t.login(n, v ? { verein_id: v } : {})).body.access_token;
const uid = async (n) => (await q('select id from benutzer where benutzername = $1', [n]))[0].id;
beforeEach(async () => {
  uhr = new Date();
  t = await neueApp({ uhr: () => uhr });
  baum = await verbandsbaum(t.pool);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  await q('update vereine set verband_id = $2 where id = $1', [jc, baum.kreis]);
  b = await neuerVerein(t.pool, baum.kreis);
  await q(`update anwendungen set scopes = scopes || '{mitglieder:schreiben,mitglieder:kontakt}' where schluessel = $1 and not scopes @> '{mitglieder:schreiben,mitglieder:kontakt}'`, [CLIENT]);
  [{ id: lenaM, person_id: lena }] = await q(`select id, person_id from mitglieder where vorname = 'Lena'`);
  lenaB = (await q(`insert into mitglieder (person_id, verein_id, mitgliedsnr, vorname, nachname) values ($1,$2,1,'x','x') returning id`, [lena, b]))[0].id;
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'admin','freigegeben')`, [await uid('pruefer1'), b]);
});
afterEach(() => t.schliessen());

const roh = (method, url, token, payload, typ = 'application/octet-stream') => t.app.inject({
  method, url, payload, headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': typ } : {}) } });
const ablegen = (token, art, inhalt, typ) => roh('POST', `/v2/personen/${lena}/dokumente?art=${art}`, token, inhalt, typ);
const liste = async (token) => { const r = await roh('GET', `/v2/personen/${lena}/dokumente`, token); return r.statusCode === 200 ? r.json().dokumente.map((d) => d.art).sort() : r.statusCode; };
const abruf = (token, id) => roh('GET', `/v2/personen/${lena}/dokumente/${id}`, token);

it('ein Dokument gehört der Person und wird unverändert ausgeliefert', async () => {
  const admin = await tok('admin1');
  const r = await ablegen(admin, 'bescheinigung', PDF, 'application/pdf');
  expect(r.statusCode).toBe(201);
  expect(r.json()).toMatchObject({ art: 'bescheinigung', mime_typ: 'application/pdf', groesse: PDF.length });
  expect(await q('select person_id, mitglied_id from dokumente')).toEqual([{ person_id: lena, mitglied_id: null }]);
  const d = await abruf(admin, r.json().id);
  expect(d.rawPayload.equals(PDF)).toBe(true);
  expect(d.headers).toMatchObject({ 'content-type': 'application/pdf', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' });
  expect(d.headers['content-disposition']).toMatch(/^attachment/);
});

it('Positivliste: Heimatverein, Person und Zugriff; alle anderen 404', async () => {
  await ablegen(await tok('admin1'), 'scan', PDF);
  const id = (await ablegen(await tok('admin1'), 'vormundschaftsnachweis', PDF)).json().id;
  await ablegen(await tok('admin1'), 'passfoto', PNG);
  const alle = ['passfoto', 'scan', 'vormundschaftsnachweis'];
  for (const n of ['admin1', 'schueler1', 'eltern1']) {
    expect(await liste(await tok(n))).toEqual(alle);
    expect((await abruf(await tok(n), id)).statusCode).toBe(200);
  }
  // Trainer des Heimatvereins: nur das Passfoto
  expect(await liste(await tok('trainer1'))).toEqual(['passfoto']);
  expect((await abruf(await tok('trainer1'), id)).statusCode).toBe(404);
  // Admin des Zweitvereins, Verbandsrolle, Super-Admin ohne Rolle im Heimatverein
  expect(await liste(await tok('pruefer1', b))).toBe(404);
  await gibRolle(t.pool, 'trainer1', 'landesvertreter', baum.lv);
  const lv = await verbandsToken(t, 'trainer1', baum.lv);
  expect(await liste(lv)).toBe(404);
  expect((await abruf(lv, id)).statusCode).toBe(404);
  await q(`update benutzer set ist_super_admin = true where benutzername = 'pruefer1'`);
  expect(await liste(await tok('pruefer1', b))).toBe(404);
  // nach dem Entzug des Zugriffs sofort nicht mehr
  const eltern = await tok('eltern1');
  await q('update personen_zugriffe set widerrufen_am = now()');
  expect(await liste(eltern)).toBe(404);
});

it('hochladen dürfen Heimatverein und Person ab 14; Zugriff und andere nicht', async () => {
  for (const [n, v] of [['eltern1'], ['trainer1'], ['pruefer1', b]]) expect((await ablegen(await tok(n, v), 'scan', PDF)).statusCode).toBe(404);
  const s = await tok('schueler1');
  await q(`update personen set geburtsdatum = '2014-05-02' where id = $1`, [lena]);
  uhr = new Date('2028-05-01T12:00:00Z');
  expect((await ablegen(s, 'scan', PDF)).statusCode).toBe(404);
  uhr = new Date('2028-05-02T12:00:00Z');
  expect((await ablegen(s, 'scan', PDF)).statusCode).toBe(201);
});

it('der Inhalt entscheidet über den Typ; zu große und fremde Dateien werden abgewiesen', async () => {
  const admin = await tok('admin1');
  expect((await ablegen(admin, 'scan', Buffer.from('<script>'), 'image/png')).json().code).toBe('dateityp_ungueltig');
  expect((await ablegen(admin, 'passfoto', PDF)).json().code).toBe('dateityp_ungueltig');
  expect((await ablegen(admin, 'unbekannt', PDF)).statusCode).toBe(400);
  expect((await ablegen(admin, 'scan', Buffer.alloc(11 * 1024 * 1024, 1))).statusCode).toBe(413);
  expect((await roh('POST', `/v2/personen/${lena}/dokumente?art=scan`, admin, '{}', 'application/json')).json().code).toBe('datei_fehlt');
  expect(await q('select 1 from dokumente')).toEqual([]);
});

it('/v1-Passfoto speichert an der Person; /v1 und /v2 sehen dasselbe Foto', async () => {
  const admin = await tok('admin1'); const s = await tok('schueler1');
  expect((await roh('PUT', `/mitglieder/${lenaM}/passfoto`, s, PNG, 'image/png')).statusCode).toBe(200);
  expect(await q('select person_id, mitglied_id from dokumente')).toEqual([{ person_id: lena, mitglied_id: lenaM }]);
  expect((await ablegen(admin, 'passfoto', PNG2)).statusCode).toBe(201);
  expect((await q(`select count(*)::int n from dokumente where geloescht_am is null`))[0].n).toBe(1);
  expect((await roh('GET', `/mitglieder/${lenaM}/passfoto`, s)).rawPayload.equals(PNG2)).toBe(true);
  expect((await roh('DELETE', `/mitglieder/${lenaM}/passfoto`, s)).statusCode).toBe(204);
  expect(await liste(admin)).toEqual([]);
  // zuerst /v2, dann /v1
  expect((await ablegen(admin, 'passfoto', PNG)).statusCode).toBe(201);
  expect((await roh('PUT', `/mitglieder/${lenaM}/passfoto`, s, PNG2, 'image/png')).statusCode).toBe(200);
  expect((await q(`select count(*)::int n from dokumente where geloescht_am is null`))[0].n).toBe(1);
});

it('/v1: der Zweitverein sieht und ändert das Foto nicht; nach einem Wechsel des Heimatvereins bleibt es an der Person', async () => {
  await roh('PUT', `/mitglieder/${lenaM}/passfoto`, await tok('schueler1'), PNG, 'image/png');
  await q(`insert into benutzer_rechte (benutzer_id, verein_id, recht_id) select $1, $2, id from rechte where schluessel = 'trainer'`, [await uid('pruefer1'), b]);
  const adminB = await tok('pruefer1', b);
  expect((await roh('GET', `/mitglieder/${lenaB}/passfoto`, adminB)).statusCode).toBe(404);
  expect((await roh('DELETE', `/mitglieder/${lenaB}/passfoto`, adminB)).statusCode).toBe(404);
  await q('update personen set heimatverein_id = $2 where id = $1', [lena, b]);
  expect((await roh('GET', `/mitglieder/${lenaB}/passfoto`, adminB)).rawPayload.equals(PNG)).toBe(true);
  expect(await liste(await tok('admin1'))).toBe(404);
});
