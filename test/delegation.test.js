// Story 2.8 (FR-22, E6, E102): Delegation
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filterEngerOderGleich } from '../src/module/rechte/filter.js';
import { verbandsbaum } from './fabrik.js';
import { neueApp } from './helper.js';

let t; let admin; let trainer; let verein; let id;
beforeAll(async () => {
  t = await neueApp();
  await verbandsbaum(t.pool); // Verwaltungs-Scopes für die Demo-App
  admin = (await t.login('admin1')).body.access_token;
  trainer = (await t.login('trainer1')).body.access_token;
  verein = (await t.pool.query(`select id from vereine where name = 'JC Demo'`)).rows[0].id;
  id = Object.fromEntries((await t.pool.query('select benutzername, id from benutzer')).rows.map((r) => [r.benutzername, r.id]));
  // Test-Annahme: Trainer dürfen Mitgliederdaten delegieren (die Seed-Matrix vergibt das heute nicht)
  await t.pool.query(`insert into rollen_berechtigungen (rolle_id, recht, operation) select id, 'mitglieder', 'DELEGIEREN' from rollen where schluessel = 'trainer' and verein_id is null`);
});
afterAll(() => t.schliessen());

const ruf = async (method, url, payload, token = admin, header = {}) => {
  const r = await t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, ...header } });
  return { status: r.statusCode, body: r.json() };
};
const in_tagen = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const delegiere = (extra, token = admin) => ruf('POST', '/v2/delegationen', { empfaenger_id: id.schueler1, recht: 'mitglieder:LESEN', verein_id: verein, gueltig_bis: in_tagen(365), ...extra }, token);
const audit = async (aktion, objekt) => (await t.pool.query('select aktion, grund, alt, neu from audit_log where aktion = $1 and objekt_id = $2', [aktion, objekt])).rows;

describe('Filter enger oder gleich', () => {
  const f = (x) => ({ nur_aktive: false, felder: null, ...x });
  it('vergleicht je Spalte', () => {
    expect(filterEngerOderGleich(null, null)).toBe(true);
    expect(filterEngerOderGleich(f({}), null)).toBe(true);
    expect(filterEngerOderGleich(null, f({ nur_aktive: true }))).toBe(false);
    expect(filterEngerOderGleich(f({}), f({ nur_aktive: true }))).toBe(false);
    expect(filterEngerOderGleich(f({ nur_aktive: true }), f({ nur_aktive: true }))).toBe(true);
    expect(filterEngerOderGleich(f({ subjekt_min_rang: 9 }), f({ subjekt_min_rang: 8 }))).toBe(true);
    expect(filterEngerOderGleich(f({ subjekt_min_rang: 7 }), f({ subjekt_min_rang: 8 }))).toBe(false);
    expect(filterEngerOderGleich(f({}), f({ subjekt_min_rang: 8 }))).toBe(false);
    expect(filterEngerOderGleich(f({ wert_min_rang: 3, wert_max_rang: 5 }), f({ wert_min_rang: 2, wert_max_rang: 8 }))).toBe(true);
    expect(filterEngerOderGleich(f({ wert_min_rang: 3, wert_max_rang: 9 }), f({ wert_min_rang: 2, wert_max_rang: 8 }))).toBe(false);
    expect(filterEngerOderGleich(f({ wert_art: 'dan' }), f({ wert_art: 'kyu' }))).toBe(false);
    expect(filterEngerOderGleich(f({ subjekt_lizenz: 'judopass' }), f({ subjekt_lizenz: 'trainer' }))).toBe(false);
    expect(filterEngerOderGleich(f({ wert_bis_eigener_grad: false }), f({ wert_bis_eigener_grad: true }))).toBe(false);
  });
  it('vergleicht Feldgruppen und Felder als Teilmenge', () => {
    expect(filterEngerOderGleich(f({ felder: ['stamm'] }), f({ felder: null }))).toBe(true);
    expect(filterEngerOderGleich(f({ felder: null }), f({ felder: ['stamm'] }))).toBe(false);
    expect(filterEngerOderGleich(f({ felder: ['vorname', 'nachname'] }), f({ felder: ['stamm'] }))).toBe(true);
    expect(filterEngerOderGleich(f({ felder: ['stamm', 'kontakt'] }), f({ felder: ['stamm'] }))).toBe(false);
    expect(filterEngerOderGleich(f({ felder: ['email'] }), f({ felder: ['stamm'] }))).toBe(false);
  });
});

describe('Vergabe', () => {
  it('der Admin gibt ein Recht im eigenen Bereich weiter, es wirkt für den Empfänger, auditiert', async () => {
    const r = await delegiere({ datenfilter: 'ohne_kontakt', grund: 'Vertretung' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ recht: 'mitglieder', operation: 'LESEN', delegiert_aus_quelle: 'rolle', delegiert_aus_schluessel: 'admin', verwaist_seit: null });
    expect(await audit('recht_vergeben', r.body.id)).toMatchObject([{ grund: 'Vertretung', neu: { empfaenger_id: id.schueler1 } }]);
    const ich = (await ruf('GET', '/v2/ich', null, (await t.login('schueler1')).body.access_token)).body;
    expect(ich.rollen).toContain('delegation');
    expect(ich.berechtigungen).toContain('mitglieder:LESEN');
  });
  it('weist weitere Frist, Bereich, Operation und Weiterdelegation ab', async () => {
    const fremd = (await verbandsbaum(t.pool)).verein;
    expect((await delegiere({ gueltig_bis: in_tagen(731 + 1) })).body).toMatchObject({ status: 422, code: 'frist_ungueltig' });
    expect((await delegiere({ gueltig_bis: '2000-01-01' })).body).toMatchObject({ code: 'frist_ungueltig' });
    expect((await ruf('POST', '/v2/delegationen', { empfaenger_id: id.schueler1, recht: 'mitglieder:LESEN', verein_id: verein }, admin)).status).toBe(400); // ohne Enddatum
    expect((await delegiere({ verein_id: fremd })).body).toMatchObject({ status: 422, code: 'bereich_zu_weit' });
    expect((await delegiere({ recht: 'ueberweisung:LESEN' })).body).toMatchObject({ code: 'recht_nicht_delegierbar' }); // selbst nicht gehalten
    expect((await delegiere({ recht: 'mitglieder:DELEGIEREN' })).body).toMatchObject({ code: 'delegieren_nur_super_admin' });
    expect((await delegiere({ empfaenger_id: id.admin1 })).body).toMatchObject({ code: 'selbstdelegation' });
    expect((await delegiere({ datenfilter: 'gibt_es_nicht' })).body).toMatchObject({ code: 'datenfilter_unbekannt' });
    // nur eine Ebene: wer nur delegiert bekommen hat, hat kein DELEGIEREN
    const schueler = (await t.login('schueler1')).body.access_token;
    expect((await delegiere({ empfaenger_id: id.pruefer1 }, schueler)).status).toBe(404);
    // der Empfänger gehört dem Verein an
    expect((await delegiere({ empfaenger_id: '00000000-0000-4000-8000-000000000000' })).status).toBeGreaterThanOrEqual(404);
  });
  it('weist einen weiteren Datenfilter ab, ein engerer oder gleicher geht', async () => {
    const trainerDelegiert = (datenfilter) => delegiere({ empfaenger_id: id.pruefer1, ...(datenfilter ? { datenfilter } : {}) }, trainer);
    expect((await trainerDelegiert()).body).toMatchObject({ status: 422, code: 'filter_zu_weit' });
    expect((await trainerDelegiert('alle_ohne_kontakt')).body).toMatchObject({ code: 'filter_zu_weit' });
    expect((await trainerDelegiert('ohne_kontakt')).status).toBe(201);
    expect((await trainerDelegiert('ab_2_kyu_ohne_kontakt')).status).toBe(201);
  });
  it('DELEGIEREN vergibt nur der Super-Admin; das Merkmal ist per API nicht setzbar', async () => {
    await t.pool.query(`update benutzer set ist_super_admin = true where benutzername = 'eltern1'`);
    const sa = (await t.login('eltern1')).body.access_token;
    const r = await delegiere({ recht: 'mitglieder:DELEGIEREN', empfaenger_id: id.pruefer1 }, sa);
    expect(r.status).toBe(201);
    expect((await t.pool.query('select vergeben_durch_super_admin v, delegiert_aus_quelle q from delegationen where id = $1', [r.body.id])).rows[0]).toEqual({ v: true, q: null });
    // ein mitgeschicktes Merkmal wird verworfen, der Trigger leitet es aus dem Geber ab
    const versuch = await delegiere({ vergeben_durch_super_admin: true });
    expect(versuch.status).toBe(201);
    expect((await t.pool.query('select vergeben_durch_super_admin v from delegationen where id = $1', [versuch.body.id])).rows[0].v).toBe(false);
    // auch an der Datenbank vorbei: ohne Quelle nur der Super-Admin, nie DELEGIEREN mit Quelle
    const roh = (geber, op, quelle) => t.pool.query(
      `insert into delegationen (empfaenger_id, geber_id, verein_id, recht, operation, gueltig_von, gueltig_bis, delegiert_aus_quelle, delegiert_aus_schluessel)
       values ($1, $2, $3, 'mitglieder', $4, current_date, current_date + 10, $5, $6)`, [id.schueler1, geber, verein, op, quelle, quelle && 'admin']);
    await expect(roh(id.admin1, 'LESEN', null)).rejects.toMatchObject({ constraint: 'delegation_ohne_quelle' });
    await expect(roh(id.admin1, 'DELEGIEREN', 'rolle')).rejects.toMatchObject({ constraint: 'delegieren_nur_super_admin' });
    await expect(roh(id.eltern1, 'DELEGIEREN', 'rolle')).rejects.toMatchObject({ constraint: 'keine_weiterdelegation' });
    await expect(roh(id.eltern1, 'LESEN', 'rolle').then(() => t.pool.query(`select 1`))).resolves.toBeTruthy(); // Super-Admin darf auch mit Quelle
  });
});

describe('Ablauf, Entzug und verwaiste Delegationen', () => {
  it('abgelaufene Delegationen wirken nicht mehr', async () => {
    const r = await delegiere({ empfaenger_id: id.eltern1, recht: 'graduierung:LESEN' });
    expect(r.status).toBe(201);
    const token = (await t.login('eltern1')).body.access_token;
    expect((await ruf('GET', '/v2/ich', null, token, { 'x-verein': verein })).body.berechtigungen).toContain('graduierung:LESEN');
    await t.pool.query('update delegationen set gueltig_bis = current_date - 1, gueltig_von = current_date - 5 where id = $1', [r.body.id]);
    expect((await ruf('GET', '/v2/ich', null, token, { 'x-verein': verein })).body.berechtigungen).not.toContain('graduierung:LESEN');
  });
  it('der Geber und der Admin entziehen, Fremde nicht, auditiert', async () => {
    const r = await delegiere({ empfaenger_id: id.pruefer1, recht: 'mitglieder:AENDERN' });
    const fremd = (await t.login('pruefer1')).body.access_token;
    expect((await ruf('DELETE', `/v2/delegationen/${r.body.id}`, null, fremd)).status).toBe(404);
    expect((await ruf('DELETE', `/v2/delegationen/${r.body.id}?grund=Fehler`, null, admin)).status).toBe(200);
    expect(await audit('recht_entzogen', r.body.id)).toMatchObject([{ grund: 'Fehler' }]);
    expect((await ruf('DELETE', `/v2/delegationen/${r.body.id}`, null, admin)).status).toBe(404);
  });
  it('verliert der Geber seine Rolle, zeigt der Server die Delegationen als verwaist; der Admin entzieht sie gesammelt', async () => {
    const eigene = async () => (await ruf('GET', `/v2/delegationen?verein_id=${verein}`)).body.delegationen.filter((d) => d.geber_id === id.trainer1);
    expect((await eigene()).length).toBeGreaterThan(0);
    expect((await ruf('GET', `/v2/delegationen?verein_id=${verein}&verwaist=true`)).body.delegationen).toEqual([]);
    const z = (await t.pool.query('select id, change_seq from benutzer_vereine where benutzer_id = $1 and verein_id = $2', [id.trainer1, verein])).rows[0];
    expect((await ruf('PATCH', `/v2/vereine/${verein}/zugehoerigkeiten/${z.id}`, { entscheidung: 'entziehen', grund: 'Austritt' }, admin, { 'if-match': `"${z.change_seq}"` })).status).toBe(200);
    const verwaist = (await ruf('GET', `/v2/delegationen?verein_id=${verein}&verwaist=true`)).body.delegationen;
    expect(verwaist.map((d) => d.geber_id)).toEqual(expect.arrayContaining([id.trainer1]));
    expect(verwaist.every((d) => d.verwaist_seit)).toBe(true);
    // außenstehende sehen nichts
    expect((await ruf('GET', `/v2/delegationen?verein_id=${verein}`, null, (await t.login('schueler1')).body.access_token)).status).toBe(404);
    const weg = await ruf('POST', '/v2/delegationen/entziehen', { verein_id: verein, verwaist: true, grund: 'Geber ausgeschieden' });
    expect(weg.body.entzogen).toBe(verwaist.length);
    expect((await ruf('GET', `/v2/delegationen?verein_id=${verein}&verwaist=true`)).body.delegationen).toEqual([]);
    expect(await audit('recht_entzogen', verwaist[0].id)).toMatchObject([{ grund: 'Geber ausgeschieden' }]);
    expect((await ruf('POST', '/v2/delegationen/entziehen', { verein_id: verein, grund: 'x' })).status).toBe(400);
  });
  it('alle Delegationen eines Gebers lassen sich in einem Schritt entziehen', async () => {
    await delegiere({ empfaenger_id: id.pruefer1, recht: 'mitglieder:ANLEGEN' });
    await delegiere({ empfaenger_id: id.pruefer1, recht: 'mitglieder:AENDERN' });
    const r = await ruf('POST', '/v2/delegationen/entziehen', { verein_id: verein, geber_id: id.admin1, grund: 'Missbrauch' });
    expect(r.body.entzogen).toBeGreaterThanOrEqual(2);
    expect((await ruf('GET', `/v2/delegationen?verein_id=${verein}`)).body.delegationen.filter((d) => d.geber_id === id.admin1)).toEqual([]);
  });
});
