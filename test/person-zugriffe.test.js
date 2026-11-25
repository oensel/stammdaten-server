// Story 3.3 (FR-17, FR-18): Zugriffe auf eine Person
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { gibRolle, verbandsbaum, verbandsToken, verein as neuerVerein } from './fabrik.js';
import { CLIENT, neueApp } from './helper.js';

let t; let jc; let baum; let lena; let uhr; let id;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const tok = async (n) => (await t.login(n)).body.access_token;
beforeEach(async () => {
  uhr = new Date();
  t = await neueApp({ uhr: () => uhr });
  baum = await verbandsbaum(t.pool);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  await q('update vereine set verband_id = $2 where id = $1', [jc, baum.kreis]);
  await q(`update anwendungen set scopes = scopes || '{mitglieder:schreiben,mitglieder:kontakt}' where schluessel = $1 and not scopes @> '{mitglieder:schreiben,mitglieder:kontakt}'`, [CLIENT]);
  lena = (await q(`select id from personen where vorname = 'Lena'`))[0].id;
  id = Object.fromEntries((await q('select benutzername, id from benutzer')).map((b) => [b.benutzername, b.id]));
  // oma gehört nur zu einem fremden Verein
  const fremd = await neuerVerein(t.pool, baum.kreis);
  id.oma = (await q(`insert into benutzer (benutzername, passwort_hash) select 'oma', passwort_hash from benutzer where benutzername = 'eltern1' returning id`))[0].id;
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'mitglied','freigegeben')`, [id.oma, fremd]);
});
afterEach(() => t.schliessen());

const url = (x = '') => `/v2/personen/${lena}${x}`;
const erteile = async (wer, an, extra = {}) => t.api('POST', url('/zugriffe'), { benutzer_id: id[an], art: 'bevollmaechtigt', umfang: 'lesen', ...extra }, await tok(wer));
const lesen = async (wer) => t.api('GET', url(), null, await tok(wer));
const entziehe = async (wer, z) => t.api('DELETE', url(`/zugriffe/${z}`), null, await tok(wer));
const kontakt = async (wer) => {
  const token = await tok(wer);
  const [{ change_seq }] = await q('select change_seq from personen where id = $1', [lena]);
  const r = await t.app.inject({ method: 'PATCH', url: url('/kontakt'), payload: { telefon: '0221 1' }, headers: { authorization: `Bearer ${token}`, 'if-match': `"${change_seq}"` } });
  return r.statusCode;
};
const elternZugriff = async () => (await q('select id from personen_zugriffe where person_id = $1 and benutzer_id = $2 and widerrufen_am is null', [lena, id.eltern1]))[0]?.id;

it('Bestand: Eltern haben Zugriff, lesen alles und ändern nur Kontaktdaten', async () => {
  // Demo-Daten entstehen nach der Migration: wie der Altweg eingetragen, der Zugriff selbst kommt vom Heimatverein
  if (!await elternZugriff()) expect((await erteile('admin1', 'eltern1', { art: 'erziehungsberechtigt', umfang: 'aendern' })).status).toBe(201);
  const r = await lesen('eltern1');
  expect(r.body).toMatchObject({ vorname: 'Lena', mitgliedschaften: [{ verein_id: jc }] });
  expect(r.body).toHaveProperty('email');
  expect(await kontakt('eltern1')).toBe(200);
});

it('ein Benutzer in einem fremden Vereinskontext sieht die Person mit Zugriff; nach dem Entzug sofort nicht mehr', async () => {
  expect((await lesen('oma')).status).toBe(404);
  const r = await erteile('admin1', 'oma', { umfang: 'aendern' });
  expect(r.status).toBe(201);
  const token = await tok('oma');
  expect((await t.api('GET', url(), null, token)).status).toBe(200);
  expect(await kontakt('oma')).toBe(200);
  const meine = (await t.api('GET', '/v2/ich/personen', null, token)).body.personen;
  expect(meine).toMatchObject([{ id: lena, selbst: false, zugriff: { art: 'bevollmaechtigt', umfang: 'aendern' } }]);
  expect((await entziehe('admin1', r.body.id)).status).toBe(200);
  expect((await t.api('GET', url(), null, token)).status).toBe(404);
  expect((await t.api('GET', '/v2/ich/personen', null, token)).body.personen).toEqual([]);
  expect(await q(`select aktion, benutzer_id from audit_log where objekt_art = 'personen_zugriff' order by zeitpunkt, aktion desc`)).toEqual([
    { aktion: 'recht_vergeben', benutzer_id: id.admin1 }, { aktion: 'recht_entzogen', benutzer_id: id.admin1 }]);
});

it('Eltern geben Dritten nur Lesezugriff; der andere Erziehungsberechtigte wird benachrichtigt', async () => {
  if (!await elternZugriff()) await erteile('admin1', 'eltern1', { art: 'erziehungsberechtigt', umfang: 'aendern' });
  expect((await erteile('admin1', 'pruefer1', { art: 'erziehungsberechtigt', umfang: 'aendern' })).status).toBe(201);
  await q('delete from nachrichten');
  expect((await erteile('eltern1', 'oma', { umfang: 'aendern' })).body.code).toBe('nur_lesezugriff');
  expect((await erteile('eltern1', 'oma', { art: 'erziehungsberechtigt' })).body.code).toBe('nur_lesezugriff');
  const r = await erteile('eltern1', 'oma');
  expect(r.status).toBe(201);
  expect(await q('select benutzer_id from nachrichten')).toEqual([{ benutzer_id: id.pruefer1 }]);
  expect((await lesen('oma')).status).toBe(200);
  expect(await kontakt('oma')).toBe(422);
  expect((await erteile('oma', 'trainer1')).status).toBe(404);
  // Eltern beenden den Zugriff Dritter, nicht den des anderen Elternteils
  const anderer = (await q('select id from personen_zugriffe where benutzer_id = $1', [id.pruefer1]))[0].id;
  expect((await entziehe('eltern1', anderer)).status).toBe(404);
  expect((await entziehe('eltern1', r.body.id)).status).toBe(200);
});

it('ohne Geburtsdatum, doppelt, an sich selbst, an die Person oder unbekannt: abgewiesen', async () => {
  expect((await erteile('admin1', 'admin1')).body.code).toBe('selbsterteilung');
  expect((await erteile('admin1', 'schueler1')).body.code).toBe('zugriff_selbst');
  expect((await erteile('admin1', 'oma')).status).toBe(201);
  expect((await erteile('admin1', 'oma')).body.code).toBe('zugriff_vorhanden');
  expect((await erteile('admin1', 'oma', { benutzer_id: baum.lv })).body.code).toBe('benutzer_unbekannt');
  await q(`update personen set geburtsdatum = current_date - 4000 where vorname = 'Thomas'`);
  expect((await erteile('admin1', 'trainer1')).body.code).toBe('berechtigter_minderjaehrig');
  await q('update personen set geburtsdatum = null where id = $1', [lena]);
  expect((await erteile('admin1', 'pruefer1')).body.code).toBe('geburtsdatum_fehlt');
});

it('Trainer, Kind, Verbandsrolle, anderer Verein: kein Erteilen und kein Entziehen', async () => {
  const z = (await erteile('admin1', 'oma')).body.id;
  for (const wer of ['trainer1', 'schueler1']) {
    expect((await erteile(wer, 'pruefer1')).status).toBe(404);
    expect((await entziehe(wer, z)).status).toBe(404);
    expect((await t.api('GET', url('/zugriffe'), null, await tok(wer))).status).toBe(404);
  }
  await gibRolle(t.pool, 'pruefer1', 'landesvertreter', baum.lv);
  const lv = await verbandsToken(t, 'pruefer1', baum.lv);
  expect((await t.api('POST', url('/zugriffe'), { benutzer_id: id.trainer1, art: 'bevollmaechtigt', umfang: 'lesen' }, lv)).status).toBe(404);
  expect((await t.api('DELETE', url(`/zugriffe/${z}`), null, lv)).status).toBe(404);
  await q(`update benutzer_vereine set rolle = 'admin' where benutzer_id = $1`, [id.oma]);
  expect((await erteile('oma', 'pruefer1')).status).toBe(404);
  expect((await entziehe('oma', z)).status).toBe(200); // den eigenen Zugriff beendet jeder selbst
});

it('ab 18 ruht jeder Zugriff; die volljährige Person erteilt für ein Jahr', async () => {
  await erteile('admin1', 'oma');
  await q(`update personen set geburtsdatum = '2008-01-15' where id = $1`, [lena]);
  uhr = new Date('2026-01-14T12:00:00Z');
  expect((await lesen('oma')).status).toBe(200);
  expect((await erteile('schueler1', 'eltern1')).status).toBe(404);
  uhr = new Date('2026-01-15T12:00:00Z');
  expect((await lesen('oma')).status).toBe(404);
  await q('delete from personen_zugriffe where benutzer_id = $1', [id.eltern1]);
  const r = await erteile('schueler1', 'eltern1', { umfang: 'aendern' });
  expect(r).toMatchObject({ status: 201, body: { freigeschaltet_bis: '2027-01-15' } });
  expect((await lesen('eltern1')).status).toBe(200);
  uhr = new Date('2027-01-16T12:00:00Z');
  expect((await lesen('eltern1')).status).toBe(404);
});

it('Widerruf und Altweg (/v1) laufen nicht auseinander', async () => {
  if (!await elternZugriff()) await erteile('admin1', 'eltern1', { art: 'erziehungsberechtigt', umfang: 'aendern' });
  const kinder = async () => (await t.login('eltern1')).body.benutzer.vereine[0].mitglied_ids.length;
  const vorher = await kinder();
  expect((await entziehe('admin1', await elternZugriff())).status).toBe(200);
  expect(await kinder()).toBe(vorher - 1);
  await q('update erziehungsberechtigte set geloescht_am = null');
  await erteile('admin1', 'eltern1', { art: 'erziehungsberechtigt', umfang: 'aendern' });
  await q('update erziehungsberechtigte set geloescht_am = now()');
  expect(await elternZugriff()).toBe(undefined);
});

it('Apps ohne Kontakt- und Schreib-Scope bekommen keine Kontaktdaten und ändern keine Zugriffe', async () => {
  const z = (await erteile('admin1', 'oma')).body.id;
  await q(`update anwendungen set scopes = array_remove(array_remove(scopes, 'mitglieder:kontakt'), 'mitglieder:schreiben') where schluessel = $1`, [CLIENT]);
  for (const wer of ['admin1', 'oma', 'schueler1']) {
    const r = await lesen(wer);
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('email');
    expect(r.body).not.toHaveProperty('strasse');
  }
  expect((await erteile('admin1', 'pruefer1')).status).toBe(404);
  expect((await entziehe('oma', z)).status).toBe(404);
});

it('am Gerät (PIN) wirken weder Zugriff noch eigene Person', async () => {
  await erteile('admin1', 'oma');
  const { body } = await t.login('oma', { geraet: { typ: 'tablet' }, geraet_token: true });
  expect(body.geraet_id).toBeTruthy();
  expect((await t.api('GET', url(), null, body.access_token)).status).toBe(404);
  expect((await t.api('GET', '/v2/ich/personen', null, body.access_token)).body.personen).toEqual([]);
});

it('Migration 029 widerruft übernommene Zugriffe ohne freigegebene Zugehörigkeit', async () => {
  await q('delete from personen_zugriffe');
  await q(`insert into personen_zugriffe (person_id, benutzer_id, art, umfang, erteilt_am) values ($1,$2,'erziehungsberechtigt','aendern',now()), ($1,$3,'erziehungsberechtigt','aendern',now())`, [lena, id.eltern1, id.oma]);
  const sql = await readFile('db/migrations/029_review_2_5_bis_3_4.sql', 'utf8');
  await q(sql.slice(sql.indexOf('update personen_zugriffe')));
  expect(await q('select benutzer_id from personen_zugriffe where widerrufen_am is null')).toEqual([{ benutzer_id: id.eltern1 }]);
});

it('Migration 027 übernimmt Eltern aus dem Altweg nur vom Heimatverein und nur mit Geburtsdatum', async () => {
  const soll = (await q('select count(*)::int n from erziehungsberechtigte'))[0].n;
  expect(soll).toBeGreaterThan(1);
  await q('update personen set geburtsdatum = null where id = $1', [lena]);
  const c = await t.pool.connect();
  try {
    await c.query('begin');
    await c.query(`drop trigger v1_an_zugriff on erziehungsberechtigte; drop table personen_zugriffe cascade;
      drop function zugriff_pruefen, zugriff_an_v1, v1_an_zugriff`);
    await c.query(await readFile('db/migrations/027_personen_zugriffe.sql', 'utf8'));
    const { rows } = await c.query('select person_id, benutzer_id, art, umfang from personen_zugriffe');
    expect(rows).toHaveLength(soll - 1);
    expect(rows.some((r) => r.person_id === lena)).toBe(false);
    expect(rows[0]).toMatchObject({ benutzer_id: id.eltern1, art: 'erziehungsberechtigt', umfang: 'aendern' });
  } finally {
    await c.query('rollback');
    c.release();
  }
});
