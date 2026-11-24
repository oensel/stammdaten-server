// Story 2.1 (FR-20, FR-21, FR-25): Katalog, Operationen, Systemrollen
import { afterAll, beforeAll, expect, it } from 'vitest';
import { darf } from '../src/module/rechte/dienst.js';
import { BASISRECHTE, KATALOG, kennt } from '../src/module/rechte/katalog.js';
import { baueCtx, systemCtx } from '../src/pipeline/ctx.js';
import { neueApp } from './helper.js';

let t;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
beforeAll(async () => { t = await neueApp(); });
afterAll(() => t.schliessen());
const ohneRollen = baueCtx({ benutzer: { id: 'x' }, anwendung: 'kyu-manager-pro', jetzt: new Date() });

it('der Katalog im Code und in der Datenbank stimmen überein', async () => {
  const db = {};
  for (const { recht, operation } of await q('select recht, operation from rechte_operationen')) (db[recht] ??= []).push(operation);
  const sortiert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort()]));
  expect(sortiert(db)).toEqual(sortiert(KATALOG));
  expect(BASISRECHTE.filter((r) => !kennt(r))).toEqual([]);
});

it('enthält alle Seed-Rollen aus FR-21 als Systemrollen', async () => {
  expect((await q('select schluessel from rollen where ist_system order by 1')).map((r) => r.schluessel)).toEqual([
    'admin', 'bezirks_dan_beauftragter', 'dan_pruefungsorganisation', 'djb_admin', 'kassenpruefer', 'kassierer', 'kreis_dan_vorsitzender',
    'landesvertreter', 'lehrgangsfreigabe', 'lv_admin', 'mitglied', 'super_admin', 'trainer', 'veranstalter_admin_verband',
    'veranstalter_admin_verein', 'verbandskassierer']);
});

it('Systemrollen sind nicht löschbar und nicht umwidmbar, andere schon', async () => {
  await expect(q(`delete from rollen where schluessel = 'trainer'`)).rejects.toMatchObject({ constraint: 'systemrolle_geschuetzt' });
  await expect(q(`update rollen set ist_system = false where schluessel = 'trainer'`)).rejects.toMatchObject({ constraint: 'systemrolle_geschuetzt' });
  await q(`insert into rollen (schluessel, name, ebene, verein_id) select 'eigene', 'Eigene', 'verein', id from vereine limit 1`);
  await q(`delete from rollen where schluessel = 'eigene'`);
  expect(await q(`select 1 from rollen where schluessel = 'eigene'`)).toEqual([]);
});

it('eine nicht definierte Operation ist nicht vergebbar', async () => {
  const vergib = (recht, operation) => q(`insert into rollen_berechtigungen select id, $1, $2 from rollen where schluessel = 'mitglied'`, [recht, operation]);
  await expect(vergib('ueberweisung', 'LOESCHEN')).rejects.toMatchObject({ constraint: 'operation_nicht_definiert' });
  await expect(vergib('gibt_es_nicht', 'LESEN')).rejects.toMatchObject({ constraint: 'operation_nicht_definiert' });
  expect(() => darf(ohneRollen, 'ueberweisung:LOESCHEN')).toThrow('Unbekanntes Recht');
  expect(() => darf(ohneRollen, 'constructor:LESEN')).toThrow('Unbekanntes Recht');
});

it('Basisrechte hat jeder Angemeldete, aber kein Systemlauf; sonst nichts', () => {
  for (const r of ['lehrgang:ANLEGEN', 'turnier:ANLEGEN', 'veranstaltung:ANLEGEN', 'mitgliedschaftsantrag:ANLEGEN']) {
    expect(darf(ohneRollen, r)).toBe(true);
    expect(darf(systemCtx('probe'), r)).toBe(false);
  }
  for (const r of ['mitglieder:LESEN', 'lehrgang:LESEN', 'verbandsbaum:AENDERN']) expect(darf(ohneRollen, r)).toBe(false);
});

it('/v1 kennt die neuen Rechte nicht, Tokens behalten die Kurzform', async () => {
  expect((await t.login('trainer1')).body.benutzer.vereine[0].rechte).toEqual(['trainer']);
  const admin = (await t.login('admin1')).body.access_token;
  const ziel = (await q(`select id from benutzer where benutzername = 'schueler1'`))[0].id;
  expect((await t.api('PUT', `/benutzer/${ziel}/rechte/mitglieder`, {}, admin)).status).toBe(404);
});

it('GET /v2/rechtekatalog: Admin ja, Mitglied 404', async () => {
  const hole = async (n) => t.api('GET', '/v2/rechtekatalog', null, (await t.login(n)).body.access_token);
  const r = await hole('admin1');
  expect(r.status).toBe(200);
  expect(r.body.rollen.find((x) => x.schluessel === 'kassenpruefer').berechtigungen).toEqual(['beitraege:LESEN', 'ueberweisung:LESEN']);
  expect((await hole('schueler1')).status).toBe(404);
});
