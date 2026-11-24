import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PW, neueApp } from './helper.js';

let t;
beforeAll(async () => { t = await neueApp(); });
afterAll(() => t.schliessen());

const idVon = async (name) => (await t.pool.query('select id from benutzer where benutzername = $1', [name])).rows[0].id;

describe('Schüler-Zugänge durch Trainer', () => {
  it('Trainer legt Zugang an → Startpasswort, Wechselpflicht, Token ohne Scopes bis zum Wechsel', async () => {
    const tr = (await t.login('trainer1')).body;
    const mitglied = (await t.pool.query(`select id from mitglieder where mitgliedsnr = 2`)).rows[0].id;
    const r = await t.api('POST', '/benutzer', { benutzername: 'tim.schmidt', vorname: 'Tim', mitglied_id: mitglied }, tr.access_token);
    expect(r.status).toBe(201);
    expect(r.body.startpasswort).toHaveLength(10);
    expect(r.body.muss_passwort_aendern).toBe(true);

    const l = await t.login('tim.schmidt', {}, r.body.startpasswort);
    expect(l.status).toBe(200);
    expect(l.body.muss_passwort_aendern).toBe(true);
    const { payload } = await t.pruefe(l.body.access_token);
    expect(payload).toMatchObject({ muss_passwort_aendern: true, scope: '', rolle: 'mitglied', mitglied_id: mitglied });
    expect((await t.api('POST', '/benutzer', { benutzername: 'x.y.z' }, l.body.access_token)).status).toBe(403);

    const neu = 'Mein-Eigenes-Passwort-7';
    expect((await t.api('PATCH', '/ich', { passwort_neu: neu, passwort_alt: r.body.startpasswort }, l.body.access_token)).status).toBe(200);
    const r2 = await t.refresh(l.body.refresh_token);
    expect(r2.status).toBe(200);
    expect(r2.body.muss_passwort_aendern).toBe(false);
    expect((await t.pruefe(r2.body.access_token)).payload.scope).toContain('mitglieder:selbst');
  });

  it('Mitglied hat schon einen Zugang / fremdes Mitglied / doppelter Name', async () => {
    const tr = (await t.login('trainer1')).body;
    const lena = (await t.pool.query(`select id from mitglieder where mitgliedsnr = 1`)).rows[0].id;
    expect((await t.api('POST', '/benutzer', { benutzername: 'lena2', mitglied_id: lena }, tr.access_token)).status).toBe(409);
    expect((await t.api('POST', '/benutzer', { benutzername: 'Schueler1' }, tr.access_token)).status).toBe(409);
    expect((await t.api('POST', '/benutzer', { benutzername: 'zzz', mitglied_id: '00000000-0000-4000-8000-000000000000' }, tr.access_token)).status).toBe(404);
    const v = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('Fremd', true) returning id`)).rows[0].id;
    const fremd = (await t.pool.query(`insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname) values ($1,1,'F','F') returning id`, [v])).rows[0].id;
    expect((await t.api('POST', '/benutzer', { benutzername: 'fremdling', mitglied_id: fremd }, tr.access_token)).status).toBe(404);
  });

  it('Schüler und Prüfer dürfen keine Zugänge anlegen', async () => {
    for (const n of ['schueler1', 'pruefer1']) {
      const l = (await t.login(n)).body;
      expect((await t.api('POST', '/benutzer', { benutzername: `neu.${n}` }, l.access_token)).status).toBe(403);
    }
    expect((await t.api('POST', '/benutzer', { benutzername: 'neu.anon' })).status).toBe(401);
  });

  it('Trainer setzt das Passwort eines Schülers zurück: neues Startpasswort, Wechselpflicht, alte Anmeldungen beendet, Sperre aufgehoben', async () => {
    const tr = (await t.login('trainer1')).body;
    const schueler = (await t.login('schueler1')).body;
    await t.pool.query(`update benutzer set gesperrt_bis = now() + interval '10 minutes', pin_hash = 'x' where benutzername = 'schueler1'`);
    const r = await t.api('POST', `/benutzer/${await idVon('schueler1')}/passwort-zuruecksetzen`, null, tr.access_token);
    expect(r.status).toBe(200);
    expect((await t.refresh(schueler.refresh_token)).status).toBe(401);
    expect((await t.login('schueler1')).status).toBe(401);
    const neu = await t.login('schueler1', {}, r.body.startpasswort);
    expect(neu.status).toBe(200);
    expect(neu.body.muss_passwort_aendern).toBe(true);
    expect((await t.pool.query(`select pin_hash from benutzer where benutzername = 'schueler1'`)).rows[0].pin_hash).toBeNull();
  });

  it('Trainer darf Prüfer, Admin, sich selbst und fremde Vereine nicht zurücksetzen', async () => {
    const tr = (await t.login('trainer1')).body;
    for (const n of ['pruefer1', 'admin1', 'trainer1']) {
      expect((await t.api('POST', `/benutzer/${await idVon(n)}/passwort-zuruecksetzen`, null, tr.access_token)).status).toBe(403);
    }
    const v = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('Fremd2', true) returning id`)).rows[0].id;
    const b = (await t.pool.query(`insert into benutzer (benutzername, passwort_hash) values ('fremdkind', 'x') returning id`)).rows[0].id;
    await t.pool.query(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'mitglied','freigegeben')`, [b, v]);
    expect((await t.api('POST', `/benutzer/${b}/passwort-zuruecksetzen`, null, tr.access_token)).status).toBe(404);
    const sch = (await t.login('eltern1')).body;
    expect((await t.api('POST', `/benutzer/${await idVon('schueler1')}/passwort-zuruecksetzen`, null, sch.access_token)).status).toBe(403);
  });

  it('Konto in mehreren Vereinen ist gegen Zurücksetzen geschützt; Admin darf Trainer zurücksetzen', async () => {
    const ad = (await t.login('admin1')).body;
    const zweit = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('JC Zweit', true) returning id`)).rows[0].id;
    const sid = await idVon('eltern1');
    await t.pool.query(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'mitglied','freigegeben')`, [sid, zweit]);
    expect((await t.api('POST', `/benutzer/${sid}/passwort-zuruecksetzen`, null, ad.access_token)).status).toBe(403);
    expect((await t.api('POST', `/benutzer/${await idVon('trainer1')}/passwort-zuruecksetzen`, null, ad.access_token)).status).toBe(200);
    expect(PW).toBeTruthy();
  });
});
