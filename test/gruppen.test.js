// Story 3.8 (FR-77): Gruppen
import { afterEach, beforeEach, expect, it } from 'vitest';
import { gibRolle, verbandsbaum, verbandsToken, verein as neuerVerein } from './fabrik.js';
import { CLIENT, cfgDefault, neueApp } from './helper.js';

let t; let jc; let b; let baum; let lena; let lenaB; let admin;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const tok = async (n, v) => (await t.login(n, v ? { verein_id: v } : {})).body.access_token;
beforeEach(async () => {
  t = await neueApp();
  baum = await verbandsbaum(t.pool);
  await q(`update anwendungen set scopes = scopes || '{mitglieder:kontakt}' where schluessel = $1`, [CLIENT]);
  await q(`update anwendungen set scopes = array_remove(scopes, 'mitglieder:schreiben') where schluessel = $1`, [CLIENT]); // wie Kyu-Manager-Pro
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  b = await neuerVerein(t.pool, baum.kreis);
  await q('update vereine set verband_id = $2 where id = $1', [jc, baum.kreis]);
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) select id, $1, 'admin', 'freigegeben' from benutzer where benutzername = 'pruefer1'`, [b]);
  let person_id;
  [{ id: lena, person_id }] = await q(`select id, person_id from mitglieder where vorname = 'Lena'`);
  lenaB = (await q(`insert into mitglieder (person_id, verein_id, mitgliedsnr, vorname, nachname) values ($1,$2,1,'x','x') returning id`, [person_id, b]))[0].id;
  admin = await tok('admin1');
});
afterEach(() => t.schliessen());

const basis = (v = jc) => `/v2/vereine/${v}/gruppen`;
const ruf = async (method, url, payload, token = admin, version) => {
  const r = await t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, ...(version ? { 'if-match': `"${version}"` } : {}) } });
  return { status: r.statusCode, body: r.json() };
};
const neu = async (name = 'Anfänger') => (await ruf('POST', basis(), { name, sortierung: 3 })).body;

it('anlegen, ändern, zuordnen, austragen, löschen', async () => {
  const g = await neu();
  expect(g).toMatchObject({ name: 'Anfänger', sortierung: 3 });
  await neu('Judo'); // ohne Umlaut: die Test-Datenbank läuft ohne Locale
  expect((await ruf('POST', basis(), { name: 'JUDO' })).body.code).toBe('name_vergeben');
  const g2 = (await ruf('PATCH', `${basis()}/${g.id}`, { trainingszeiten: 'Mo 17 Uhr' }, admin, g.change_seq)).body;
  expect(g2).toMatchObject({ name: 'Anfänger', trainingszeiten: 'Mo 17 Uhr', sortierung: 3 });
  expect((await ruf('PATCH', `${basis()}/${g.id}`, { name: 'x' }, admin, g.change_seq)).status).toBe(412);
  const z = `${basis()}/${g.id}/mitglieder`;
  expect((await ruf('PUT', `${z}/${lena}`)).status).toBe(200);
  expect((await ruf('GET', z)).body.mitglieder).toMatchObject([{ id: lena, vorname: 'Lena' }]);
  expect((await ruf('GET', z)).body.mitglieder[0]).not.toHaveProperty('email');
  expect((await ruf('DELETE', `${z}/${lena}`)).status).toBe(200);
  expect((await ruf('DELETE', `${z}/${lena}`)).status).toBe(404);
  expect((await ruf('PUT', `${z}/${lena}`)).status).toBe(200);
  expect((await ruf('DELETE', `${basis()}/${g.id}`, undefined, admin, g2.change_seq)).status).toBe(200);
  expect((await ruf('GET', z)).status).toBe(404);
  expect(await q('select 1 from mitglied_gruppen where gruppe_id = $1 and geloescht_am is null', [g.id])).toEqual([]);
  expect((await ruf('POST', basis(), { name: 'Anfänger' })).status).toBe(201); // Name wieder frei
});

it('nur im eigenen Verein sichtbar; Trainer lesen, Mitglieder und Verbandsrollen nicht', async () => {
  const g = await neu();
  const fremd = await tok('pruefer1', b);
  await gibRolle(t.pool, 'trainer1', 'landesvertreter', baum.lv);
  const lv = await verbandsToken(t, 'trainer1', baum.lv);
  for (const token of [fremd, lv, await tok('schueler1')]) {
    expect((await ruf('GET', basis(), undefined, token)).status).toBe(404);
    expect((await ruf('GET', `${basis()}/${g.id}/mitglieder`, undefined, token)).status).toBe(404);
    expect((await ruf('PUT', `${basis()}/${g.id}/mitglieder/${lena}`, undefined, token)).status).toBe(404);
    expect((await ruf('POST', basis(), { name: 'y' }, token)).status).toBe(404);
  }
  const trainer = await tok('trainer1');
  expect((await ruf('GET', basis(), undefined, trainer)).body.gruppen.map((x) => x.id)).toContain(g.id);
  expect((await ruf('POST', basis(), { name: 'z' }, trainer)).status).toBe(404);
  // Datenfilter je Mitglied: Trainer sehen nur Aktive
  await ruf('PUT', `${basis()}/${g.id}/mitglieder/${lena}`);
  const liste = async (token) => (await ruf('GET', `${basis()}/${g.id}/mitglieder`, undefined, token)).body.mitglieder.length;
  expect(await liste(trainer)).toBe(1);
  await q(`update mitglieder set status = 'ruhend' where id = $1`, [lena]);
  expect(await liste(trainer)).toBe(0);
  expect(await liste(admin)).toBe(1);
  // fremde Gruppe oder fremdes Mitglied
  expect((await ruf('PUT', `${basis(b)}/${g.id}/mitglieder/${lenaB}`, undefined, fremd)).status).toBe(404);
  expect((await ruf('PUT', `${basis()}/${g.id}/mitglieder/${lenaB}`)).status).toBe(404);
  expect((await ruf('GET', basis(b), undefined, fremd)).body.gruppen).toEqual([]);
});

it('ohne Gruppen-Scope der App kein Zugriff', async () => {
  await q(`update anwendungen set scopes = array_remove(scopes, 'gruppen:schreiben') where schluessel = $1`, [CLIENT]);
  expect((await ruf('POST', basis(), { name: 'x' })).status).toBe(404);
  expect((await ruf('GET', basis())).status).toBe(200);
});

it('Abgleich v1 liefert Gruppen, Zuordnungen, Austragen und Löschen; Wiederholung liefert nichts Neues', async () => {
  const app = (await t.api('POST', '/oauth/token', { grant_type: 'client_credentials', client_id: CLIENT, client_secret: cfgDefault.demoClientSecret })).body.access_token;
  let stand = '';
  const hole = async () => {
    const r = (await t.api('GET', `/v1/abgleich?verein_id=${jc}&limit=1000${stand ? `&seit=${stand}` : ''}`, null, app)).body;
    stand = r.stand;
    return r;
  };
  await hole();
  const g = await neu();
  await ruf('PUT', `${basis()}/${g.id}/mitglieder/${lena}`);
  let r = await hole();
  expect(r.gruppen).toMatchObject([{ id: g.id, name: 'Anfänger', geloescht_am: null }]);
  expect(r.mitglied_gruppen).toMatchObject([{ mitglied_id: lena, gruppe_id: g.id, geloescht_am: null }]);
  await ruf('PUT', `${basis()}/${g.id}/mitglieder/${lena}`);
  expect((await hole()).mitglied_gruppen).toEqual([]);
  await ruf('DELETE', `${basis()}/${g.id}`, undefined, admin, g.change_seq);
  r = await hole();
  expect(r.gruppen[0].geloescht_am).toBeTruthy();
  expect(r.mitglied_gruppen[0].geloescht_am).toBeTruthy();
});

it('mit dem Austritt enden die Gruppen; Ausgetretene lassen sich nicht zuordnen', async () => {
  const g = await neu();
  const z = `${basis()}/${g.id}/mitglieder/${lena}`;
  await ruf('PUT', z);
  const [{ change_seq }] = await q('select change_seq from mitglieder where id = $1', [lena]);
  await q(`update anwendungen set scopes = scopes || '{mitglieder:schreiben}' where schluessel = $1`, [CLIENT]);
  await q('update mitglieder set eintritt = null where id = $1', [lena]);
  const [{ change_seq: cs }] = await q('select change_seq from mitglieder where id = $1', [lena]);
  expect(cs).not.toBe(change_seq);
  expect((await ruf('PATCH', `/v2/vereine/${jc}/mitglieder/${lena}/austritt`, { austritt: new Date().toISOString().slice(0, 10) }, admin, cs)).status).toBe(200);
  expect((await ruf('GET', `${basis()}/${g.id}/mitglieder`)).body.mitglieder).toEqual([]);
  expect((await ruf('PUT', z)).body.code).toBe('status_unzulaessig');
});
