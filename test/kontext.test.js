// Story 2.3 (FR-13, FR-15, FR-16): genau ein Kontext, Kontextwechsel, GET /v2/ich
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { gibRolle, verbandsbaum, verbandsToken } from './fabrik.js';
import { neueApp } from './helper.js';

let t; let baum; let jcDemo;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const wechsle = (art, id, token) => t.api('POST', '/v2/auth/kontext-wechseln', { art, id }, token);
const ich = async (token) => t.api('GET', '/v2/ich', null, token);
beforeAll(async () => {
  t = await neueApp();
  baum = await verbandsbaum(t.pool);
  jcDemo = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  await gibRolle(t.pool, 'trainer1', 'lv_admin', baum.lv);
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, status) select id, $1, 'freigegeben' from benutzer where benutzername = 'trainer1'`, [baum.verein]);
  await q(`update benutzer set heimatverein_id = $1 where benutzername = 'trainer1'`, [jcDemo]);
});
afterAll(() => t.schliessen());

it('startet im Heimatverein; Verbandsrollen wirken dort nicht', async () => {
  const { body } = await t.login('trainer1');
  expect(claims(body.access_token).verein_id).toBe(jcDemo);
  expect((await ich(body.access_token)).body).toMatchObject({ kontext: { art: 'verein', id: jcDemo }, rollen: ['mitglied', 'trainer'] });
});

it('wechselt in den Verband: neues Token, Rechte neu berechnet, Vereinsrechte wirken nicht', async () => {
  const vorher = (await t.login('trainer1')).body;
  const r = await wechsle('verband', baum.lv, vorher.access_token);
  expect(r.status).toBe(200);
  expect(claims(r.body.access_token)).toMatchObject({ kontext: { art: 'verband', id: baum.lv }, verbandsrollen: ['lv_admin'], verein_id: null, rolle: null, rechte: [], scope: '' });
  const { body } = await ich(r.body.access_token);
  expect(body).toMatchObject({ kontext: { art: 'verband', id: baum.lv }, rollen: ['lv_admin'] });
  expect(body.berechtigungen).toContain('fristen:AENDERN');
  expect(body.berechtigungen).not.toContain('mitglieder:LESEN');
  expect(body.kontexte).toEqual({ vereine: [jcDemo, baum.verein].sort(), verbaende: [{ id: baum.lv, rollen: ['lv_admin'] }] });
  expect((await t.refresh(vorher.refresh_token)).status).toBe(401); // alte Sitzung ist beendet
});

it('der Kontext übersteht die Token-Erneuerung und lässt sich zurückwechseln', async () => {
  const v = (await wechsle('verband', baum.lv, (await t.login('trainer1')).body.access_token)).body;
  const neu = (await t.refresh(v.refresh_token)).body;
  expect(claims(neu.access_token).kontext).toEqual({ art: 'verband', id: baum.lv });
  const zurueck = await wechsle('verein', baum.verein, neu.access_token);
  expect(claims(zurueck.body.access_token)).toMatchObject({ verein_id: baum.verein, rolle: 'mitglied' });
  expect(claims(zurueck.body.access_token)).not.toHaveProperty('kontext');
});

it('im Verbandskontext gibt es keine Mitgliederdaten über die alten Endpunkte', async () => {
  const r = await t.api('GET', '/mitglieder', null, await verbandsToken(t, 'trainer1', baum.lv));
  expect(r.status).toBeGreaterThanOrEqual(400);
});

it('weist Kontexte ohne Rolle ab und lässt die Sitzung bestehen', async () => {
  const { body } = await t.login('trainer1');
  for (const [art, id] of [['verband', baum.djb], ['verband', baum.kreis], ['verband', randomUUID()], ['verein', randomUUID()], ['verein', baum.lv]]) {
    expect((await wechsle(art, id, body.access_token)).body).toMatchObject({ status: 404, code: 'nicht_gefunden' });
  }
  expect((await t.refresh(body.refresh_token)).status).toBe(200);
});

it('ein abgemeldetes Token eröffnet keine neue Sitzung', async () => {
  const { body } = await t.login('trainer1');
  await t.api('POST', '/auth/logout', { refresh_token: body.refresh_token });
  expect((await wechsle('verband', baum.lv, body.access_token)).body).toMatchObject({ status: 401, code: 'abgemeldet' });
});

it('Geräte-Anmeldungen wechseln nicht und tragen keine Verbandsrechte', async () => {
  const { body } = await t.login('trainer1', { verein_id: jcDemo, geraet: { typ: 'tablet', name: 'T' }, geraet_token: true });
  expect((await wechsle('verband', baum.lv, body.access_token)).body.code).toBe('geraet_gebunden');
});

it('Entzug wirkt unter /v2 sofort und spätestens mit der Erneuerung: zurück zum Heimatverein', async () => {
  const v = (await wechsle('verband', baum.lv, (await t.login('trainer1')).body.access_token)).body;
  expect(v.expires_in).toBeLessThanOrEqual(600);
  await q('update benutzer_verbandsrollen set beendet_am = now()');
  expect((await ich(v.access_token)).status).toBe(404);
  const neu = (await t.refresh(v.refresh_token)).body;
  expect(claims(neu.access_token)).toMatchObject({ verein_id: jcDemo });
  expect(claims(neu.access_token)).not.toHaveProperty('kontext');
});

it('ohne freigegebenen Verein keine Anmeldung, auch nicht mit Verbandsrolle; ein Verbandskontext endet mit dem letzten Verein', async () => {
  await gibRolle(t.pool, 'pruefer1', 'lv_admin', baum.lv);
  const v = (await wechsle('verband', baum.lv, (await t.login('pruefer1')).body.access_token)).body;
  await q(`update benutzer_vereine set status = 'gesperrt' where benutzer_id = (select id from benutzer where benutzername = 'pruefer1')`);
  expect((await t.login('pruefer1')).body.code).toBe('kein_verein');
  expect((await t.refresh(v.refresh_token)).status).toBe(401);
});

it('verlangt eine Anmeldung und gültige Eingaben', async () => {
  expect((await wechsle('verband', baum.lv)).body).toMatchObject({ status: 401, code: 'nicht_angemeldet' });
  expect((await wechsle('land', baum.lv, (await t.login('admin1')).body.access_token)).body).toMatchObject({ status: 400, code: 'ungueltige_anfrage' });
});
