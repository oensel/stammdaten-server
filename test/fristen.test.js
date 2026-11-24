// Story 1.6 (P15, AD-11): Fristen je Ebene
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fristFuer } from '../src/module/organisation/dienst.js';
import { gibRolle, verbandsbaum } from './fabrik.js';
import { neueApp } from './helper.js';

const ART = 'lehrgangsfreigabe_erinnerung';
let t; let a; let b; let djb; let lv; let mitglied;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
beforeAll(async () => {
  t = await neueApp();
  a = await verbandsbaum(t.pool); b = await verbandsbaum(t.pool);
  await gibRolle(t.pool, 'trainer1', 'djb_admin', a.djb);
  await gibRolle(t.pool, 'pruefer1', 'lv_admin', a.lv);
  [djb, lv, mitglied] = await Promise.all(['trainer1', 'pruefer1', 'admin1'].map(async (n) => (await t.login(n)).body.access_token));
});
afterAll(() => t.schliessen());

const setze = async (token, verband, wert, art = ART) => {
  const r = await t.app.inject({ method: 'PUT', url: `/v2/verbaende/${verband}/fristen/${art}`, payload: { wert }, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() };
};
const wert = async (id) => (await fristFuer(null, t.pool, { art: ART, verband_id: id })).wert;
const letzterAudit = async () => (await q(`select alt, neu, akteur from audit_log where aktion = 'frist_geaendert' order by id desc limit 1`))[0];

it('liegt mit den Standardwerten der Fristentabelle vor, eindeutig je Art und Verband', async () => {
  const alle = Object.fromEntries((await q('select art, wert, einheit from fristen where verband_id is null')).map((f) => [f.art, `${f.wert} ${f.einheit}`]));
  expect(alle).toEqual({
    mitgliedschaftsantrag_verfall: '30 tage', mitgliedschaftsantrag_erinnerung: '14 tage', lizenzablauf_warnung_1: '60 tage', lizenzablauf_warnung_2: '14 tage',
    fuehrungszeugnis_loeschung: '90 tage', fuehrungszeugnis_erinnerung: '12 monate', mandat_verfall: '36 monate', mandat_vorwarnung: '30 tage',
    lehrgangsfreigabe_erinnerung: '7 tage', lehrgangsfreigabe_eskalation: '14 tage', lehrgangsaenderung_stornierung: '14 tage', vorabankuendigung: '14 tage',
  });
  await expect(q('insert into fristen (art, wert, einheit) values ($1, 1, $2)', [ART, 'tage'])).rejects.toThrow('fristen_art_verband_uq');
});

it('der LV-Wert gilt im ganzen Gebiet, sonst der DJB-Standard; mit altem und neuem Wert auditiert', async () => {
  expect((await setze(lv, a.lv, 5)).body).toMatchObject({ wert: 5, einheit: 'tage', quelle_verband_id: a.lv });
  expect(await letzterAudit()).toMatchObject({ alt: null, neu: { art: ART, verband_id: a.lv, wert: 5 } });
  expect([await wert(a.verein), await wert(a.kreis), await wert(a.lv), await wert(b.verein), await wert(a.djb)]).toEqual([5, 5, 5, 7, 7]);

  expect((await setze(lv, a.lv, 6)).status).toBe(200);
  expect(await letzterAudit()).toMatchObject({ alt: { wert: 5 }, neu: { wert: 6 } });

  expect((await setze(djb, a.djb, 9)).body).toMatchObject({ wert: 9, quelle_verband_id: null });
  expect(await letzterAudit()).toMatchObject({ alt: { wert: 7 }, neu: { wert: 9, verband_id: a.djb } });
  expect([await wert(a.verein), await wert(b.verein)]).toEqual([6, 9]);
});

it('folgt dem Verein beim Verbandswechsel', async () => {
  await q('update vereine set verband_id = $2 where id = $1', [b.verein, a.kreis]);
  expect(await wert(b.verein)).toBe(6);
});

it('weist Bezirk, Kreis und Verein ab, auch für den DJB-Admin und direkt in der Datenbank', async () => {
  const vorher = await q('select * from fristen order by id');
  for (const id of [a.bezirk, a.kreis]) expect((await setze(djb, id, 3)).body).toMatchObject({ status: 422, code: 'frist_ebene_unzulaessig' });
  expect((await setze(djb, a.verein, 3)).status).toBe(404);
  await expect(q(`insert into fristen (art, verband_id, wert, einheit) values ($1,$2,1,'tage')`, [ART, a.kreis])).rejects.toThrow('Nur DJB');
  expect(await q('select * from fristen order by id')).toEqual(vorher);
});

it('weist fremde LV, den DJB-Standard durch LV-Admins und Benutzer ohne Rolle ab', async () => {
  for (const [token, id] of [[lv, b.lv], [lv, a.djb], [lv, a.bezirk], [mitglied, a.lv], [mitglied, a.djb]]) expect((await setze(token, id, 3)).status).toBe(404);
});

it('prüft Eingaben und unbekannte Arten', async () => {
  for (const x of [0, 1001, 1.5]) expect((await setze(djb, a.djb, x)).status).toBe(400);
  expect((await setze(djb, a.djb, 3, 'gibt_es_nicht')).status).toBe(404);
  await expect(fristFuer(null, t.pool, { art: 'gibt_es_nicht', verband_id: a.lv })).rejects.toThrow('Unbekannte Fristart');
});

it('zeigt die wirksamen Fristen eines Verbands mit Herkunft', async () => {
  const hole = (id) => t.app.inject({ method: 'GET', url: `/v2/verbaende/${id}/fristen`, headers: { authorization: `Bearer ${mitglied}` } });
  const { fristen } = (await hole(a.kreis)).json();
  expect(fristen).toHaveLength(12);
  expect(fristen.find((f) => f.art === ART)).toMatchObject({ wert: 6, quelle_verband_id: a.lv });
  expect((await hole(randomUUID())).statusCode).toBe(404);
});
