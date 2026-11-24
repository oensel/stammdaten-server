// Story 3.1 (FR-4, NFR-19): Person mit erster Mitgliedschaft
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { verbandsbaum, verein as neuerVerein } from './fabrik.js';
import { CLIENT, neueApp } from './helper.js';

let t; let jc; let baum; let admin;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const tok = async (n) => (await t.login(n)).body.access_token;
beforeEach(async () => {
  t = await neueApp();
  baum = await verbandsbaum(t.pool);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  await q('update vereine set verband_id = $2 where id = $1', [jc, baum.kreis]);
  await q(`update anwendungen set scopes = scopes || '{mitglieder:schreiben}' where schluessel = $1 and not scopes @> '{mitglieder:schreiben}'`, [CLIENT]);
  admin = await tok('admin1');
});
afterEach(() => t.schliessen());

const PERSON = { vorname: 'Mia', nachname: 'Neu', geburtsdatum: '2015-03-04', email: 'mia@example.org', ort: 'Köln' };
const anlegen = (body = { person: PERSON }, token = admin, verein = jc) => t.api('POST', `/v2/vereine/${verein}/mitglieder`, body, token);
const anzahl = async () => (await q('select (select count(*)::int from personen) p, (select count(*)::int from mitglieder) m'))[0];

it('Person und Mitgliedschaft entstehen getrennt, der Verein ist Heimatverein', async () => {
  const max = (await q('select max(mitgliedsnr) n from mitglieder where verein_id = $1', [jc]))[0].n;
  const r = await anlegen({ person: PERSON, eintritt: '2026-01-01' });
  expect(r).toMatchObject({ status: 201, body: { heimatverein_id: jc, mitgliedschaft: { mitgliedsnr: max + 1, status: 'aktiv', eintritt: '2026-01-01' } } });
  expect(r.body.person_id).not.toBe(r.body.mitgliedschaft.id);
  expect(await q('select vorname, email, land, heimatverein_id from personen where id = $1', [r.body.person_id])).toEqual([
    { vorname: 'Mia', email: 'mia@example.org', land: 'DE', heimatverein_id: jc }]);
  expect(await q('select person_id, vorname, email, geburtsdatum from mitglieder where id = $1', [r.body.mitgliedschaft.id])).toEqual([
    { person_id: r.body.person_id, vorname: 'Mia', email: 'mia@example.org', geburtsdatum: '2015-03-04' }]);
  expect((await t.api('GET', `/mitglieder/${r.body.mitgliedschaft.id}`, null, admin)).body).toMatchObject({ vorname: 'Mia', mitgliedsnr: max + 1 });
});

it('gleichzeitige Anlagen, auch neben einem Import, erhalten verschiedene Nummern', async () => {
  const payload = 'ID;Vorname;Nachname\nX1;Im;Port\n';
  const importe = t.app.inject({ method: 'POST', url: '/mitglieder/import', payload, headers: { authorization: `Bearer ${admin}`, 'content-type': 'text/csv' } }).then((r) => r);
  const rs = await Promise.all(Array.from({ length: 8 }, () => anlegen()));
  expect((await importe).statusCode).toBe(200);
  expect(rs.map((r) => r.status)).toEqual(Array(8).fill(201));
  expect(new Set(rs.map((r) => r.body.mitgliedschaft.mitgliedsnr)).size).toBe(8);
});

it('Judopass-ID: normale Anlage, Hinweis gespeichert, Aufgabe beim LV; ohne ID keine Aufgabe', async () => {
  await anlegen();
  expect(await q('select 1 from aufgaben')).toEqual([]);
  const r = await anlegen({ person: PERSON, judopass_id: 'NW-123' });
  expect(r.status).toBe(201);
  expect(JSON.stringify(r.body)).not.toContain('NW-123');
  expect(await q('select a.art, a.status, a.verband_id, p.judopass_hinweis from aufgaben a join personen p on p.id = a.person_id')).toEqual([
    { art: 'person_zusammenfuehren', status: 'offen', verband_id: baum.lv, judopass_hinweis: 'NW-123' }]);
});

it('ohne Recht, im fremden Verein oder ohne App-Scope: 404 und nichts entsteht', async () => {
  const vorher = await anzahl();
  for (const n of ['trainer1', 'schueler1']) expect((await anlegen(undefined, await tok(n))).status).toBe(404);
  expect((await anlegen(undefined, admin, await neuerVerein(t.pool, baum.kreis))).status).toBe(404);
  await q(`update anwendungen set scopes = array_remove(scopes, 'mitglieder:schreiben') where schluessel = $1`, [CLIENT]);
  expect((await anlegen()).status).toBe(404);
  expect(await anzahl()).toEqual(vorher);
});

it('ungültige Angaben und aufgelöster Verein werden abgewiesen, ohne halbe Anlage', async () => {
  const vorher = await anzahl();
  expect((await anlegen({ person: { vorname: 'A', nachname: 'B' } })).status).toBe(400);
  expect((await anlegen({ person: { ...PERSON, geburtsdatum: '2999-01-01' } })).body.code).toBe('geburtsdatum_ungueltig');
  await q(`update vereine set aufgeloest_am = '2020-01-01' where id = $1`, [jc]);
  expect((await anlegen()).body.code).toBe('verein_aufgeloest');
  expect(await anzahl()).toEqual(vorher);
});

it('eine Person ohne Mitgliedschaft im Heimatverein ist nicht speicherbar', async () => {
  const verstoss = { constraint: 'person_braucht_mitgliedschaft' };
  await expect(q(`insert into personen (vorname, nachname, heimatverein_id) values ('O','M',$1)`, [jc])).rejects.toMatchObject(verstoss);
  const { person_id } = (await anlegen()).body;
  await expect(q('update personen set heimatverein_id = $2 where id = $1', [person_id, baum.verein])).rejects.toMatchObject(verstoss);
});

it('Altweg und Person bleiben gleich; nur der Heimatverein ändert über den Altweg', async () => {
  const { person_id, mitgliedschaft: { id } } = (await anlegen()).body;
  const [zweit] = await q(`insert into mitglieder (person_id, verein_id, mitgliedsnr, vorname, nachname) values ($1,$2,1,'falsch','falsch') returning id, vorname`, [person_id, baum.verein]);
  expect(zweit.vorname).toBe('Mia');
  const namen = async () => [...await q('select vorname from personen where id = $1', [person_id]), ...await q('select vorname from mitglieder where person_id = $1', [person_id])].map((x) => x.vorname);
  await q(`update mitglieder set vorname = 'Maja' where id = $1`, [id]);
  expect(await namen()).toEqual(['Maja', 'Maja', 'Maja']);
  await q(`update mitglieder set vorname = 'Fremd' where id = $1`, [zweit.id]);
  expect(await namen()).toEqual(['Maja', 'Maja', 'Maja']);
  await q(`update personen set vorname = 'Mara' where id = $1`, [person_id]);
  expect(await namen()).toEqual(['Mara', 'Mara', 'Mara']);
  const seq = async () => (await q('select change_seq from mitglieder where id = $1', [id]))[0].change_seq;
  const vorher = await seq();
  await q('update personen set judopass_hinweis = null where id = $1', [person_id]);
  expect(await seq()).toBe(vorher); // kein unnötiger Abgleich
});

it('Bestand: Migration 025 legt je Mitglied eine Person an und lässt change_xid stehen', async () => {
  const bild = 'select id, change_seq, change_xid::text from mitglieder order by id';
  const c = await t.pool.connect();
  try {
    await c.query('begin');
    await c.query(`drop trigger mitglied_person on mitglieder; drop trigger mitglied_an_person on mitglieder; drop table aufgaben;
      alter table personen drop constraint person_braucht_mitgliedschaft; alter table mitglieder drop column person_id; drop table personen;
      drop function mitglied_person, mitglied_an_person, person_an_mitglieder`);
    const vorher = (await c.query(bild)).rows;
    expect(vorher.length).toBeGreaterThan(0);
    await c.query(await readFile('db/migrations/025_personen.sql', 'utf8'));
    expect((await c.query(bild)).rows).toEqual(vorher);
    const { rows: [{ n }] } = await c.query(`select count(*)::int n from mitglieder m join personen p on p.id = m.person_id and p.heimatverein_id = m.verein_id and p.vorname = m.vorname`);
    expect(n).toBe(vorher.length);
    await c.query('set constraints all immediate');
  } finally {
    await c.query('rollback');
    c.release();
  }
});
