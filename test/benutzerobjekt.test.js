import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neueApp } from './helper.js';

let t;
beforeAll(async () => { t = await neueApp(); });
afterAll(() => t.schliessen());

describe('Benutzer-Objekt mit allen Vereinen und Berechtigungen', () => {
  it('Admin+Trainer in A, Prüfer in B: Login-Antwort und /ich listen beide Vereine mit Rolle, Rechten, Scopes', async () => {
    const a = (await t.pool.query(`select verein_id from benutzer_vereine bv join benutzer b on b.id = bv.benutzer_id where b.benutzername = 'admin1'`)).rows[0].verein_id;
    const uid = (await t.pool.query(`select id from benutzer where benutzername = 'admin1'`)).rows[0].id;
    const b = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('JC Zweit', true) returning id`)).rows[0].id;
    await t.pool.query(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'mitglied','freigegeben')`, [uid, b]);
    await t.pool.query(`insert into benutzer_rechte (benutzer_id, verein_id, recht_id) select $1,$2,id from rechte where schluessel = 'pruefer'`, [uid, b]);

    const l = await t.login('admin1');
    expect(l.status).toBe(409); // Vereinswahl nötig
    const r = await t.login('admin1', { verein_id: a });
    expect(r.status).toBe(200);
    const o = r.body.benutzer;
    expect(o.aktiver_verein_id).toBe(a);
    expect(o.vereine).toHaveLength(2);
    const va = o.vereine.find((v) => v.id === a); const vb = o.vereine.find((v) => v.id === b);
    expect(va.rolle).toBe('admin');
    expect(va.scope).toContain('benutzer:verwalten');
    expect(vb.rolle).toBe('mitglied');
    expect(vb.rechte).toEqual(['pruefer']);
    expect(vb.scope).not.toContain('benutzer:verwalten');

    const ich = await t.api('GET', '/ich', null, r.body.access_token);
    expect(ich.body.vereine.map((v) => v.id).sort()).toEqual([a, b].sort());
    expect(ich.body.vereine.find((v) => v.id === b).scope).toEqual(vb.scope);
  });
});

describe('Heimatverein und Vereinswechsel', () => {
  it('ohne verein_id landet man im Heimatverein; Wechsel liefert neue Rechte, alte Anmeldung endet', async () => {
    const uid = (await t.pool.query(`select id from benutzer where benutzername = 'admin1'`)).rows[0].id;
    const vs = (await t.pool.query(`select verein_id from benutzer_vereine where benutzer_id = $1 and geloescht_am is null order by (rolle = 'admin') desc`, [uid])).rows.map((r) => r.verein_id);
    const a = (await t.login('admin1', { verein_id: vs[0] })).body;
    const b = vs[1];
    // fremden Verein als Heimatverein lehnt der Server ab
    const fremd = (await t.pool.query(`insert into vereine (name, ist_mandant) values ('Fremd', true) returning id`)).rows[0].id;
    expect((await t.api('PATCH', '/ich', { heimatverein_id: fremd }, a.access_token)).status).toBe(403);
    expect((await t.api('PATCH', '/ich', { heimatverein_id: b }, a.access_token)).status).toBe(200);
    const l = await t.login('admin1');
    expect(l.status).toBe(200);
    expect(l.body.verein_id).toBe(b);
    expect(l.body.benutzer.heimatverein_id).toBe(b);
    // Wechsel nach A
    const w = await t.api('POST', '/auth/verein-wechseln', { verein_id: vs.find((x) => x !== b) }, l.body.access_token);
    expect(w.status).toBe(200);
    expect(w.body.verein_id).not.toBe(b);
    expect((await t.pruefe(w.body.access_token)).payload.rolle).toBe('admin');
    expect((await t.refresh(l.body.refresh_token)).status).toBe(401);
    expect((await t.api('POST', '/auth/verein-wechseln', { verein_id: fremd }, w.body.access_token)).status).toBe(403);
  });
});
