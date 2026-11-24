// Story 2.2 (FR-14): Vereinszugehörigkeit mit Freigabe
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { verbandsbaum } from './fabrik.js';
import { neueApp } from './helper.js';

let t; let verein; let admin; let anderer; let id;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const benutzer = async (n) => (await q('select id from benutzer where benutzername = $1', [n]))[0].id;
const token = async (n, extra) => (await t.login(n, extra)).body.access_token;
beforeAll(async () => {
  t = await neueApp();
  verein = (await verbandsbaum(t.pool)).verein;
  // admin1 ist Admin im neuen Verein, schueler1 bringt aus JC Demo eigene Rollen mit
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1, $2, 'admin', 'freigegeben')`, [await benutzer('admin1'), verein]);
  const jcDemo = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  await q(`update benutzer set heimatverein_id = $1`, [jcDemo]);
  admin = await token('admin1', { verein_id: verein });
  anderer = await token('trainer1');
});
afterAll(() => t.schliessen());

const ruf = async (method, pfad, payload, { tok = admin, version, x = verein } = {}) => {
  const r = await t.app.inject({
    method, url: `/v2/vereine/${verein}/zugehoerigkeiten${pfad}`, payload,
    headers: { authorization: `Bearer ${tok}`, ...(x ? { 'x-verein': x } : {}), ...(version ? { 'if-match': `"${version}"` } : {}) },
  });
  return { status: r.statusCode, body: r.json() };
};
const anfrage = (tok) => ruf('POST', '', undefined, { tok, x: null });
const zeile = async () => (await q('select * from benutzer_vereine where id = $1', [id]))[0];
const entscheide = async (entscheidung, extra = {}) => ruf('PATCH', `/${id}`, { entscheidung, ...extra }, { version: (await zeile()).change_seq });
const vereineImToken = async (n) => (await t.login(n)).body.benutzer.vereine.map((v) => v.id);
const letzterAudit = async () => (await q('select aktion, akteur, alt, neu, grund, ebene_id from audit_log where objekt_id = $1 order by id desc limit 1', [id]))[0];

it('eine Anfrage gibt keine Rechte', async () => {
  const r = await anfrage(await token('schueler1'));
  expect(r).toMatchObject({ status: 201, body: { status: 'angefragt', rolle: 'mitglied' } });
  id = r.body.id;
  expect(await vereineImToken('schueler1')).not.toContain(verein);
  expect((await ruf('GET', '', undefined, { tok: await token('schueler1') })).status).toBe(404);
  expect((await anfrage(await token('schueler1'))).body).toMatchObject({ status: 409, code: 'zugehoerigkeit_vorhanden' });
});

it('nur der Admin dieses Vereins sieht und entscheidet', async () => {
  expect((await ruf('GET', '?status=angefragt')).body.zugehoerigkeiten).toMatchObject([{ id, benutzername: 'schueler1', status: 'angefragt' }]);
  const v = (await zeile()).change_seq;
  expect((await ruf('GET', '', undefined, { tok: anderer, x: null })).status).toBe(404);
  expect((await ruf('PATCH', `/${id}`, { entscheidung: 'freigeben' }, { tok: anderer, version: v, x: null })).status).toBe(404);
  // Admin, aber mit anderem Verein als Kontext
  const jcDemo = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  expect((await ruf('PATCH', `/${id}`, { entscheidung: 'freigeben' }, { version: v, x: jcDemo })).status).toBe(404);
  expect((await zeile()).status).toBe('angefragt');
});

it('verlangt If-Match und erkennt veraltete Versionen', async () => {
  expect((await ruf('PATCH', `/${id}`, { entscheidung: 'freigeben' })).status).toBe(428);
  expect((await ruf('PATCH', `/${id}`, { entscheidung: 'freigeben' }, { version: '1' })).body.code).toBe('version_veraltet');
});

it('Freigabe wirkt mit der Token-Erneuerung, zusätzlich zu den bisherigen, und ist auditiert', async () => {
  const { body: sitzung } = await t.login('schueler1');
  const vorher = sitzung.benutzer.vereine.map((v) => v.id);
  expect((await entscheide('freigeben')).body.status).toBe('freigegeben');
  expect(await letzterAudit()).toMatchObject({ aktion: 'recht_vergeben', akteur: await benutzer('admin1'), ebene_id: verein, alt: { status: 'angefragt' }, neu: { status: 'freigegeben' } });
  const neu = (await t.refresh(sitzung.refresh_token)).body.benutzer.vereine.map((v) => v.id);
  expect(neu.sort()).toEqual([...vorher, verein].sort());
});

it('mehrere Rollen im Verein addieren sich', async () => {
  const ziel = (await zeile()).benutzer_id;
  for (const r of ['trainer', 'kassierer']) expect((await t.api('PUT', `/benutzer/${ziel}/rechte/${r}`, {}, admin)).status).toBe(200);
  const { body } = await t.login('schueler1');
  expect(body.benutzer.vereine.find((v) => v.id === verein).rechte).toEqual(['kassierer', 'trainer']);
});

it('Entzug wirkt sofort, ist mit Grund auditiert, und eine neue Freigabe belebt keine alten Rechte', async () => {
  await q(`update benutzer_vereine set rolle = 'admin' where id = $1`, [id]);
  expect((await entscheide('entziehen', { grund: 'Austritt' })).body).toMatchObject({ status: 'gesperrt', rolle: 'mitglied' });
  expect(await letzterAudit()).toMatchObject({ aktion: 'recht_entzogen', grund: 'Austritt', alt: { status: 'freigegeben', rolle: 'admin' }, neu: { status: 'gesperrt' } });
  expect(await vereineImToken('schueler1')).not.toContain(verein);
  expect((await anfrage(await token('schueler1'))).status).toBe(409); // gesperrt: nur der Admin gibt wieder frei
  expect((await entscheide('freigeben')).status).toBe(200);
  expect((await t.login('schueler1')).body.benutzer.vereine.find((v) => v.id === verein)).toMatchObject({ rolle: 'mitglied', rechte: [] });
});

it('ablehnen, erneut anfragen; unzulässige Übergänge werden abgewiesen', async () => {
  expect((await entscheide('ablehnen')).body.code).toBe('status_unzulaessig');
  id = (await anfrage(await token('eltern1'))).body.id;
  expect((await entscheide('ablehnen')).body.status).toBe('abgelehnt');
  expect((await letzterAudit()).aktion).toBe('recht_entzogen');
  expect(await anfrage(await token('eltern1'))).toMatchObject({ status: 201, body: { id, status: 'angefragt' } });
});

it('schützt das eigene Konto und Super-Admins; unbekannter Verein 404', async () => {
  const eigene = (await q('select id, change_seq from benutzer_vereine where benutzer_id = $1 and verein_id = $2', [await benutzer('admin1'), verein]))[0];
  expect((await ruf('PATCH', `/${eigene.id}`, { entscheidung: 'entziehen' }, { version: eigene.change_seq })).body.code).toBe('konto_geschuetzt');
  await q(`update benutzer set ist_super_admin = true where benutzername = 'eltern1'`);
  expect((await entscheide('freigeben')).body.code).toBe('konto_geschuetzt');
  const r = await t.app.inject({ method: 'POST', url: `/v2/vereine/${randomUUID()}/zugehoerigkeiten`, headers: { authorization: `Bearer ${anderer}` } });
  expect(r.statusCode).toBe(404);
});
