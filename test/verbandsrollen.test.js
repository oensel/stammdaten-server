// Story 2.6 (FR-21, P13, P18): Verbandsrollen und Stellvertreter
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gibRolle, verbandsbaum, verbandsToken } from './fabrik.js';
import { neueApp } from './helper.js';

let t; let baum; let fremd; let lvAdmin; let djbAdmin; let id;
beforeAll(async () => {
  t = await neueApp();
  baum = await verbandsbaum(t.pool);
  fremd = await verbandsbaum(t.pool);
  await gibRolle(t.pool, 'trainer1', 'lv_admin', baum.lv);
  await gibRolle(t.pool, 'admin1', 'djb_admin', baum.djb);
  lvAdmin = await verbandsToken(t, 'trainer1', baum.lv);
  djbAdmin = await verbandsToken(t, 'admin1', baum.djb);
  const ids = (await t.pool.query('select benutzername, id from benutzer')).rows;
  id = Object.fromEntries(ids.map((r) => [r.benutzername, r.id]));
  await t.pool.query(`insert into rollen_berechtigungen (rolle_id, recht, operation) select id, 'pruefung', 'DELEGIEREN' from rollen where schluessel = 'kreis_dan_vorsitzender' and verein_id is null`);
});
afterAll(() => t.schliessen());

const ruf = async (method, url, payload, token = lvAdmin) => {
  const r = await t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() };
};
const rollen = (verband) => `/v2/verbaende/${verband}/rollen`;
const audit = async (aktion, objekt) => (await t.pool.query('select aktion, grund, neu, alt, stellvertreter from audit_log where aktion = $1 and objekt_id = $2 order by id', [aktion, objekt])).rows;
let amt;

describe('Vergabe', () => {
  it('der LV-Admin vergibt im eigenen Teilbaum, auditiert; die Rolle wirkt', async () => {
    const r = await ruf('POST', rollen(baum.kreis), { benutzer_id: id.pruefer1, rolle: 'kreis_dan_vorsitzender', grund: 'Wahl 2026' });
    expect(r.status).toBe(201);
    amt = r.body.id;
    expect(await audit('recht_vergeben', amt)).toMatchObject([{ aktion: 'recht_vergeben', grund: 'Wahl 2026', neu: { rolle: 'kreis_dan_vorsitzender', verband_id: baum.kreis } }]);
    const inhaber = await verbandsToken(t, 'pruefer1', baum.kreis);
    expect((await ruf('GET', '/v2/ich', null, inhaber)).body.rollen).toContain('kreis_dan_vorsitzender');
    expect((await ruf('GET', rollen(baum.kreis))).body.rollen).toHaveLength(1);
  });
  it('außerhalb des Teilbaums wird abgewiesen, ebenso eine Rolle für die falsche Ebene und doppelte Vergabe', async () => {
    expect((await ruf('POST', rollen(fremd.kreis), { benutzer_id: id.schueler1, rolle: 'kreis_dan_vorsitzender' })).status).toBe(404);
    expect((await ruf('GET', rollen(fremd.kreis))).status).toBe(404);
    expect((await ruf('POST', rollen(baum.bezirk), { benutzer_id: id.schueler1, rolle: 'kreis_dan_vorsitzender' })).body).toMatchObject({ status: 422, code: 'rolle_nicht_vergebbar' });
    expect((await ruf('POST', rollen(baum.kreis), { benutzer_id: id.pruefer1, rolle: 'kreis_dan_vorsitzender' })).body).toMatchObject({ status: 409, code: 'rolle_vergeben' });
    expect((await ruf('POST', rollen(baum.kreis), { benutzer_id: '00000000-0000-4000-8000-000000000000', rolle: 'kreis_dan_vorsitzender' })).body).toMatchObject({ code: 'benutzer_unbekannt' });
  });
  it('LV-Admins setzen nur der DJB-Admin oder der Super-Admin ein und ab', async () => {
    expect((await ruf('POST', rollen(baum.lv), { benutzer_id: id.schueler1, rolle: 'lv_admin' })).body).toMatchObject({ status: 422, code: 'rolle_nicht_vergebbar' });
    const r = await ruf('POST', rollen(baum.lv), { benutzer_id: id.schueler1, rolle: 'lv_admin' }, djbAdmin);
    expect(r.status).toBe(201);
    expect((await ruf('DELETE', `${rollen(baum.lv)}/${r.body.id}`, null)).body).toMatchObject({ status: 422, code: 'rolle_nicht_vergebbar' });
    expect((await ruf('DELETE', `${rollen(baum.lv)}/${r.body.id}?grund=Rücktritt`, null, djbAdmin)).status).toBe(200);
    expect((await audit('recht_entzogen', r.body.id))[0]).toMatchObject({ grund: 'Rücktritt' });
    await t.pool.query(`update benutzer set ist_super_admin = true where benutzername = 'eltern1'`);
    const sa = (await t.login('eltern1')).body.access_token;
    const nochmal = await ruf('POST', rollen(baum.lv), { benutzer_id: id.schueler1, rolle: 'lv_admin' }, sa);
    expect(nochmal.status).toBe(201);
    expect((await ruf('DELETE', `${rollen(baum.lv)}/${nochmal.body.id}`, null, sa)).status).toBe(200);
  });
  it('ohne Recht keine Auskunft', async () => {
    const inhaber = await verbandsToken(t, 'pruefer1', baum.kreis);
    expect((await ruf('POST', rollen(baum.kreis), { benutzer_id: id.schueler1, rolle: 'kreis_dan_vorsitzender' }, inhaber)).status).toBe(404);
  });
});

describe('Stellvertreter', () => {
  let s1; let s2;
  it('zwei Stellvertreter gehen, der dritte wird von API und Datenbank abgewiesen und auditiert', async () => {
    const ern = (benutzer, token = lvAdmin) => ruf('POST', `${rollen(baum.kreis)}/${amt}/stellvertreter`, { benutzer_id: benutzer, grund: 'Urlaub' }, token);
    const a = await ern(id.schueler1); const b = await ern(id.eltern1);
    expect([a.status, b.status]).toEqual([201, 201]);
    s1 = a.body.id; s2 = b.body.id;
    expect(await audit('stellvertreter_ernannt', s1)).toMatchObject([{ grund: 'Urlaub', neu: { stellvertreter_von: amt, benutzer_id: id.schueler1 } }]);
    const c = await ern(id.admin1);
    expect(c.body).toMatchObject({ status: 409, code: 'stellvertreter_limit' });
    expect(await audit('stellvertreter_abgewiesen', amt)).toMatchObject([{ grund: 'Urlaub', neu: { benutzer_id: id.admin1 } }]);
    await expect(t.pool.query(`insert into benutzer_verbandsrollen (benutzer_id, verband_id, rolle, stellvertreter_von) values ($1, $2, 'kreis_dan_vorsitzender', $3)`, [id.admin1, baum.kreis, amt]))
      .rejects.toMatchObject({ constraint: 'stellvertreter_hoechstens_zwei' });
  });
  it('Selbsternennung, Ernennung durch einen Stellvertreter und fehlender Grund werden abgewiesen', async () => {
    const inhaber = await verbandsToken(t, 'pruefer1', baum.kreis);
    const url = `${rollen(baum.kreis)}/${amt}/stellvertreter`;
    expect((await ruf('POST', url, { benutzer_id: id.pruefer1, grund: 'ich' }, inhaber)).body).toMatchObject({ code: 'selbsternennung' });
    expect((await ruf('POST', url, { benutzer_id: id.pruefer1, grund: 'ich' })).body).toMatchObject({ code: 'selbsternennung' }); // LV-Admin ist trainer1, Amtsinhaber pruefer1
    expect((await ruf('POST', url, { benutzer_id: id.admin1 }, inhaber)).status).toBe(400);
    const stv = await verbandsToken(t, 'schueler1', baum.kreis);
    expect((await ruf('POST', url, { benutzer_id: id.admin1, grund: 'x' }, stv)).body).toMatchObject({ status: 422, code: 'stellvertreter_darf_nicht_ernennen' });
  });
  it('der Stellvertreter hat die Rechte des Amts, aber kein DELEGIEREN', async () => {
    const inhaber = (await ruf('GET', '/v2/ich', null, await verbandsToken(t, 'pruefer1', baum.kreis))).body;
    const stv = (await ruf('GET', '/v2/ich', null, await verbandsToken(t, 'schueler1', baum.kreis))).body;
    expect(inhaber.berechtigungen).toContain('pruefung:DELEGIEREN');
    expect(stv.berechtigungen).not.toContain('pruefung:DELEGIEREN');
    expect(stv.berechtigungen).toEqual(inhaber.berechtigungen.filter((b) => b !== 'pruefung:DELEGIEREN'));
  });
  it('der Amtsinhaber entzieht mit Grund (auditiert), danach ist wieder Platz', async () => {
    const inhaber = await verbandsToken(t, 'pruefer1', baum.kreis);
    const url = `${rollen(baum.kreis)}/${amt}/stellvertreter/${s1}`;
    expect((await ruf('DELETE', url, null, inhaber)).status).toBe(400);
    expect((await ruf('DELETE', `${url}?grund=Zurück`, null, inhaber)).status).toBe(200);
    expect(await audit('stellvertreter_entzogen', s1)).toMatchObject([{ grund: 'Zurück' }]);
    expect((await ruf('POST', `${rollen(baum.kreis)}/${amt}/stellvertreter`, { benutzer_id: id.admin1, grund: 'neu' }, inhaber)).status).toBe(201);
  });
  it('endet das Amt, enden die Stellvertretungen mit, auditiert', async () => {
    expect((await ruf('DELETE', `${rollen(baum.kreis)}/${amt}?grund=Amtsende`)).status).toBe(200);
    const offen = (await t.pool.query('select count(*)::int n from benutzer_verbandsrollen where verband_id = $1 and beendet_am is null', [baum.kreis])).rows[0].n;
    expect(offen).toBe(0);
    expect((await audit('stellvertreter_entzogen', s2))[0]).toMatchObject({ grund: 'Amt beendet' });
    expect((await ruf('POST', `${rollen(baum.kreis)}/${amt}/stellvertreter`, { benutzer_id: id.admin1, grund: 'x' })).status).toBe(404);
  });
});
