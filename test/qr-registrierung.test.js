// Story 2.10 (FR-14): Registrierung per Vereins-QR-Code
import { afterAll, beforeAll, expect, it } from 'vitest';
import { neueApp, PW } from './helper.js';

let t; let verein; let admin; let uhr = new Date('2030-01-01T10:00:00Z');
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
beforeAll(async () => {
  t = await neueApp({ uhr: () => uhr });
  verein = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  admin = (await t.login('admin1')).body.access_token;
});
afterAll(() => t.schliessen());

const neuerCode = async (tok = admin, v = verein, body = {}) => t.api('POST', `/v2/vereine/${v}/qr-codes`, body, tok);
const registriere = (token, benutzername, extra = {}) => t.api('POST', '/v2/auth/registrieren', { token, benutzername, vorname: 'Nora', nachname: 'Neu', passwort: PW, ...extra });
const konten = async () => (await q('select count(*)::int n from benutzer'))[0].n;

it('Registrierung: angefragt, keine Anmeldung, Admin wird benachrichtigt; nach Freigabe Anmeldung als Mitglied', async () => {
  const code = await neuerCode();
  expect(code.status).toBe(201);
  expect((await q('select token_hash from vereins_qr_codes'))[0].token_hash).not.toContain(code.body.token);
  const r = await registriere(code.body.token, 'nora');
  expect(r).toMatchObject({ status: 201, body: { verein_id: verein, status: 'angefragt' } });
  expect((await t.login('nora')).body.code).toBe('kein_verein');
  expect(await q(`select b.benutzername, n.text from nachrichten n join benutzer b on b.id = n.benutzer_id`)).toEqual([
    { benutzername: 'admin1', text: expect.stringContaining('Nora Neu') }]);

  const z = (await t.api('GET', `/v2/vereine/${verein}/zugehoerigkeiten?status=angefragt`, null, admin)).body.zugehoerigkeiten;
  expect(z).toMatchObject([{ benutzername: 'nora' }]);
  const f = await t.app.inject({ method: 'PATCH', url: `/v2/vereine/${verein}/zugehoerigkeiten/${z[0].id}`, payload: { entscheidung: 'freigeben' }, headers: { authorization: `Bearer ${admin}`, 'if-match': `"${z[0].change_seq}"` } });
  expect(f.statusCode).toBe(200);
  expect((await t.login('nora')).body.benutzer.vereine).toMatchObject([{ id: verein, rolle: 'mitglied', rechte: [] }]);
});

it('abgelaufene, widerrufene und unbekannte Codes erzeugen nichts', async () => {
  const kurz = (await neuerCode(admin, verein, { gueltig_tage: 1 })).body;
  const weg = (await neuerCode()).body;
  expect((await t.api('POST', `/v2/vereine/${verein}/qr-codes/${weg.id}/widerrufen`, null, admin)).body.widerrufen_am).toBeTruthy();
  const vorher = await konten();
  uhr = new Date(uhr.getTime() + 2 * 86_400_000);
  for (const token of [kurz.token, weg.token, 'x'.repeat(43)]) {
    expect((await registriere(token, 'niemand')).body).toMatchObject({ status: 404, code: 'nicht_gefunden' });
    expect((await t.api('POST', '/v2/zugehoerigkeiten', { token }, admin)).status).toBe(404);
  }
  expect(await konten()).toBe(vorher);
});

it('nur Admins des Vereins verwalten Codes', async () => {
  const trainer = (await t.login('trainer1')).body.access_token;
  const fremd = (await q(`insert into vereine (name, verband_id) select 'Fremd', id from verbaende where typ = 'kreis' limit 1 returning id`))[0].id;
  expect((await neuerCode(trainer)).status).toBe(404);
  expect((await neuerCode(admin, fremd)).status).toBe(404);
  expect((await t.api('GET', `/v2/vereine/${verein}/qr-codes`, null, trainer)).status).toBe(404);
  const liste = (await t.api('GET', `/v2/vereine/${verein}/qr-codes`, null, admin)).body.qr_codes;
  expect(liste).toHaveLength(3);
  expect(liste[0]).not.toHaveProperty('token');
  expect((await t.api('POST', `/v2/vereine/${verein}/qr-codes/${liste[0].id}/widerrufen`, null, trainer)).status).toBe(404);
});

it('prüft Passwort und Benutzername; Konflikte hinterlassen nichts', async () => {
  const { token } = (await neuerCode()).body;
  const vorher = await konten();
  expect((await registriere(token, 'kurz', { passwort: 'abc' })).body.code).toBe('passwort_zu_kurz');
  expect((await registriere(token, 'ADMIN1')).body).toMatchObject({ status: 409, code: 'schon_vorhanden' });
  expect((await registriere(token, 'mit leer')).status).toBe(400);
  expect(await konten()).toBe(vorher);
  // Rolle oder Super-Admin lassen sich nicht mitgeben
  await registriere(token, 'schlau', { rolle: 'admin', ist_super_admin: true, email: 'a@example.org' });
  expect(await q(`select b.ist_super_admin, b.email, bv.rolle, bv.status from benutzer b join benutzer_vereine bv on bv.benutzer_id = b.id where benutzername = 'schlau'`))
    .toEqual([{ ist_super_admin: false, email: null, rolle: 'mitglied', status: 'angefragt' }]);
});

it('begrenzt offene Anfragen je Verein', async () => {
  const { token } = (await neuerCode()).body;
  await q(`with b as (insert into benutzer (benutzername) select 'flut' || g from generate_series(1, 100) g returning id)
           insert into benutzer_vereine (benutzer_id, verein_id) select id, $1 from b`, [verein]);
  expect((await registriere(token, 'einer-zuviel')).body).toMatchObject({ status: 429, code: 'zu_viele_versuche' });
});
