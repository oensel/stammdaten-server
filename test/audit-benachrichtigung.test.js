import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inTransaktion, mitSperre, tx } from '../src/db.js';
import { AKTIONEN } from '../src/module/audit/aktionen.js';
import * as audit from '../src/module/audit/dienst.js';
import * as benachrichtigung from '../src/module/benachrichtigung/dienst.js';
import { baueCtx, systemCtx } from '../src/pipeline/ctx.js';
import { fuehreAus, starteWorker } from '../src/worker.js';
import { neueApp } from './helper.js';

const JETZT = new Date('2030-01-02T03:04:05Z');
let t; let benutzer; let verein;
beforeAll(async () => {
  t = await neueApp();
  benutzer = (await t.pool.query('select id from benutzer limit 1')).rows[0].id;
  await t.pool.query(`update benutzer set email = 'a@example.org' where id = $1`, [benutzer]);
  verein = (await t.pool.query('select id from vereine limit 1')).rows[0].id;
});
afterAll(() => t.schliessen());
beforeEach(() => t.pool.query('delete from audit_log; delete from nachrichten; delete from mail_auftraege'));
const q = async (sql) => (await t.pool.query(sql)).rows;
const ctx = () => baueCtx({ benutzer: { id: benutzer }, kontext: { art: 'verein', id: verein }, rechte: { rolle: 'admin' }, anwendung: 'kyu-manager-pro', jetzt: JETZT });
const eintrag = { aktion: 'recht_vergeben', objekt_art: 'benutzer', alt: { a: 1 }, neu: { a: 2 }, grund: 'Test' };

describe('audit', () => {
  it('schreibt Akteur, Rolle, Ebene und Zeit aus ctx', async () => {
    await tx(t.pool, (db) => audit.schreiben(ctx(), db, { ...eintrag, objekt_id: benutzer }));
    expect(await q('select * from audit_log')).toMatchObject([{
      zeitpunkt: JETZT, akteur: benutzer, benutzer_id: benutzer, anwendung: 'kyu-manager-pro', rolle: 'admin', stellvertreter: false,
      ebene_art: 'verein', ebene_id: verein, objekt_id: benutzer, ...eintrag,
    }]);
  });
  it('Systemlauf: Akteur ist system:<name>', async () => {
    await tx(t.pool, (db) => audit.schreiben(systemCtx('probe'), db, eintrag));
    expect(await q('select akteur, benutzer_id from audit_log')).toEqual([{ akteur: 'system:probe', benutzer_id: null }]);
  });
  it('bei Rollback entsteht kein Eintrag', async () => {
    await expect(tx(t.pool, async (db) => { await audit.schreiben(ctx(), db, eintrag); throw new Error('abbruch'); })).rejects.toThrow('abbruch');
    expect(await q('select 1 from audit_log')).toEqual([]);
  });
  it('lehnt unbekannte Aktionen und den Pool ab', async () => {
    await expect(tx(t.pool, (db) => audit.schreiben(ctx(), db, { ...eintrag, aktion: 'irgendwas' }))).rejects.toThrow('Unbekannte Audit-Aktion');
    await expect(audit.schreiben(ctx(), t.pool, eintrag)).rejects.toThrow('Transaktion');
    expect(new Set(AKTIONEN).size).toBe(AKTIONEN.length);
  });
});

const anlegen = (jetzt = JETZT) => tx(t.pool, (db) => benachrichtigung.senden(systemCtx('probe', { jetzt }), db,
  { empfaenger: [{ benutzer_id: benutzer }], art: 'hinweis', daten: { titel: 'Titel', text: 'Text' } }));
const doppel = (antwort = { ok: true }) => { const mails = []; return { mails, send: async (m) => { mails.push(m); return antwort; } }; };
const versende = (mailer, jetzt = JETZT) => fuehreAus(t.pool, 'mailversand', { mailer }, { jetzt });

describe('benachrichtigung', () => {
  it('legt Nachricht und Mail-Auftrag an', async () => {
    await anlegen();
    expect(await q('select benutzer_id, art, titel, text from nachrichten')).toEqual([{ benutzer_id: benutzer, art: 'hinweis', titel: 'Titel', text: 'Text' }]);
    expect(await q('select benutzer_id, betreff, text, status from mail_auftraege')).toEqual([{ benutzer_id: benutzer, betreff: 'Titel', text: 'Text', status: 'offen' }]);
  });
  it('bei Rollback entsteht nichts; Pool und unbekannte Art werden abgelehnt', async () => {
    const args = { empfaenger: [{ benutzer_id: benutzer }], art: 'hinweis', daten: { titel: 'T', text: 'T' } };
    await expect(tx(t.pool, async (db) => { await benachrichtigung.senden(ctx(), db, args); throw new Error('abbruch'); })).rejects.toThrow('abbruch');
    expect(await q('select 1 from nachrichten union all select 1 from mail_auftraege')).toEqual([]);
    await expect(benachrichtigung.senden(ctx(), t.pool, args)).rejects.toThrow('Transaktion');
    await expect(tx(t.pool, (db) => benachrichtigung.senden(ctx(), db, { ...args, art: 'toString' }))).rejects.toThrow('Unbekannte');
  });
  it('versendet offene Aufträge genau einmal', async () => {
    await anlegen();
    const m = doppel();
    expect(await versende(m)).toEqual({ gesendet: 1 });
    expect(await versende(m)).toEqual({ gesendet: 0 });
    expect(m.mails).toEqual([{ to: 'a@example.org', subject: 'Titel', text: 'Text' }]);
    expect(await q('select status, gesendet_am from mail_auftraege')).toEqual([{ status: 'gesendet', gesendet_am: JETZT }]);
  });
  it('ohne Adresse oder bei inaktivem Konto wird nicht gesendet, die Nachricht bleibt', async () => {
    const m = doppel();
    for (const sql of ['email = null', `email = 'a@example.org', aktiv = false`]) {
      await anlegen();
      await t.pool.query(`update benutzer set ${sql} where id = $1`, [benutzer]);
      await versende(m);
    }
    await t.pool.query(`update benutzer set email = 'a@example.org', aktiv = true where id = $1`, [benutzer]);
    expect(m.mails).toEqual([]);
    expect(await q('select distinct status from mail_auftraege')).toEqual([{ status: 'fehlgeschlagen' }]);
    expect(await q('select 1 from nachrichten')).toHaveLength(2);
  });
  it('wiederholt Fehlschläge mit Wartezeit und gibt nach 5 Versuchen auf', async () => {
    await anlegen();
    const m = doppel({ ok: false, grund: 'fehler' });
    await versende(m); await versende(m);
    expect(m.mails).toHaveLength(1); // Wartezeit noch nicht um
    for (let i = 1; i <= 6; i++) await versende(m, new Date(JETZT.getTime() + i * 86_400_000));
    expect(m.mails).toHaveLength(5);
    expect(await q('select status, versuche from mail_auftraege')).toEqual([{ status: 'fehlgeschlagen', versuche: 5 }]);
  });
  it('ohne SMTP bleiben Aufträge ohne Versuch offen', async () => {
    await anlegen();
    await versende(doppel({ ok: false, grund: 'kein_smtp' }));
    expect(await q('select status, versuche from mail_auftraege')).toEqual([{ status: 'offen', versuche: 0 }]);
  });
  it('läuft nicht, solange ein anderer Lauf die Sperre hält', async () => {
    await anlegen();
    const m = doppel();
    await mitSperre(t.pool, 'job:mailversand', async () => { expect(await versende(m)).toBeNull(); });
    expect(m.mails).toEqual([]);
    expect(await versende(m)).toEqual({ gesendet: 1 });
  });
  it('der gestartete Worker versendet', async () => {
    await anlegen(new Date(Date.now() - 1000));
    const m = doppel();
    const w = await starteWorker({ databaseUrl: t.pool.options.connectionString, mailer: m, intervallMs: 50, beenden: () => {} });
    await expect.poll(() => m.mails.length, { timeout: 5000 }).toBe(1);
    await w.stoppen();
    expect(await q('select status from mail_auftraege')).toEqual([{ status: 'gesendet' }]);
  });
});

describe('inTransaktion', () => {
  it('öffnet beim Pool eine Transaktion, sonst keine', async () => {
    const [a, b] = await inTransaktion(t.pool, async (x) => [x, await inTransaktion(x, async (y) => y)]);
    expect(a).toBe(b);
  });
});
