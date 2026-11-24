// Story 2.7 (FR-21, E98): vereinseigene Rollen
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verbandsbaum } from './fabrik.js';
import { neueApp } from './helper.js';

let t; let admin; let verein; let fremd; let id;
beforeAll(async () => {
  t = await neueApp();
  await verbandsbaum(t.pool); // gibt der Demo-App die Verwaltungs-Scopes
  admin = (await t.login('admin1')).body.access_token;
  verein = (await t.pool.query(`select id from vereine where name = 'JC Demo'`)).rows[0].id;
  fremd = (await verbandsbaum(t.pool)).verein;
  id = Object.fromEntries((await t.pool.query('select benutzername, id from benutzer')).rows.map((r) => [r.benutzername, r.id]));
});
afterAll(() => t.schliessen());

const ruf = async (method, url, payload, token = admin) => {
  const r = await t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() };
};
const basis = () => `/v2/vereine/${verein}/rollen`;
let rolle;

describe('Rollen anlegen', () => {
  it('legt eine Rolle aus der Positivliste an, die sich vergeben lässt und wirkt', async () => {
    const r = await ruf('POST', basis(), { name: 'Zeugwart Ü', berechtigungen: ['mitglieder:LESEN', 'graduierung:LESEN'] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ schluessel: 'eigen_zeugwart_ue', berechtigungen: ['graduierung:LESEN', 'mitglieder:LESEN'], vergeben: 0 });
    rolle = r.body.id;
    expect((await ruf('GET', basis())).body.rollen).toHaveLength(1);
    expect((await ruf('POST', `${basis()}/${rolle}/benutzer`, { benutzer_id: id.schueler1 })).status).toBe(201);
    const ich = (await ruf('GET', '/v2/ich', null, (await t.login('schueler1')).body.access_token)).body;
    expect(ich.rollen).toContain('eigen_zeugwart_ue');
    const audit = (await t.pool.query(`select aktion, objekt_art from audit_log where objekt_art = 'vereinsrolle'`)).rows;
    expect(audit).toEqual([{ aktion: 'recht_vergeben', objekt_art: 'vereinsrolle' }]);
  });
  it('lehnt Rechte außerhalb der Positivliste und nicht delegierbare Operationen ab', async () => {
    const neu = (berechtigungen) => ruf('POST', basis(), { name: `X ${berechtigungen[0]}`, berechtigungen });
    expect((await neu(['vereine:LESEN'])).body).toMatchObject({ status: 422, code: 'recht_nicht_erlaubt' });
    expect((await neu(['mitglieder:DELEGIEREN'])).body).toMatchObject({ code: 'recht_nicht_erlaubt' });
    expect((await neu(['mitglieder:LOESCHEN'])).body).toMatchObject({ code: 'recht_nicht_delegierbar' }); // nur der LV
    expect((await neu(['ueberweisung:LESEN'])).body).toMatchObject({ code: 'recht_nicht_delegierbar' }); // selbst nicht gehalten
    expect((await neu(['gibt:LESEN'])).body).toMatchObject({ code: 'recht_unbekannt' });
    expect((await ruf('PATCH', `${basis()}/${rolle}`, { berechtigungen: ['vereine:LESEN'] })).body).toMatchObject({ code: 'recht_nicht_erlaubt' });
    expect((await ruf('GET', basis())).body.rollen).toHaveLength(1);
    // die Datenbank hält die Positivliste auch ohne die API
    await expect(t.pool.query(`insert into rollen_berechtigungen (rolle_id, recht, operation) values ($1, 'vereine', 'LESEN')`, [rolle])).rejects.toMatchObject({ constraint: 'vereinsrolle_recht_nicht_erlaubt' });
  });
  it('ändert Namen und Rechte', async () => {
    const r = await ruf('PATCH', `${basis()}/${rolle}`, { name: 'Zeugwart', berechtigungen: ['mitglieder:LESEN'] });
    expect(r.body).toMatchObject({ name: 'Zeugwart', berechtigungen: ['mitglieder:LESEN'], vergeben: 1 });
  });
  it('gibt nur dem eigenen Verein Auskunft und nur an Mitglieder', async () => {
    expect((await ruf('GET', `/v2/vereine/${fremd}/rollen`)).status).toBe(404);
    expect((await ruf('POST', `/v2/vereine/${fremd}/rollen`, { name: 'X', berechtigungen: [] })).status).toBe(404);
    expect((await ruf('POST', `${basis()}/${rolle}/benutzer`, { benutzer_id: '00000000-0000-4000-8000-000000000000' })).body).toMatchObject({ code: 'kein_vereinsmitglied' });
    expect((await ruf('POST', `${basis()}/${rolle}/benutzer`, { benutzer_id: id.schueler1 })).body).toMatchObject({ code: 'rolle_vergeben' });
    const schueler = (await t.login('schueler1')).body.access_token;
    expect((await ruf('GET', basis(), null, schueler)).status).toBe(404);
  });
});

describe('Rollen löschen', () => {
  it('eine vergebene Rolle wird abgewiesen, eine freie gelöscht', async () => {
    expect((await ruf('DELETE', `${basis()}/${rolle}`)).body).toMatchObject({ status: 409, code: 'rolle_vergeben' });
    expect((await ruf('DELETE', `${basis()}/${rolle}/benutzer/${id.schueler1}`)).status).toBe(200);
    const entzogen = (await t.pool.query(`select aktion from audit_log where objekt_art = 'vereinsrolle' order by id`)).rows.map((r) => r.aktion);
    expect(entzogen).toEqual(['recht_vergeben', 'recht_entzogen']);
    expect((await ruf('DELETE', `${basis()}/${rolle}`)).status).toBe(200);
    expect((await ruf('GET', basis())).body.rollen).toEqual([]);
    expect((await ruf('DELETE', `${basis()}/${rolle}`)).status).toBe(404);
  });
});
