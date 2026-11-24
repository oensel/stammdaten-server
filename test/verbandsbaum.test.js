// Story 1.4 (FR-1): Verbandsbaum
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gibRolle, verband, verbandsbaum, verein } from './fabrik.js';
import { neueApp } from './helper.js';

let t; let baum; let admin; let mitglied;
beforeAll(async () => {
  t = await neueApp();
  baum = await verbandsbaum(t.pool);
  await gibRolle(t.pool, 'trainer1', 'djb_admin', baum.djb);
  admin = (await t.login('trainer1')).body.access_token;
  mitglied = (await t.login('admin1')).body.access_token; // Vereins-Admin, aber kein Verbands-Admin
});
afterAll(() => t.schliessen());

const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const ruf = async (method, url, payload, { token = admin, version } = {}) => {
  const r = await t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, ...(version ? { 'if-match': `"${version}"` } : {}) } });
  return { status: r.statusCode, body: r.json(), etag: r.headers.etag };
};
const vorfahren = async (id) => (await q('select vorfahr_id from verband_pfade where nachfahr_id = $1 order by tiefe', [id])).map((r) => r.vorfahr_id);
const letzterAudit = async (id) => (await q('select aktion, akteur, alt, neu from audit_log where objekt_id = $1 order by id desc limit 1', [id]))[0];

describe('Pfade', () => {
  it('die Fabrik legt den ganzen Baum samt verband_pfade an', async () => {
    expect(await vorfahren(baum.verein)).toEqual([baum.kreis, baum.bezirk, baum.lv, baum.djb]);
    expect(await vorfahren(baum.djb)).toEqual([baum.djb]);
  });
  it('Verschieben eines Bezirks zieht den ganzen Teilbaum mit', async () => {
    const a = await verbandsbaum(t.pool); const b = await verbandsbaum(t.pool);
    const { change_seq } = (await q('select change_seq from verbaende where id = $1', [a.bezirk]))[0];
    const r = await ruf('PATCH', `/v2/verbaende/${a.bezirk}`, { uebergeordnet_id: b.lv }, { version: change_seq });
    expect(r.status).toBe(200);
    expect(await vorfahren(a.verein)).toEqual([a.kreis, a.bezirk, b.lv, a.djb]);
    expect(await vorfahren(a.kreis)).toEqual([a.kreis, a.bezirk, b.lv, a.djb]);
    expect(await letzterAudit(a.bezirk)).toMatchObject({ aktion: 'verband_geaendert', alt: { uebergeordnet_id: a.lv }, neu: { uebergeordnet_id: b.lv } });
  });
});

describe('anlegen und ändern', () => {
  it('legt Verband und Verein an, auditiert', async () => {
    const k = await ruf('POST', '/v2/verbaende', { name: 'Kreis Neu', typ: 'kreis', uebergeordnet_id: baum.bezirk });
    expect(k.status).toBe(201);
    expect(k.etag).toBe(`"${k.body.change_seq}"`);
    const v = await ruf('POST', '/v2/vereine', { name: 'JC Neu', verband_id: k.body.id });
    expect(v.status).toBe(201);
    expect(await vorfahren(v.body.id)).toEqual([k.body.id, baum.bezirk, baum.lv, baum.djb]);
    expect(await letzterAudit(k.body.id)).toMatchObject({ aktion: 'verband_angelegt', alt: null, neu: { name: 'Kreis Neu' } });
    expect(await letzterAudit(v.body.id)).toMatchObject({ aktion: 'verein_angelegt', neu: { name: 'JC Neu' } });
  });
  it('lehnt falsche Ebenen und einen zweiten Dachverband mit fachlichem code ab', async () => {
    const neu = (typ, uebergeordnet_id) => ruf('POST', '/v2/verbaende', { name: `X ${randomUUID()}`, typ, uebergeordnet_id });
    for (const [typ, eltern] of [['kreis', baum.lv], ['bezirk', baum.djb], ['landesverband', null], ['dachverband', baum.djb], ['kreis', randomUUID()]]) {
      expect((await neu(typ, eltern)).body).toMatchObject({ status: 422, code: 'ebenenfolge_verletzt' });
    }
    expect((await neu('dachverband', null)).body).toMatchObject({ status: 409, code: 'dachverband_vorhanden' });
    expect((await ruf('POST', '/v2/vereine', { name: 'X Bezirk', verband_id: baum.bezirk })).body).toMatchObject({ status: 422, code: 'ebenenfolge_verletzt' });
  });
  it('lehnt einen Verein ohne Kreis ab, beim Anlegen und beim Ändern', async () => {
    expect((await ruf('POST', '/v2/vereine', { name: 'Ohne Kreis' })).body).toMatchObject({ status: 422, code: 'verein_braucht_kreis' });
    const id = await verein(t.pool, baum.kreis);
    const { change_seq } = (await q('select change_seq from vereine where id = $1', [id]))[0];
    expect((await ruf('PATCH', `/v2/vereine/${id}`, { verband_id: null }, { version: change_seq })).body).toMatchObject({ status: 422, code: 'verein_braucht_kreis' });
    await expect(q(`insert into vereine (name) values ('Direkt')`)).rejects.toThrow('verein_braucht_kreis');
  });
  it('meldet doppelte Namen als 409', async () => {
    expect((await ruf('POST', '/v2/verbaende', { name: 'demo-KREIS', typ: 'landesverband', uebergeordnet_id: baum.djb })).body).toMatchObject({ status: 409, code: 'name_vergeben' });
  });
  it('verlangt If-Match (428) und erkennt veraltete Versionen (412)', async () => {
    const id = await verein(t.pool, baum.kreis);
    const { change_seq } = (await q('select change_seq from vereine where id = $1', [id]))[0];
    expect((await ruf('PATCH', `/v2/vereine/${id}`, { ort: 'A' })).body).toMatchObject({ status: 428, code: 'if_match_fehlt' });
    const r = await ruf('PATCH', `/v2/vereine/${id}`, { ort: 'A' }, { version: change_seq });
    expect(r.body).toMatchObject({ ort: 'A', verband_id: baum.kreis });
    expect((await ruf('PATCH', `/v2/vereine/${id}`, { ort: 'B' }, { version: change_seq })).body).toMatchObject({ status: 412, code: 'version_veraltet' });
    expect((await ruf('PATCH', `/v2/vereine/${randomUUID()}`, { ort: 'B' }, { version: '1' })).status).toBe(404);
  });
  it('ein aufgelöster Verein bleibt mit Auflösungsdatum im Baum', async () => {
    const id = await verein(t.pool, baum.kreis);
    const { change_seq } = (await q('select change_seq from vereine where id = $1', [id]))[0];
    await ruf('PATCH', `/v2/vereine/${id}`, { aufgeloest_am: '2026-06-30' }, { version: change_seq });
    expect(await letzterAudit(id)).toMatchObject({ aktion: 'verein_geaendert', alt: { aufgeloest_am: null }, neu: { aufgeloest_am: '2026-06-30' } });
    const { body } = await ruf('GET', '/v2/verbandsbaum', undefined, { token: mitglied });
    expect(body.vereine.find((v) => v.id === id)).toMatchObject({ aufgeloest_am: '2026-06-30', verband_id: baum.kreis });
    expect(body.verbaende.find((v) => v.id === baum.kreis)).toMatchObject({ typ: 'kreis', uebergeordnet_id: baum.bezirk });
  });
});

describe('Rechte', () => {
  const versuche = async (token) => [
    (await ruf('POST', '/v2/verbaende', { name: `R ${randomUUID()}`, typ: 'kreis', uebergeordnet_id: baum.bezirk }, { token })).status,
    (await ruf('PATCH', `/v2/verbaende/${baum.kreis}`, { name: `R ${randomUUID()}` }, { token, version: '1' })).status,
    (await ruf('POST', '/v2/vereine', { name: `R ${randomUUID()}`, verband_id: baum.kreis }, { token })).status,
    (await ruf('PATCH', `/v2/vereine/${baum.verein}`, { name: `R ${randomUUID()}` }, { token, version: '1' })).status,
  ];
  it('weist Benutzer ohne Admin-Recht und LV-Admins ab, ohne etwas zu schreiben', async () => {
    const vorher = (await q('select count(*) from audit_log'))[0].count;
    expect(await versuche(mitglied)).toEqual([404, 404, 404, 404]);
    await gibRolle(t.pool, 'pruefer1', 'lv_admin', baum.lv);
    expect(await versuche((await t.login('pruefer1')).body.access_token)).toEqual([404, 404, 404, 404]);
    expect((await q('select count(*) from audit_log'))[0].count).toBe(vorher);
  });
  it('lässt den Super-Admin zu und beendet die Rolle sofort', async () => {
    await t.pool.query(`update benutzer set ist_super_admin = true where benutzername = 'eltern1'`);
    expect(await versuche((await t.login('eltern1')).body.access_token)).toEqual([201, 412, 201, 412]);
    await t.pool.query('update benutzer_verbandsrollen set beendet_am = now()');
    expect(await versuche(admin)).toEqual([404, 404, 404, 404]);
  });
  it('verlangt eine Anmeldung zum Lesen', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v2/verbandsbaum' })).statusCode).toBe(401);
  });
});

it('gleichzeitiges Verschieben hält die Pfade konsistent', async () => {
  const a = await verbandsbaum(t.pool); const b = await verbandsbaum(t.pool);
  const k = await verband(t.pool, 'kreis', a.bezirk);
  await Promise.all([
    t.pool.query('update verbaende set uebergeordnet_id = $2 where id = $1', [a.bezirk, b.lv]),
    t.pool.query('update vereine set verband_id = $2 where id = $1', [a.verein, k]),
  ]);
  expect(await vorfahren(a.verein)).toEqual([k, a.bezirk, b.lv, a.djb]);
});
