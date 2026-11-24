import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PW, neueApp } from './helper.js';

let t; let mails = [];
beforeAll(async () => {
  t = await neueApp({ mailer: { send: async (m) => { mails.push(m); return { ok: true }; } } });
  await t.pool.query(`update benutzer set email = 'trainer@example.org' where benutzername = 'trainer1'`);
});
afterAll(() => t.schliessen());
beforeEach(async () => { mails = []; await t.pool.query(`delete from einmal_tokens where zweck = 'passwort_reset'`); });

const tokenAus = (mail) => /#token=([\w-]+)/.exec(mail.text)[1];

describe('Passwort vergessen', () => {
  it('Mail mit Link, Zurücksetzen beendet Anmeldungen und Sperre, Link nur einmal nutzbar', async () => {
    const alt = (await t.login('trainer1')).body;
    await t.pool.query(`update benutzer set gesperrt_bis = now() + interval '5 minutes' where benutzername = 'trainer1'`);
    const r = await t.api('POST', '/auth/passwort-vergessen', { kennung: 'trainer@example.org' });
    expect(r.status).toBe(202);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('trainer@example.org');
    expect(mails[0].text).toContain('/passwort-zuruecksetzen#token=');
    const token = tokenAus(mails[0]);
    expect((await t.pool.query(`select count(*)::int n from einmal_tokens where token_hash = $1`, [token])).rows[0].n).toBe(0); // nur Hash
    expect((await t.api('POST', '/auth/passwort-zuruecksetzen', { token, passwort_neu: 'kurz' })).status).toBe(400); // Link bleibt gültig
    expect((await t.api('POST', '/auth/passwort-zuruecksetzen', { token, passwort_neu: 'Ganz-Neues-Passwort-1' })).status).toBe(200);
    expect((await t.api('POST', '/auth/passwort-zuruecksetzen', { token, passwort_neu: 'Noch-Ein-Passwort-2' })).status).toBe(401);
    expect((await t.refresh(alt.refresh_token)).status).toBe(401);
    expect((await t.login('trainer1')).status).toBe(401);
    expect((await t.login('trainer1', {}, 'Ganz-Neues-Passwort-1')).status).toBe(200);
  });

  it('verrät nicht, ob es das Konto gibt; Konto ohne E-Mail bekommt nichts; höchstens 3 pro Stunde', async () => {
    expect((await t.api('POST', '/auth/passwort-vergessen', { kennung: 'gibtsnicht' })).status).toBe(202);
    expect((await t.api('POST', '/auth/passwort-vergessen', { kennung: 'schueler1' })).status).toBe(202); // keine E-Mail
    expect(mails).toHaveLength(0);
    for (let i = 0; i < 5; i++) await t.api('POST', '/auth/passwort-vergessen', { kennung: 'trainer1' });
    expect(mails).toHaveLength(3);
    // nur der letzte Link gilt
    expect((await t.api('POST', '/auth/passwort-zuruecksetzen', { token: tokenAus(mails[0]), passwort_neu: 'Ganz-Neues-Passwort-3' })).status).toBe(401);
    expect((await t.api('POST', '/auth/passwort-zuruecksetzen', { token: tokenAus(mails[2]), passwort_neu: 'Ganz-Neues-Passwort-3' })).status).toBe(200);
  });

  it('abgelaufener Link und Unsinn → 401', async () => {
    await t.api('POST', '/auth/passwort-vergessen', { kennung: 'trainer1' });
    await t.pool.query(`update einmal_tokens set laeuft_ab_am = now() - interval '1 second'`);
    expect((await t.api('POST', '/auth/passwort-zuruecksetzen', { token: tokenAus(mails[0]), passwort_neu: 'Ganz-Neues-Passwort-4' })).status).toBe(401);
    expect((await t.api('POST', '/auth/passwort-zuruecksetzen', { token: 'x'.repeat(30), passwort_neu: 'Ganz-Neues-Passwort-4' })).status).toBe(401);
  });
});

describe('E-Mail bestätigen', () => {
  it('Änderung der E-Mail löst Bestätigungsmail aus', async () => {
    const l = (await t.login('pruefer1')).body;
    await t.api('PATCH', '/ich', { email: 'pruefer@example.org' }, l.access_token);
    expect(mails).toHaveLength(1);
    const token = tokenAus(mails[0]);
    expect((await t.api('GET', '/ich', null, l.access_token)).body.email_bestaetigt).toBe(false);
    expect((await t.api('POST', '/auth/email-bestaetigen', { token })).status).toBe(200);
    expect((await t.api('GET', '/ich', null, l.access_token)).body.email_bestaetigt).toBe(true);
    expect((await t.api('POST', '/auth/email-bestaetigen', { token })).status).toBe(401);
  });
});

describe('Einladungen', () => {
  it('Admin lädt neue Person als Trainer ein; Annehmen legt Konto, Zugehörigkeit und Recht an', async () => {
    const ad = (await t.login('admin1')).body;
    const r = await t.api('POST', '/einladungen', { email: 'neu@example.org', rechte: ['trainer'] }, ad.access_token);
    expect(r.status).toBe(202);
    expect(mails[0].to).toBe('neu@example.org');
    const token = tokenAus(mails[0]);
    expect((await t.api('POST', '/auth/einladung-annehmen', { token })).status).toBe(400); // Benutzername + Passwort nötig
    expect((await t.api('POST', '/auth/einladung-annehmen', { token, benutzername: 'schueler1', passwort_neu: 'Mein-Passwort-123' })).status).toBe(409);
    const ok = await t.api('POST', '/auth/einladung-annehmen', { token, benutzername: 'neue.trainerin', passwort_neu: 'Mein-Passwort-123' });
    expect(ok.status).toBe(200);
    expect(ok.body.neues_konto).toBe(true);
    const l = await t.login('neue.trainerin', {}, 'Mein-Passwort-123');
    expect(l.status).toBe(200);
    const { payload } = await t.pruefe(l.body.access_token);
    expect(payload).toMatchObject({ rolle: 'mitglied', rechte: ['trainer'] });
    expect((await t.api('POST', '/auth/einladung-annehmen', { token, benutzername: 'zweiter', passwort_neu: 'Mein-Passwort-123' })).status).toBe(401);
  });

  it('bestehendes Konto (gleiche E-Mail) bekommt nur die Zugehörigkeit zum neuen Verein', async () => {
    const v = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('JC Zweit', true) returning id`)).rows[0].id;
    // Admin des Zweitvereins
    const b = (await t.pool.query(`insert into benutzer (benutzername, passwort_hash) values ('admin2', (select passwort_hash from benutzer where benutzername = 'admin1')) returning id`)).rows[0].id;
    await t.pool.query(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'admin','freigegeben')`, [b, v]);
    const ad2 = (await t.login('admin2')).body;
    expect((await t.api('POST', '/einladungen', { email: 'trainer@example.org' }, ad2.access_token)).status).toBe(202);
    const token = tokenAus(mails[0]);
    const ok = await t.api('POST', '/auth/einladung-annehmen', { token });
    expect(ok.status).toBe(200);
    expect(ok.body.neues_konto).toBe(false);
    const l = await t.login('trainer1', {}, 'Ganz-Neues-Passwort-3');
    expect([200, 409]).toContain(l.status); // jetzt zwei Vereine → Auswahl nötig
    expect(l.status).toBe(409);
  });

  it('nur Admins laden ein; Rechte nur mit rechte:verwalten; unbekanntes Recht / fremdes Mitglied abgelehnt', async () => {
    const tr = (await t.login('pruefer1')).body;
    expect((await t.api('POST', '/einladungen', { email: 'x@example.org' }, tr.access_token)).status).toBe(403);
    expect((await t.api('POST', '/einladungen', { email: 'x@example.org' })).status).toBe(401);
    const ad = (await t.login('admin1')).body;
    expect((await t.api('POST', '/einladungen', { email: 'x@example.org', rechte: ['gott'] }, ad.access_token)).status).toBe(400);
    expect((await t.api('POST', '/einladungen', { email: 'x@example.org', mitglied_id: '00000000-0000-4000-8000-000000000000' }, ad.access_token)).status).toBe(404);
    expect(PW).toBeTruthy();
  });
});
