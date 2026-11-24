import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neueApp } from './helper.js';

let t; let admin; let schueler;
beforeAll(async () => {
  t = await neueApp();
  admin = (await t.login('admin1')).body.access_token;
  schueler = (await t.pool.query(`select id from benutzer where benutzername = 'schueler1'`)).rows[0].id;
});
afterAll(() => t.schliessen());

const rechte = async (id) => (await t.pool.query(
  `select r.schluessel from benutzer_rechte br join rechte r on r.id = br.recht_id where br.benutzer_id = $1 and br.geloescht_am is null order by 1`, [id])).rows.map((x) => x.schluessel);

describe('Rechte vergeben und entziehen', () => {
  it('PUT vergibt (idempotent), neue Tokens enthalten Recht und Scopes, DELETE entzieht beim nächsten Refresh', async () => {
    const vorher = (await t.login('schueler1')).body;
    expect((await t.pruefe(vorher.access_token)).payload.rechte).toEqual([]);

    const r = await t.api('PUT', `/benutzer/${schueler}/rechte/trainer`, null, admin);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ benutzer_id: schueler, recht: 'trainer' });
    expect((await t.api('PUT', `/benutzer/${schueler}/rechte/trainer`, {}, admin)).status).toBe(200);
    expect((await t.api('PUT', `/benutzer/${schueler}/rechte/pruefer`, { gueltig_bis: '2099-12-31' }, admin)).status).toBe(200);
    expect(await rechte(schueler)).toEqual(['pruefer', 'trainer']);
    const adminId = (await t.pool.query(`select id from benutzer where benutzername = 'admin1'`)).rows[0].id;
    const zeile = (await t.pool.query(`select vergeben_von, geaendert_von from benutzer_rechte where benutzer_id = $1 limit 1`, [schueler])).rows[0];
    expect(zeile).toEqual({ vergeben_von: adminId, geaendert_von: adminId });

    // bestehende Anmeldung bleibt, der Refresh lädt die neuen Rechte
    const neu = await t.refresh(vorher.refresh_token);
    expect(neu.status).toBe(200);
    const claims = (await t.pruefe(neu.body.access_token)).payload;
    expect(claims.rechte).toEqual(['pruefer', 'trainer']);
    expect(claims.scope.split(' ')).toContain('benutzer:schueler');

    expect((await t.api('DELETE', `/benutzer/${schueler}/rechte/trainer`, null, admin)).status).toBe(204);
    expect((await t.api('DELETE', `/benutzer/${schueler}/rechte/trainer`, null, admin)).status).toBe(204); // idempotent
    expect(await rechte(schueler)).toEqual(['pruefer']);
    const nach = await t.refresh(neu.body.refresh_token);
    expect((await t.pruefe(nach.body.access_token)).payload.rechte).toEqual(['pruefer']);

    // erneutes Vergeben belebt den weich gelöschten Eintrag
    expect((await t.api('PUT', `/benutzer/${schueler}/rechte/trainer`, null, admin)).status).toBe(200);
    expect(await rechte(schueler)).toEqual(['pruefer', 'trainer']);
    expect((await t.pool.query(`select count(*)::int n from benutzer_rechte where benutzer_id = $1`, [schueler])).rows[0].n).toBe(2);
  });

  it('abgelehnt: Trainer/Schüler (403), eigenes Konto, Super-Admin, anderer Verein, unbekanntes Recht/Konto', async () => {
    const trainer = (await t.login('trainer1')).body.access_token;
    expect((await t.api('PUT', `/benutzer/${schueler}/rechte/trainer`, null, trainer)).body.code).toBe('scope_fehlt');
    expect((await t.api('PUT', `/benutzer/${schueler}/rechte/trainer`, null)).status).toBe(401);

    const adminId = (await t.pool.query(`select id from benutzer where benutzername = 'admin1'`)).rows[0].id;
    expect((await t.api('PUT', `/benutzer/${adminId}/rechte/trainer`, null, admin)).body.code).toBe('konto_geschuetzt');

    const verein = (await t.pool.query(`select id from vereine where name = 'JC Demo'`)).rows[0].id;
    const sa = (await t.pool.query(`insert into benutzer (benutzername, ist_super_admin) values ('boss', true) returning id`)).rows[0].id;
    await t.pool.query(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'mitglied','freigegeben')`, [sa, verein]);
    expect((await t.api('PUT', `/benutzer/${sa}/rechte/trainer`, null, admin)).body.code).toBe('konto_geschuetzt');

    const v2 = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('Anderer', true) returning id`)).rows[0].id;
    const fremd = (await t.pool.query(`insert into benutzer (benutzername) values ('fremder') returning id`)).rows[0].id;
    await t.pool.query(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'mitglied','freigegeben')`, [fremd, v2]);
    expect((await t.api('PUT', `/benutzer/${fremd}/rechte/trainer`, null, admin)).status).toBe(404);
    const offen = (await t.pool.query(`insert into benutzer (benutzername) values ('angefragt') returning id`)).rows[0].id;
    await t.pool.query(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'mitglied','angefragt')`, [offen, verein]);
    expect((await t.api('PUT', `/benutzer/${offen}/rechte/trainer`, null, admin)).status).toBe(404);

    expect((await t.api('PUT', `/benutzer/${schueler}/rechte/gibtsnicht`, null, admin)).body.code).toBe('recht_unbekannt');
    expect((await t.api('DELETE', `/benutzer/00000000-0000-4000-8000-000000000000/rechte/trainer`, null, admin)).status).toBe(404);
    expect((await t.api('PUT', `/benutzer/${schueler}/rechte/trainer`, { gueltig_von: '2030-01-02', gueltig_bis: '2030-01-01' }, admin)).status).toBe(400);
  });
});
