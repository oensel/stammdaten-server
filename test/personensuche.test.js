// Story 3.10 (FR-6, E70): Personensuche des Landesverbands und Aufgabenliste
import { afterEach, beforeEach, expect, it } from 'vitest';
import { gibRolle, verbandsbaum, verbandsToken } from './fabrik.js';
import { CLIENT, neueApp } from './helper.js';

let t; let baum; let fremd; let jc; let lv; let admin; let lenaP;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const tok = async (n) => (await t.login(n)).body.access_token;
beforeEach(async () => {
  t = await neueApp();
  baum = await verbandsbaum(t.pool);
  fremd = await verbandsbaum(t.pool); // zweiter Landesverband
  await q(`update anwendungen set scopes = scopes || '{mitglieder:verwaltung,mitglieder:schreiben}' where schluessel = $1`, [CLIENT]);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  await q('update vereine set verband_id = $2 where id = $1', [jc, baum.kreis]);
  await gibRolle(t.pool, 'trainer1', 'landesvertreter', baum.lv);
  lv = await verbandsToken(t, 'trainer1', baum.lv);
  admin = await tok('admin1');
  lenaP = (await q(`select person_id from mitglieder where vorname = 'Lena'`))[0].person_id;
});
afterEach(() => t.schliessen());

const ruf = async (method, url, payload, token = lv) => {
  const r = await t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() };
};
const suche = (qs, token) => ruf('GET', `/v2/personen/suche?${new URLSearchParams(qs)}`, null, token);
const draussen = async (vorname, nachname, pass = null) => {
  const [{ person_id }] = await q(`insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname) values ($1, 1, $2, $3) returning person_id`, [fremd.verein, vorname, nachname]);
  if (pass) await q('update personen set judopass_hinweis = $2 where id = $1', [person_id, pass]);
  return person_id;
};

it('sucht nach Name, Vorname, Geburtsdatum und Verein im eigenen Gebiet, ohne Kontaktdaten', async () => {
  await q(`update personen set strasse = 'Weg 1', email = 'l@example.org', geburtsdatum = '2012-03-04' where id = $1`, [lenaP]);
  await draussen('Lena', 'Schmidtfern');
  const r = await suche({ nachname: 'schm' });
  expect(r.status).toBe(200);
  expect(r.body.personen.map((p) => p.vorname)).toEqual(['Lena', 'Tim']); // Prefix, ohne Groß/Klein; die Person im anderen Landesverband fehlt
  expect(r.body.personen[0]).toMatchObject({ id: lenaP, geburtsdatum: '2012-03-04', heimatverein_id: jc, im_gebiet: true });
  expect(Object.keys(r.body.personen[0])).not.toEqual(expect.arrayContaining(['strasse']));
  expect(JSON.stringify(r.body)).not.toContain('example.org');
  expect((await suche({ vorname: 'Lena', geburtsdatum: '2012-03-04' })).body.personen).toHaveLength(1);
  expect((await suche({ vorname: 'Lena', geburtsdatum: '2012-03-05' })).body.personen).toHaveLength(0);
  expect((await suche({ verein_id: jc })).body.personen.length).toBeGreaterThan(1);
  expect((await suche({ verein_id: fremd.verein })).body.personen).toEqual([]); // fremdes Gebiet
  expect((await suche({ nachname: '%' })).body.personen).toEqual([]); // keine Platzhalter
});

it('Status und Zeitraum filtern die Mitgliedschaft; ohne Suchwert gibt es nichts', async () => {
  await q(`update mitglieder set status = 'ausgetreten', eintritt = '2010-01-01', austritt = '2015-06-30' where person_id = $1 and verein_id = $2`, [lenaP, jc]);
  expect((await suche({ nachname: 'Schmidt', vorname: 'Lena', status: 'ausgetreten' })).body.personen).toHaveLength(1);
  expect((await suche({ nachname: 'Schmidt', vorname: 'Lena', status: 'aktiv' })).body.personen).toHaveLength(0);
  expect((await suche({ nachname: 'Schmidt', vorname: 'Lena', zeitraum_von: '2015-01-01', zeitraum_bis: '2016-01-01' })).body.personen).toHaveLength(1);
  expect((await suche({ nachname: 'Schmidt', vorname: 'Lena', zeitraum_von: '2016-01-01' })).body.personen).toHaveLength(0);
  expect((await suche({ nachname: 'Schmidt', vorname: 'Lena', zeitraum_bis: '2009-12-31' })).body.personen).toHaveLength(0);
  expect((await suche({ status: 'aktiv' })).body.code).toBe('ungueltige_anfrage');
  expect((await suche({})).status).toBe(400);
});

it('höchstens 50 Treffer, der Rest wird angezeigt', async () => {
  await q(`insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname) select $1, 100 + g, 'V' || g, 'Masse' from generate_series(1, 51) g`, [jc]);
  const r = (await suche({ nachname: 'Masse' })).body;
  expect(r.personen).toHaveLength(50);
  expect(r.mehr).toBe(true);
  expect((await suche({ nachname: 'Masse', vorname: 'V1' })).body.mehr).toBe(false);
});

it('die Judopass-ID findet auch Personen außerhalb des Gebiets, andere Kriterien nicht', async () => {
  const draussenP = await draussen('Karl', 'Fern', 'JP-4711');
  const r = await suche({ judopass_id: 'JP-4711' });
  expect(r.body.personen).toEqual([expect.objectContaining({ id: draussenP, im_gebiet: false })]);
  expect((await suche({ judopass_id: 'JP-0000' })).body.personen).toEqual([]);
  expect((await suche({ judopass_id: 'JP-4711', verein_id: jc })).body.personen).toEqual([]); // Vereinsfilter verlangt Mitgliedschaft im Gebiet
  expect((await suche({ nachname: 'Fern' })).body.personen).toEqual([]);
});

it('jede Suche ist protokolliert, mit Kriterien statt Werten', async () => {
  await suche({ nachname: 'Schmidt', judopass_id: 'GEHEIM-1' });
  await suche({ vorname: 'Lena' });
  await suche({}); // abgewiesen: kein Eintrag
  const log = await q('select benutzer_id, verband_id, kriterien, treffer from personensuchen order by zeitpunkt, id');
  expect(log).toHaveLength(2);
  expect(log[0]).toMatchObject({ verband_id: baum.lv, kriterien: ['nachname', 'judopass_id'], treffer: 0 });
  expect(log[1]).toMatchObject({ kriterien: ['vorname'], treffer: 1 });
  expect(JSON.stringify(await q('select * from personensuchen'))).not.toContain('GEHEIM');
});

it('Verein und andere Ebenen haben keine Suche: 404', async () => {
  expect((await suche({ nachname: 'Schmidt' }, admin)).status).toBe(404);
  expect((await suche({ nachname: 'Schmidt' }, await tok('trainer1'))).status).toBe(404); // trainer1 im Vereinskontext
  expect((await suche({ judopass_id: 'x' }, await tok('schueler1'))).status).toBe(404);
  await gibRolle(t.pool, 'pruefer1', 'landesvertreter', fremd.lv);
  // Landesvertreter eines anderen Verbands sucht nur in seinem Gebiet
  const andere = await verbandsToken(t, 'pruefer1', fremd.lv);
  expect((await suche({ nachname: 'Schmidt' }, andere)).body.personen).toEqual([]);
  expect(await q('select 1 from personensuchen where benutzer_id = (select id from benutzer where benutzername = $1) and verband_id = $2', ['admin1', baum.lv])).toEqual([]);
});

it('Aufgabenliste: der Landesverband sieht Zusammenführen-Aufgaben seines Gebiets und erledigt sie', async () => {
  const neu = await ruf('POST', `/v2/vereine/${jc}/mitglieder`, { person: { vorname: 'Paula', nachname: 'Pass', geburtsdatum: '2010-01-01' }, judopass_id: 'JP-1' }, admin);
  expect(neu.status).toBe(201);
  const l = (await ruf('GET', '/v2/aufgaben?status=offen')).body.aufgaben;
  expect(l).toHaveLength(1);
  expect(l[0]).toMatchObject({ art: 'person_zusammenfuehren', status: 'offen', person: { id: neu.body.person_id, vorname: 'Paula', judopass_hinweis: 'JP-1', heimatverein_id: jc } });
  expect(l[0].person).not.toHaveProperty('email');
  const e = await ruf('POST', `/v2/aufgaben/${l[0].id}/erledigen`);
  expect(e).toMatchObject({ status: 200, body: { status: 'erledigt' } });
  expect(e.body.erledigt_am).toBeTruthy();
  expect((await ruf('POST', `/v2/aufgaben/${l[0].id}/erledigen`)).body.code).toBe('status_unzulaessig');
  expect((await ruf('GET', '/v2/aufgaben?status=offen')).body.aufgaben).toEqual([]);
  expect((await ruf('GET', '/v2/aufgaben?status=erledigt')).body.aufgaben).toHaveLength(1);
  expect((await ruf('GET', '/v2/aufgaben')).body.aufgaben).toHaveLength(1);
});

it('Aufgaben: Vereine, fremde Landesverbände und Aufgaben ohne Verband sind ausgeschlossen', async () => {
  await ruf('POST', `/v2/vereine/${jc}/mitglieder`, { person: { vorname: 'Paula', nachname: 'Pass', geburtsdatum: '2010-01-01' }, judopass_id: 'JP-1' }, admin);
  const id = (await q('select id from aufgaben'))[0].id;
  expect((await ruf('GET', '/v2/aufgaben', null, admin)).status).toBe(404);
  expect((await ruf('POST', `/v2/aufgaben/${id}/erledigen`, null, admin)).status).toBe(404);
  await gibRolle(t.pool, 'pruefer1', 'landesvertreter', fremd.lv);
  const andere = await verbandsToken(t, 'pruefer1', fremd.lv);
  expect((await ruf('GET', '/v2/aufgaben', null, andere)).body.aufgaben).toEqual([]);
  expect((await ruf('POST', `/v2/aufgaben/${id}/erledigen`, null, andere)).status).toBe(404);
  expect((await q('select status from aufgaben where id = $1', [id]))[0].status).toBe('offen');
});
