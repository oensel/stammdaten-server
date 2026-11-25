// Story 3.7 (FR-8, E81, E99): Austritt
import { afterEach, beforeEach, expect, it } from 'vitest';
import { gibRolle, verbandsbaum, verbandsToken } from './fabrik.js';
import { CLIENT, neueApp } from './helper.js';
import { fuehreAus } from '../src/worker.js';

let t; let jc; let baum; let uhr; let id; let thomas;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const tok = async (n) => (await t.login(n)).body.access_token;
beforeEach(async () => {
  uhr = new Date('2030-06-15T10:00:00Z');
  t = await neueApp({ uhr: () => uhr });
  baum = await verbandsbaum(t.pool);
  await q(`update anwendungen set scopes = scopes || '{mitglieder:schreiben,mitglieder:kontakt}' where schluessel = $1`, [CLIENT]);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  await q('update vereine set verband_id = $2 where id = $1', [jc, baum.kreis]);
  id = Object.fromEntries((await q('select benutzername, id from benutzer')).map((x) => [x.benutzername, x.id]));
  thomas = (await q('select mitglied_id m from benutzer_vereine where benutzer_id = $1', [id.trainer1]))[0].m
    ?? (await q(`select id m from mitglieder where vorname = 'Thomas'`))[0].m;
  await q('update benutzer_vereine set mitglied_id = null where mitglied_id = $1', [thomas]);
  await q('update benutzer_vereine set mitglied_id = $2 where benutzer_id = $1', [id.trainer1, thomas]);
  await q('update mitglieder set eintritt = null, austritt = null where id = $1', [thomas]);
});
afterEach(() => t.schliessen());

const zeile = async () => (await q('select status, austritt, kuendigung_am, change_seq, person_id from mitglieder where id = $1', [thomas]))[0];
async function setze(body, token, extra = {}) {
  const r = await t.app.inject({ method: 'PATCH', url: `/v2/vereine/${jc}/mitglieder/${thomas}/austritt`, payload: body, headers: { authorization: `Bearer ${token ?? await tok('admin1')}`, 'if-match': `"${(await zeile()).change_seq}"`, ...extra } });
  return { status: r.statusCode, body: r.json() };
}
const rechte = async () => (await q('select count(*)::int n from benutzer_rechte where benutzer_id = $1 and geloescht_am is null', [id.trainer1]))[0].n;

it('der Austritt lässt Heimatverein, Person und Historie stehen und beendet Rollen und Direktrechte', async () => {
  const vorher = await zeile();
  const p = (await q('select * from personen where id = $1', [vorher.person_id]))[0];
  expect(p.heimatverein_id).toBe(jc);
  expect(await rechte()).toBeGreaterThan(0);
  await q(`insert into delegationen (empfaenger_id, geber_id, verein_id, recht, operation, gueltig_von, gueltig_bis, delegiert_aus_quelle, delegiert_aus_schluessel)
    values ($1,$2,$3,'mitglieder','LESEN','2030-01-01','2030-12-31','rolle','admin')`, [id.trainer1, id.admin1, jc]);
  const r = await setze({ austritt: '2030-06-15', kuendigung_am: '2030-05-01' });
  expect(r).toMatchObject({ status: 200, body: { status: 'ausgetreten', austritt: '2030-06-15', kuendigung_am: '2030-05-01' } });
  const nach = (await q('select * from personen where id = $1', [vorher.person_id]))[0];
  expect(nach).toMatchObject({ heimatverein_id: jc, vorname: p.vorname, geburtsdatum: p.geburtsdatum, benutzer_id: p.benutzer_id });
  expect(await rechte()).toBe(0);
  expect(await q('select 1 from delegationen where empfaenger_id = $1 and beendet_am is null', [id.trainer1])).toEqual([]);
  const ich = (await t.api('GET', '/v2/ich', null, await tok('trainer1'))).body; // Anmeldung bleibt, aber nur als Mitglied
  expect(ich.rollen).not.toContain('trainer');
  expect(ich.berechtigungen).not.toContain('mitglieder:LESEN');
  expect(await q(`select benutzer_id from audit_log where aktion = 'recht_entzogen' and grund = 'Austritt'`)).toEqual([{ benutzer_id: id.admin1 }]);
  expect((await setze({ austritt: null })).body.code).toBe('status_unzulaessig');
});

it('ein künftiger Austritt wirkt erst am Tag, durch den Worker, und lässt sich vorher zurücknehmen', async () => {
  expect((await setze({ austritt: '2030-12-31' })).body.status).toBe('aktiv');
  expect(await rechte()).toBeGreaterThan(0);
  expect((await setze({ austritt: null })).body.austritt).toBe(null);
  await setze({ austritt: '2030-12-31' });
  const lauf = (d) => fuehreAus(t.pool, 'austritte', {}, { jetzt: new Date(d) });
  await lauf('2030-12-30T12:00:00Z');
  expect((await zeile()).status).toBe('aktiv');
  expect(await lauf('2030-12-31T12:00:00Z')).toEqual({ vollzogen: 1 });
  expect((await zeile()).status).toBe('ausgetreten');
  expect(await rechte()).toBe(0);
  expect(await lauf('2030-12-31T13:00:00Z')).toEqual({ vollzogen: 0 });
  expect(await q(`select anwendung from audit_log where grund = 'Austritt'`)).toHaveLength(1);
});

it('nur der eigene Verein mit Änderungsrecht; Trainer, Mitglied und Verbandsrolle nicht', async () => {
  for (const wer of ['trainer1', 'schueler1', 'eltern1']) expect((await setze({ austritt: '2030-06-15' }, await tok(wer))).status).toBe(404);
  await gibRolle(t.pool, 'pruefer1', 'landesvertreter', baum.lv);
  expect((await setze({ austritt: '2030-06-15' }, await verbandsToken(t, 'pruefer1', baum.lv))).status).toBe(404);
  expect((await zeile()).status).toBe('aktiv');
});

it('Versionen, Datumsregeln und der letzte Admin', async () => {
  await q(`update mitglieder set eintritt = '2025-01-01' where id = $1`, [thomas]);
  expect((await setze({ austritt: '2024-12-31' })).body.code).toBe('austritt_ungueltig');
  expect((await setze({ austritt: '2030-06-15', kuendigung_am: '2030-06-16' })).body.code).toBe('austritt_ungueltig');
  expect((await setze({ austritt: '2030-06-15' }, null, { 'if-match': '"1"' })).body.code).toBe('version_veraltet');
  await q(`update benutzer_vereine set mitglied_id = null where mitglied_id = $1`, [thomas]);
  await q(`update benutzer_vereine set mitglied_id = $2 where benutzer_id = $1 and verein_id = $3`, [id.admin1, thomas, jc]);
  await q(`update benutzer_vereine set rolle = 'mitglied' where verein_id = $1 and rolle = 'admin' and benutzer_id <> $2`, [jc, id.admin1]);
  expect((await setze({ austritt: '2030-06-15' })).body.code).toBe('letzter_admin');
  expect((await zeile()).status).toBe('aktiv');
});
