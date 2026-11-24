import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, schrittFuer } from '../src/passwords.js';
import { neueApp } from './helper.js';

let t;
let jetzt = new Date('2026-11-24T10:00:00Z');
beforeAll(async () => {
  t = await neueApp({ zweiFaktorPflicht: true, uhr: () => jetzt, maxFehlversuche: 3 });
  await t.pool.query(`update benutzer set ist_super_admin = true where benutzername = 'eltern1'`);
});
afterAll(() => t.schliessen());

const fehlversuche = async () => (await t.pool.query(`select fehlversuche from benutzer where benutzername = 'eltern1'`)).rows[0].fehlversuche;
const naechsterSchritt = () => { jetzt = new Date(jetzt.getTime() + 90_000); };
let geheimnis; let backup;

describe('Zweiter Faktor für den Super-Admin (Story 2.9)', () => {
  it('ohne eingerichteten Faktor gibt es keine Sitzung, nur den Weg zur Einrichtung', async () => {
    const r = await t.login('eltern1');
    expect(r.status).toBe(200);
    expect(r.body.zweiter_faktor).toBe('einrichten');
    expect(r.body.access_token).toBeUndefined();
    expect(r.body.refresh_token).toBeUndefined();
    t.einrichtungsToken = r.body.einrichtungs_token;
    // das Einrichtungs-Token ist kein Access-Token
    expect((await t.api('GET', '/v2/ich', null, t.einrichtungsToken)).status).toBe(401);
  });

  it('Einrichtung: falscher Bestätigungscode zählt als Fehlversuch, richtiger aktiviert und liefert Backup-Codes', async () => {
    const tok = t.einrichtungsToken;
    expect((await t.api('POST', '/auth/2fa/bestaetigen', { einrichtungs_token: tok, code: '123456' })).status).toBe(409); // noch nicht gestartet
    geheimnis = (await t.api('POST', '/auth/2fa/einrichten', { einrichtungs_token: tok })).body.geheimnis;
    expect(geheimnis).toMatch(/^[A-Z2-7]{32}$/);
    const roh = (await t.pool.query(`select totp_secret_verschluesselt s from benutzer where benutzername = 'eltern1'`)).rows[0].s;
    expect(roh).not.toContain(geheimnis); // nur verschlüsselt gespeichert
    expect((await t.api('POST', '/auth/2fa/bestaetigen', { einrichtungs_token: tok, code: '000000' })).status).toBe(401);
    expect(await fehlversuche()).toBe(1);
    const r = await t.api('POST', '/auth/2fa/bestaetigen', { einrichtungs_token: tok, code: code(geheimnis, schrittFuer(jetzt)) });
    expect(r.status).toBe(200);
    backup = r.body.backup_codes;
    expect(backup).toHaveLength(10);
    expect((await t.api('POST', '/auth/2fa/einrichten', { einrichtungs_token: tok })).status).toBe(409);
  });

  it('Anmeldung: Code fehlt oder ist falsch → abgewiesen und als Fehlversuch gezählt', async () => {
    await t.pool.query(`update benutzer set fehlversuche = 0 where benutzername = 'eltern1'`);
    naechsterSchritt();
    expect((await t.login('eltern1')).status).toBe(401);
    expect((await t.login('eltern1', { code: '000000' })).status).toBe(401);
    expect(await fehlversuche()).toBe(2);
  });

  it('richtiger Code meldet an; derselbe Code ein zweites Mal wird abgewiesen', async () => {
    const c = code(geheimnis, schrittFuer(jetzt));
    const r = await t.login('eltern1', { code: c });
    expect(r.status).toBe(200);
    expect((await t.pruefe(r.body.access_token)).payload.super_admin).toBe(true);
    expect(await fehlversuche()).toBe(0);
    expect((await t.login('eltern1', { code: c })).status).toBe(401);
  });

  it('Backup-Codes gelten je einmal', async () => {
    await t.pool.query(`update benutzer set fehlversuche = 0 where benutzername = 'eltern1'`);
    expect((await t.login('eltern1', { code: backup[0] })).status).toBe(200);
    expect((await t.login('eltern1', { code: backup[0] })).status).toBe(401);
    expect((await t.login('eltern1', { code: backup[1] })).status).toBe(200);
  });

  it('nach zu vielen Fehlversuchen ist das Konto gesperrt', async () => {
    await t.pool.query(`update benutzer set fehlversuche = 0 where benutzername = 'eltern1'`);
    for (let i = 0; i < 2; i++) await t.login('eltern1', { code: '000000' });
    expect((await t.login('eltern1', { code: '000000' })).status).toBe(429);
    expect((await t.login('eltern1', { code: backup[2] })).status).toBe(429);
  });

  it('normale Benutzer brauchen keinen zweiten Faktor', async () => {
    expect((await t.login('schueler1')).status).toBe(200);
  });

  it('ein abgelaufenes oder fremdes Einrichtungs-Token wird abgewiesen', async () => {
    expect((await t.api('POST', '/auth/2fa/einrichten', { einrichtungs_token: 'x.y.z' })).status).toBe(401);
    const zugriff = (await t.login('schueler1')).body.access_token;
    expect((await t.api('POST', '/auth/2fa/einrichten', { einrichtungs_token: zugriff })).status).toBe(401);
  });

  it('Backup-Codes erneuern: nur mit aktuellem Code, die alten verfallen', async () => {
    await t.pool.query(`update benutzer set fehlversuche = 0, gesperrt_bis = null where benutzername = 'eltern1'`);
    naechsterSchritt();
    const sitzung = (await t.login('eltern1', { code: code(geheimnis, schrittFuer(jetzt)) })).body.access_token;
    expect((await t.api('POST', '/auth/2fa/backup-codes', { code: '000000' }, sitzung)).status).toBe(401);
    expect((await t.api('POST', '/auth/2fa/backup-codes', { code: '123456' })).status).toBe(401); // ohne Sitzung
    naechsterSchritt();
    const r = await t.api('POST', '/auth/2fa/backup-codes', { code: code(geheimnis, schrittFuer(jetzt)) }, sitzung);
    expect(r.status).toBe(200);
    expect(r.body.backup_codes).toHaveLength(10);
    expect((await t.login('eltern1', { code: backup[3] })).status).toBe(401); // alter Code
    expect((await t.login('eltern1', { code: r.body.backup_codes[0] })).status).toBe(200);
  });

  it('normale Benutzer können keine Backup-Codes erneuern', async () => {
    const tok = (await t.login('schueler1')).body.access_token;
    expect((await t.api('POST', '/auth/2fa/backup-codes', { code: '123456' }, tok)).status).toBe(403);
  });

  it('Betreiber-Skript setzt den Faktor zurück, beendet Sitzungen und verlangt danach die Neueinrichtung', async () => {
    const lauf = (name) => execFileSync('node', ['scripts/zwei-faktor-zuruecksetzen.mjs', name], { env: { ...process.env, DATABASE_URL: t.pool.options.connectionString }, encoding: 'utf8' });
    expect(() => lauf('schueler1')).toThrow(); // kein Super-Admin
    expect(lauf('eltern1')).toContain('zurückgesetzt');
    expect((await t.pool.query(`select totp_aktiv_am, totp_secret_verschluesselt from benutzer where benutzername = 'eltern1'`)).rows[0]).toEqual({ totp_aktiv_am: null, totp_secret_verschluesselt: null });
    expect((await t.pool.query(`select count(*)::int n from totp_backup_codes`)).rows[0].n).toBe(0);
    expect((await t.pool.query(`select count(*)::int n from refresh_tokens where benutzer_id = (select id from benutzer where benutzername = 'eltern1') and widerrufen_am is null`)).rows[0].n).toBe(0);
    expect((await t.login('eltern1')).body.zweiter_faktor).toBe('einrichten');
  });
});
