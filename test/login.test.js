import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT, PW, neueApp } from './helper.js';

let t;
beforeAll(async () => { t = await neueApp(); });
afterAll(() => t.schliessen());

const scopes = (claims) => claims.scope.split(' ').filter(Boolean);

describe('Login und Claims', () => {
  it('meldet an, Token ist per JWKS prüfbar (EdDSA, iss, aud)', async () => {
    const r = await t.login('schueler1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token_type: 'Bearer', expires_in: 600, muss_passwort_aendern: false });
    expect(r.body.refresh_token).toBeTruthy();
    const { payload, protectedHeader } = await t.pruefe(r.body.access_token);
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(payload.aud).toEqual([CLIENT]); // SSO: aud ist ein Array aller nutzbaren Apps
    expect(payload.azp).toBe(CLIENT);
    expect(payload.exp - payload.iat).toBe(600);
  });

  it('Token einer anderen aud wird abgelehnt', async () => {
    const r = await t.login('schueler1');
    await expect(t.pruefe(r.body.access_token, 'hajime-pro')).rejects.toThrow();
  });

  it('Manipuliertes Token wird abgelehnt', async () => {
    const r = await t.login('schueler1');
    const [h, , s] = r.body.access_token.split('.');
    const fremd = Buffer.from(JSON.stringify({ sub: 'x', aud: CLIENT, iss: 'http://stammdaten.test', exp: 9999999999, rolle: 'admin' })).toString('base64url');
    await expect(t.pruefe(`${h}.${fremd}.${s}`)).rejects.toThrow();
  });

  it('Schüler: nur eigenes Mitglied, kleine Scopes (kein mitglieder:lesen)', async () => {
    const { payload: c } = await t.pruefe((await t.login('schueler1')).body.access_token);
    expect(c).toMatchObject({ rolle: 'mitglied', super_admin: false, rechte: [] });
    expect(c.mitglied_id).toBeTruthy();
    expect(c.mitglied_ids).toEqual([c.mitglied_id]);
    expect(c.verein_id).toBeTruthy();
    expect(scopes(c)).toEqual(expect.arrayContaining(['mitglieder:selbst', 'vereine:lesen', 'gruppen:lesen']));
    expect(scopes(c)).not.toContain('mitglieder:lesen');
    expect(scopes(c)).not.toContain('benutzer:schueler');
  });

  it('Trainer / Prüfer: Rechte und Scopes ∩ Obergrenze von Kyu-Manager-Pro', async () => {
    const { payload: tr } = await t.pruefe((await t.login('trainer1')).body.access_token);
    expect(tr.rechte).toEqual(['trainer']);
    expect(scopes(tr)).toEqual(expect.arrayContaining(['mitglieder:lesen', 'mitglieder:person', 'gruppen:schreiben', 'benutzer:schueler']));
    // Obergrenze: Kyu-Manager-Pro bekommt nie Kontakt-/Zahlerdaten, obwohl der Trainer sie in Dojo-Master-Pro hätte
    expect(scopes(tr)).not.toContain('mitglieder:kontakt');
    expect(scopes(tr)).not.toContain('zahler:lesen');
    const { payload: pr } = await t.pruefe((await t.login('pruefer1')).body.access_token);
    expect(pr.rechte).toEqual(['pruefer']);
    expect(scopes(pr)).toEqual(expect.arrayContaining(['graduierungen:schreiben', 'mitglieder:lesen']));
    expect(scopes(pr)).not.toContain('benutzer:schueler');
  });

  it('Admin: Rolle admin, alle Scopes der Obergrenze, aber nichts darüber', async () => {
    const { payload: a } = await t.pruefe((await t.login('admin1')).body.access_token);
    expect(a.rolle).toBe('admin');
    const obergrenze = (await t.pool.query(`select scopes from anwendungen where schluessel = $1`, [CLIENT])).rows[0].scopes;
    expect(scopes(a).sort()).toEqual([...obergrenze].sort());
    expect(scopes(a)).not.toContain('mitglieder:kontakt');
  });

  it('Eltern-Konto: kein eigenes Mitglied, mitglied_ids = Kinder', async () => {
    const { payload: e } = await t.pruefe((await t.login('eltern1')).body.access_token);
    expect(e.mitglied_id).toBeNull();
    expect(e.mitglied_ids).toHaveLength(2);
  });

  it('andere App = andere Obergrenze (Hajime-Pro)', async () => {
    await t.pool.query(`insert into anwendung_vereine (anwendung_id, verein_id)
      select a.id, v.id from anwendungen a, vereine v where a.schluessel = 'hajime-pro' and v.name = 'JC Demo' on conflict do nothing`);
    const r = await t.login('trainer1', { client_id: 'hajime-pro' });
    const { payload } = await t.pruefe(r.body.access_token, 'hajime-pro');
    expect(scopes(payload)).not.toContain('graduierungen:schreiben');
    expect(scopes(payload)).not.toContain('gruppen:schreiben');
    expect(scopes(payload)).toContain('mitglieder:lesen');
  });

  it('Anmeldung auch mit E-Mail möglich', async () => {
    await t.pool.query(`update benutzer set email = 'lena@example.org' where benutzername = 'schueler1'`);
    expect((await t.login('LENA@example.org')).status).toBe(200);
  });

  it('falsches Passwort, unbekannter Benutzer und unbekannte App: gleiche Meldung / 401', async () => {
    const a = await t.login('schueler1', {}, 'falsch-falsch');
    const b = await t.login('gibtsnicht', {}, 'falsch-falsch');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.detail).toBe(b.body.detail);
    expect((await t.login('schueler1', { client_id: 'unbekannt' })).status).toBe(401);
  });

  it('mehrere Vereine: Verein muss gewählt werden', async () => {
    const v = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('JC Zweit', true) returning id`)).rows[0].id;
    const b = (await t.pool.query(`select id from benutzer where benutzername = 'trainer1'`)).rows[0].id;
    await t.pool.query(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'mitglied','freigegeben')`, [b, v]);
    const r = await t.login('trainer1');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('verein_waehlen');
    expect(r.body.vereine).toHaveLength(2);
    const ok = await t.login('trainer1', { verein_id: v });
    expect(ok.status).toBe(200);
    const { payload } = await t.pruefe(ok.body.access_token);
    expect(payload.verein_id).toBe(v);
    expect(payload.rechte).toEqual([]); // Recht gilt nur im anderen Verein
    await t.pool.query(`update benutzer_vereine set status = 'angefragt' where benutzer_id = $1 and verein_id = $2`, [b, v]);
    expect((await t.login('trainer1', { verein_id: v })).status).toBe(403);
  });

  it('nicht freigegebene Zugehörigkeit: kein Login', async () => {
    await t.pool.query(`update benutzer_vereine set status = 'gesperrt' where benutzer_id = (select id from benutzer where benutzername = 'pruefer1')`);
    expect((await t.login('pruefer1')).status).toBe(403);
  });
});

describe('Sperre nach Fehlversuchen', () => {
  it('sperrt nach 5 Fehlversuchen, auch das richtige Passwort wird dann abgewiesen', async () => {
    for (let i = 0; i < 4; i++) expect((await t.login('admin1', {}, 'falsch-falsch')).status).toBe(401);
    const fuenfter = await t.login('admin1', {}, 'falsch-falsch');
    expect(fuenfter.status).toBe(429);
    const r = await t.login('admin1');
    expect(r.status).toBe(429);
    expect(r.body.gesperrt_minuten).toBeGreaterThan(0);
    await t.pool.query(`update benutzer set gesperrt_bis = now() - interval '1 second' where benutzername = 'admin1'`);
    expect((await t.login('admin1')).status).toBe(200);
  });

  it('erfolgreiche Anmeldung setzt den Zähler zurück', async () => {
    await t.login('eltern1', {}, 'falsch-falsch');
    await t.login('eltern1', {}, 'falsch-falsch');
    expect((await t.login('eltern1')).status).toBe(200);
    const n = (await t.pool.query(`select fehlversuche from benutzer where benutzername = 'eltern1'`)).rows[0].fehlversuche;
    expect(n).toBe(0);
  });
});

it('Passwort steht nirgends im Klartext (argon2id)', async () => {
  const h = (await t.pool.query(`select passwort_hash from benutzer where benutzername = 'schueler1'`)).rows[0].passwort_hash;
  expect(h.startsWith('$argon2id$')).toBe(true);
  expect(h).not.toContain(PW);
});
