// Story 3.6 (FR-7, E70, E100): Mitgliedschaftsantrag
import { afterEach, beforeEach, expect, it } from 'vitest';
import { verbandsbaum, verein as neuerVerein } from './fabrik.js';
import { CLIENT, neueApp } from './helper.js';
import { fuehreAus } from '../src/worker.js';

let t; let jc; let b; let baum; let lena; let uhr; let id; let dob;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const tok = async (n, v) => (await t.login(n, v ? { verein_id: v } : {})).body.access_token;
beforeEach(async () => {
  uhr = new Date();
  t = await neueApp({ uhr: () => uhr });
  baum = await verbandsbaum(t.pool);
  await q(`update anwendungen set scopes = scopes || '{mitglieder:schreiben,mitglieder:kontakt}' where schluessel = $1`, [CLIENT]);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  b = await neuerVerein(t.pool, baum.kreis);
  let lenaM;
  [{ id: lenaM, person_id: lena }] = await q(`select id, person_id from mitglieder where vorname = 'Lena'`);
  dob = '2010-03-04';
  await q('update personen set geburtsdatum = $2 where id = $1', [lena, dob]);
  await q(`update lizenzen set geloescht_am = now() where mitglied_id = $1 and art = 'judopass'`, [lenaM]);
  await q(`insert into lizenzen (verein_id, mitglied_id, art, nummer) values ($1,$2,'judopass','JP-4711')`, [jc, lenaM]);
  id = Object.fromEntries((await q('select benutzername, id from benutzer')).map((x) => [x.benutzername, x.id]));
  await q('delete from personen_zugriffe');
  await q(`insert into personen_zugriffe (person_id, benutzer_id, art, umfang, erteilt_am) values ($1,$2,'erziehungsberechtigt','aendern',now())`, [lena, id.eltern1]);
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'admin','freigegeben')`, [id.pruefer1, b]);
});
afterEach(() => t.schliessen());

const nachname = async () => (await q('select nachname from personen where id = $1', [lena]))[0].nachname;
const stelle = async (wer, extra = { person_id: lena }) => t.api('POST', '/v2/mitgliedschaftsantraege', { verein_id: b, ...extra }, await tok(wer));
const mitPass = async (extra = {}) => ({ judopass_nr: 'JP-4711', vorname: 'Lena', nachname: await nachname(), geburtsdatum: dob, ...extra });
const basis = () => `/v2/vereine/${b}/mitgliedschaftsantraege`;
const erfasse = async (person, judopass_nr) => t.api('POST', basis(), { person, ...(judopass_nr ? { judopass_nr } : {}) }, await tok('pruefer1', b));
const liste = async () => (await t.api('GET', basis(), null, await tok('pruefer1', b))).body.antraege;
async function entscheide(antrag, body, wer = 'pruefer1', v = b) {
  const [{ change_seq }] = await q('select change_seq from mitgliedschaftsantraege where id = $1', [antrag]);
  const r = await t.app.inject({ method: 'PATCH', url: `${basis()}/${antrag}`, payload: body, headers: { authorization: `Bearer ${await tok(wer, v)}`, 'if-match': `"${change_seq}"` } });
  return { status: r.statusCode, body: r.json() };
}

it('ohne Pass-Nr. kommt die Person aus dem Konto; der Verein sieht bis zur Annahme nur Antragsdaten', async () => {
  const r = await stelle('eltern1');
  expect(r.status).toBe(201);
  expect(r.body).not.toHaveProperty('person_id');
  const [a] = await liste();
  expect(a).toMatchObject({ vorname: 'Lena', geburtsdatum: dob, status: 'offen', art: 'online' });
  for (const f of ['person_id', 'email', 'strasse', 'angaben', 'gestellt_von']) expect(a).not.toHaveProperty(f);
  const admin = await tok('pruefer1', b);
  expect((await t.api('GET', `/v2/personen/${lena}`, null, admin)).status).toBe(404);
  expect(await q(`select benutzer_id from nachrichten where art = 'antrag_eingegangen'`)).toEqual([{ benutzer_id: id.pruefer1 }]);
  const an = await entscheide(a.id, { entscheidung: 'annehmen' });
  expect(an).toMatchObject({ status: 200, body: { status: 'angenommen', person_id: lena, mitgliedschaft: { mitgliedsnr: 1, status: 'aktiv' } } });
  const p = (await t.api('GET', `/v2/personen/${lena}`, null, admin)).body;
  expect(p.mitgliedschaften.map((m) => m.verein_id)).toEqual([b]); // nichts aus anderen Vereinen
  expect(p).toHaveProperty('email');
  expect(await q('select heimatverein_id from personen where id = $1', [lena])).toEqual([{ heimatverein_id: jc }]);
  expect(await q(`select verein_id from lizenzen where nummer = 'JP-4711'`)).toEqual([{ verein_id: jc }]);
  expect((await q(`select count(*)::int n from personen where vorname = 'Lena'`))[0].n).toBe(1);
  expect((await entscheide(a.id, { entscheidung: 'ablehnen' })).body.code).toBe('status_unzulaessig');
  expect(await q(`select benutzer_id from nachrichten where art = 'antrag_entschieden'`)).toEqual([{ benutzer_id: id.eltern1 }]);
});

it('stellen dürfen die Person ab 14 und Erziehungsberechtigte, sonst niemand', async () => {
  for (const wer of ['trainer1', 'admin1']) expect((await stelle(wer)).status).toBe(404);
  await q(`update personen set geburtsdatum = '2014-05-02' where id = $1`, [lena]);
  uhr = new Date('2028-05-01T12:00:00Z');
  expect((await stelle('schueler1')).status).toBe(404);
  uhr = new Date('2028-05-02T12:00:00Z');
  await q(`update benutzer set fremd_vergeben_am = now() where id = $1`, [id.schueler1]);
  expect((await stelle('schueler1')).status).toBe(404); // unbestätigtes Konto
  await q(`update benutzer set fremd_vergeben_am = null where id = $1`, [id.schueler1]);
  expect((await stelle('schueler1')).status).toBe(201);
  expect(await q(`select benutzer_id from nachrichten where art = 'antrag_gestellt'`)).toEqual([{ benutzer_id: id.eltern1 }]);
  // die Person selbst ist nur über Kontakt-Bevollmächtigte nicht beantragbar
  await q(`update personen_zugriffe set art = 'bevollmaechtigt'`);
  await q(`update mitgliedschaftsantraege set status = 'zurueckgezogen'`);
  expect((await stelle('eltern1')).status).toBe(404);
  expect((await stelle('eltern1', {})).status).toBe(400);
});

it('Pass-Nr. nur mit passendem Nachnamen und Geburtsdatum; sonst ohne Grund abgelehnt und protokolliert', async () => {
  const falsch = [{ nachname: 'Falsch' }, { geburtsdatum: '2010-03-05' }, { judopass_nr: 'JP-0000' }];
  const antworten = [];
  for (const f of falsch) antworten.push((await stelle('trainer1', await mitPass(f))).body);
  for (const a of antworten) expect(a).toEqual(antworten[0]);
  expect(antworten[0]).toMatchObject({ status: 422, code: 'antrag_abgelehnt' });
  expect((await q('select verein_id, benutzer_id from antrag_fehlversuche')).length).toBe(3);
  const r = await stelle('trainer1', await mitPass());
  expect(r.status).toBe(201);
  expect(await q('select person_id from mitgliedschaftsantraege')).toEqual([{ person_id: lena }]);
  // Person und Eltern erfahren davon
  expect((await q(`select benutzer_id from nachrichten where art = 'antrag_gestellt' order by 1`)).map((x) => x.benutzer_id)).toEqual([id.schueler1, id.eltern1].sort());
});

it('Fehlversuche sind je Benutzer und je Verein begrenzt, auch parallel', async () => {
  const token = await tok('trainer1');
  const f = await mitPass({ nachname: 'Falsch' });
  const r = await Promise.all(Array.from({ length: 9 }, () => t.api('POST', '/v2/mitgliedschaftsantraege', { verein_id: b, ...f }, token)));
  expect(r.filter((x) => x.status === 422)).toHaveLength(5);
  expect(r.filter((x) => x.status === 429)).toHaveLength(4);
  expect((await stelle('trainer1', await mitPass())).status).toBe(429); // auch richtige Angaben
  await q('insert into antrag_fehlversuche (verein_id, benutzer_id, zeitpunkt) select $1, $2, now() from generate_series(1, 15)', [b, id.schueler1]);
  expect((await stelle('eltern1', await mitPass())).status).toBe(429);
  expect((await stelle('eltern1')).status).toBe(201); // ohne Pass-Nr. nicht betroffen
  uhr = new Date(uhr.getTime() + 86_400_000 + 60_000);
  await q(`update mitgliedschaftsantraege set status = 'zurueckgezogen'`);
  expect((await stelle('trainer1', await mitPass())).status).toBe(201);
});

it('ein offener Antrag je Verein und Person; bestehende Mitgliedschaft abgelehnt, ausgetretene auf Wunsch reaktiviert', async () => {
  const beide = await Promise.all([stelle('eltern1'), stelle('schueler1')]);
  expect(beide.map((r) => r.status).sort()).toEqual([201, 409]);
  expect((await stelle('eltern1')).body.code).toBe('antrag_offen');
  expect((await stelle('eltern1', { person_id: lena, verein_id: jc })).body.code).toBe('mitgliedschaft_vorhanden');
  const [a] = await liste();
  expect((await entscheide(a.id, { entscheidung: 'annehmen' })).status).toBe(200);
  expect((await stelle('eltern1')).body.code).toBe('mitgliedschaft_vorhanden');
  await q(`update mitglieder set status = 'ausgetreten', austritt = current_date where verein_id = $1`, [b]);
  expect((await stelle('eltern1')).status).toBe(201);
  const neu = (await liste()).find((x) => x.status === 'offen');
  expect((await entscheide(neu.id, { entscheidung: 'annehmen' })).body.code).toBe('mitglied_ausgetreten');
  expect((await entscheide(neu.id, { entscheidung: 'annehmen', reaktivieren: true })).body.mitgliedschaft).toMatchObject({ mitgliedsnr: 1, status: 'aktiv' });
  expect((await q('select count(*)::int n from mitglieder where verein_id = $1', [b]))[0].n).toBe(1);
});

it('schriftlich ohne Pass-Nr. entsteht die Person erst bei der Annahme; mit Pass-Nr. wird zugeordnet', async () => {
  const person = { vorname: 'Nora', nachname: 'Neu', geburtsdatum: '2012-01-01', email: 'nora@example.org' };
  const r = await erfasse(person);
  expect(r.status).toBe(201);
  expect(await q(`select 1 from personen where vorname = 'Nora'`)).toEqual([]);
  const an = await entscheide(r.body.id, { entscheidung: 'annehmen', eintritt: '2026-01-01' });
  expect(an.status).toBe(200);
  expect(await q(`select id, email, heimatverein_id from personen where vorname = 'Nora'`)).toEqual([{ id: an.body.person_id, email: 'nora@example.org', heimatverein_id: b }]);
  expect(await q('select angaben from mitgliedschaftsantraege')).toEqual([{ angaben: null }]);
  expect((await erfasse({ vorname: 'Lena', nachname: 'Falsch', geburtsdatum: dob }, 'JP-4711')).body.code).toBe('antrag_abgelehnt');
  const z = await erfasse({ vorname: 'Lena', nachname: await nachname(), geburtsdatum: dob }, 'JP-4711');
  expect((await entscheide(z.body.id, { entscheidung: 'annehmen' })).body.person_id).toBe(lena);
  expect((await t.api('POST', basis(), { person }, await tok('schueler1'))).status).toBe(404);
});

it('fremde Vereine und Trainer sehen und entscheiden nichts; zurückziehen darf nur der Antragsteller', async () => {
  const a = (await stelle('eltern1')).body.id;
  for (const wer of ['admin1', 'trainer1', 'schueler1']) {
    const token = await tok(wer);
    expect((await t.api('GET', basis(), null, token)).status).toBe(404);
    expect((await t.api('GET', `${basis()}/${a}`, null, token)).status).toBe(404);
    expect((await entscheide(a, { entscheidung: 'annehmen' }, wer, jc)).status).toBe(404);
    expect((await t.api('DELETE', `/v2/mitgliedschaftsantraege/${a}`, null, token)).status).toBe(404);
  }
  const eltern = await tok('eltern1');
  expect((await t.api('GET', '/v2/ich/mitgliedschaftsantraege', null, eltern)).body.antraege).toMatchObject([{ id: a, status: 'offen' }]);
  expect((await t.api('DELETE', `/v2/mitgliedschaftsantraege/${a}`, null, eltern)).body.status).toBe('zurueckgezogen');
  expect((await entscheide(a, { entscheidung: 'annehmen' })).body.code).toBe('status_unzulaessig');
});

it('Fristjob erinnert einmal und lässt verfallen; der Landesverband setzt eigene Fristen', async () => {
  const a = (await stelle('eltern1')).body.id;
  const lauf = (tage) => fuehreAus(t.pool, 'antragsfristen', {}, { jetzt: new Date(uhr.getTime() + tage * 86_400_000) });
  expect(await lauf(13.9)).toEqual({ erinnert: 0, verfallen: 0 });
  expect(await lauf(14)).toEqual({ erinnert: 1, verfallen: 0 });
  expect(await lauf(15)).toEqual({ erinnert: 0, verfallen: 0 });
  expect(await q(`select benutzer_id from nachrichten where art = 'antrag_erinnerung'`)).toEqual([{ benutzer_id: id.pruefer1 }]);
  expect(await lauf(29.9)).toEqual({ erinnert: 0, verfallen: 0 });
  expect(await lauf(30)).toEqual({ erinnert: 0, verfallen: 1 });
  expect(await q('select status from mitgliedschaftsantraege where id = $1', [a])).toEqual([{ status: 'verfallen' }]);
  expect(await q(`select benutzer_id from nachrichten where art = 'antrag_verfallen'`)).toEqual([{ benutzer_id: id.eltern1 }]);
  await q(`insert into fristen (art, verband_id, wert, einheit) values ('mitgliedschaftsantrag_verfall', $1, 5, 'tage')`, [baum.lv]);
  expect((await stelle('eltern1')).status).toBe(201);
  expect(await lauf(5)).toEqual({ erinnert: 0, verfallen: 1 });
});
