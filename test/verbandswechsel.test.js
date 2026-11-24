// Story 1.5 (FR-2): Verein wechselt den Verband
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { liegtUnter } from '../src/module/organisation/dienst.js';
import { gibRolle, verband, verbandsbaum, verbandsToken } from './fabrik.js';
import { neueApp } from './helper.js';

let t; let a; let b; let token;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
beforeAll(async () => {
  t = await neueApp();
  a = await verbandsbaum(t.pool); b = await verbandsbaum(t.pool);
  await gibRolle(t.pool, 'trainer1', 'djb_admin', a.djb);
  await gibRolle(t.pool, 'pruefer1', 'lv_admin', a.lv);
  await gibRolle(t.pool, 'eltern1', 'lv_admin', b.lv);
  const c = await verbandsbaum(t.pool);
  await gibRolle(t.pool, 'schueler1', 'lv_admin', c.lv); // unbeteiligt
  token = await verbandsToken(t, 'trainer1', a.djb);
});
afterAll(() => t.schliessen());
beforeEach(() => t.pool.query('delete from nachrichten; delete from mail_auftraege'));

const wechsle = async (kreis) => {
  const { change_seq } = (await q('select change_seq from vereine where id = $1', [a.verein]))[0];
  return t.app.inject({ method: 'PATCH', url: `/v2/vereine/${a.verein}`, payload: { verband_id: kreis }, headers: { authorization: `Bearer ${token}`, 'if-match': `"${change_seq}"` } });
};
const unter = (lv) => liegtUnter(null, t.pool, { nachfahr_id: a.verein, vorfahr_id: lv });
const benachrichtigt = async (tabelle) => (await q(`select b.benutzername from ${tabelle} n join benutzer b on b.id = n.benutzer_id order by 1`)).map((r) => r.benutzername);

it('wechselt in einen anderen Landesverband: Pfade, Audit, beide LV benachrichtigt', async () => {
  expect([await unter(a.lv), await unter(b.lv)]).toEqual([true, false]);
  expect((await wechsle(b.kreis)).statusCode).toBe(200);
  expect([await unter(a.lv), await unter(b.lv)]).toEqual([false, true]);
  expect((await q(`select aktion, alt, neu, akteur is not null as akteur from audit_log where objekt_id = $1`, [a.verein]))).toMatchObject([
    { aktion: 'verein_verbandswechsel', alt: { verband_id: a.kreis }, neu: { verband_id: b.kreis }, akteur: true }]);
  expect(await benachrichtigt('nachrichten')).toEqual(['eltern1', 'pruefer1']);
  expect(await benachrichtigt('mail_auftraege')).toEqual(['eltern1', 'pruefer1']);
});

it('ein Wechsel innerhalb des Landesverbands wird auditiert, aber nicht gemeldet', async () => {
  expect((await wechsle(await verband(t.pool, 'kreis', b.bezirk))).statusCode).toBe(200);
  expect((await q(`select aktion from audit_log where objekt_id = $1 order by id desc limit 1`, [a.verein]))[0].aktion).toBe('verein_verbandswechsel');
  expect(await benachrichtigt('nachrichten')).toEqual([]);
});

it('ein abgelehnter Wechsel hinterlässt nichts', async () => {
  const vorher = (await q('select count(*) from audit_log'))[0].count;
  expect((await wechsle(a.bezirk)).json()).toMatchObject({ status: 422, code: 'ebenenfolge_verletzt' });
  expect(await unter(b.lv)).toBe(true);
  expect((await q('select count(*) from audit_log'))[0].count).toBe(vorher);
  expect(await benachrichtigt('nachrichten')).toEqual([]);
});
