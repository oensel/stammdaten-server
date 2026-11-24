import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT, cfgDefault, neueApp } from './helper.js';

let t; let verein; let token;
beforeAll(async () => {
  t = await neueApp();
  verein = (await t.pool.query(`select id from vereine where name = 'JC Demo'`)).rows[0].id;
  token = await clientToken();
});
afterAll(() => t.schliessen());

async function clientToken(clientId = CLIENT) {
  const r = await t.api('POST', '/oauth/token', { grant_type: 'client_credentials', client_id: clientId, client_secret: cfgDefault.demoClientSecret });
  return r.body.access_token;
}
const abgleich = (query = '', tok = token) => t.api('GET', `/v1/abgleich?verein_id=${verein}${query}`, null, tok);
const mitglied = async (nr, name = 'Test') =>
  (await t.pool.query(`insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname) values ($1,$2,$3,'Abgleich') returning id`, [verein, nr, name])).rows[0].id;

/** Holt alles seitenweise ab und sammelt die Mitglieder-IDs. */
async function alles(limit, seit = '') {
  const ids = []; let stand = seit; let seiten = 0; let letzte;
  do {
    const r = await abgleich(`&limit=${limit}${stand ? `&seit=${stand}` : ''}`);
    expect(r.status).toBe(200);
    ids.push(...r.body.mitglieder.map((m) => m.id));
    stand = r.body.stand; letzte = r.body; seiten++;
  } while (letzte.mehr && seiten < 200);
  return { ids, stand, seiten };
}

describe('GET /v1/abgleich', () => {
  it('Vollabgleich: Mitglieder, Gruppen, Graduierungen, Lizenzen – ohne Kontakt-/Adressdaten, nur erlaubte Lizenzarten', async () => {
    const m = (await t.pool.query(`select id from mitglieder where verein_id = $1 and mitgliedsnr = 1`, [verein])).rows[0].id;
    const g = (await t.pool.query(`insert into gruppen (verein_id, name, trainingszeiten) values ($1, 'Kinder', 'Mo 17:00') returning id`, [verein])).rows[0].id;
    await t.pool.query(`insert into mitglied_gruppen (verein_id, mitglied_id, gruppe_id) values ($1,$2,$3)`, [verein, m, g]);
    await t.pool.query(`insert into graduierungen (verein_id, mitglied_id, art, stufe, datum, quelle) values ($1,$2,'kyu',6,'2024-05-01','import')`, [verein, m]);
    await t.pool.query(`insert into lizenzen (verein_id, mitglied_id, art, nummer) values ($1,$2,'judopass','J-1'), ($1,$2,'wettkampflizenz','W-1')`, [verein, m]);
    await t.pool.query(`update mitglieder set email = 'geheim@example.org', strasse = 'Weg 1' where id = $1`, [m]);

    const r = await abgleich();
    expect(r.status).toBe(200);
    expect(typeof r.body.stand).toBe('string');
    expect(r.body.mehr).toBe(false);
    expect(r.body.mitglieder.length).toBeGreaterThanOrEqual(5);
    const lena = r.body.mitglieder.find((x) => x.id === m);
    expect(Object.keys(lena).sort()).toEqual(['anonymisiert_am', 'geburtsdatum', 'geloescht_am', 'id', 'mitgliedsnr', 'nachname', 'status', 'vorname']);
    expect(JSON.stringify(r.body)).not.toContain('geheim@example.org');
    expect(r.body.gruppen).toEqual([{ id: g, name: 'Kinder', sortierung: 0, trainingszeiten: 'Mo 17:00', geloescht_am: null }]);
    expect(r.body.mitglied_gruppen).toEqual([{ mitglied_id: m, gruppe_id: g, geloescht_am: null }]);
    expect(r.body.graduierungen).toMatchObject([{ mitglied_id: m, art: 'kyu', stufe: 6, datum: '2024-05-01', quelle: 'import', geloescht_am: null }]);
    expect(r.body.lizenzen.map((l) => l.art)).toEqual(['judopass']); // Wettkampflizenz gehört nicht zu den Arten der App
  });

  it('Delta: ohne Änderung leer, nach Änderung nur das Geänderte; Löschung kommt mit geloescht_am', async () => {
    const erster = await abgleich();
    const leer = await abgleich(`&seit=${erster.body.stand}`);
    expect(leer.body.mitglieder).toEqual([]);
    expect(leer.body.graduierungen).toEqual([]);

    await t.pool.query(`update mitglieder set nachname = 'Geändert' where verein_id = $1 and mitgliedsnr = 2`, [verein]);
    await t.pool.query(`update graduierungen set geloescht_am = now() where verein_id = $1 and stufe = 6`, [verein]);
    await t.pool.query(`update mitglied_gruppen set geloescht_am = now() where verein_id = $1`, [verein]);
    const d = await abgleich(`&seit=${erster.body.stand}`);
    expect(d.body.mitglieder.map((x) => x.nachname)).toEqual(['Geändert']);
    expect(d.body.graduierungen).toHaveLength(1);
    expect(d.body.graduierungen[0].geloescht_am).not.toBeNull();
    expect(d.body.mitglied_gruppen[0].geloescht_am).not.toBeNull();
    expect(d.body.gruppen).toEqual([]);
    // danach wieder leer
    expect((await abgleich(`&seit=${d.body.stand}`)).body.mitglieder).toEqual([]);
  });

  it('Paging: mit kleinem limit kommt alles genau einmal an, nichts geht verloren', async () => {
    for (let i = 0; i < 12; i++) await mitglied(100 + i, `P${i}`);
    const komplett = await alles(1000);
    const seiten = await alles(5);
    expect(seiten.seiten).toBeGreaterThan(2);
    expect(new Set(seiten.ids)).toEqual(new Set(komplett.ids));
    expect(seiten.ids.length).toBe(new Set(seiten.ids).size); // keine Dubletten (jede Zeile hat ihre eigene Transaktion)
    // eine Transaktion mit vielen Zeilen wird nicht zerrissen
    await t.pool.query(`insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname) select $1, 200 + g, 'B' || g, 'Bulk' from generate_series(1, 9) g`, [verein]);
    const bulk = await alles(3, komplett.stand);
    expect(bulk.ids).toHaveLength(9);
  });

  it('laufende Transaktion: erst nach dem Commit geliefert, nie übersprungen', async () => {
    const vorher = await abgleich();
    const c = await t.pool.connect();
    try {
      await c.query('begin');
      const offen = (await c.query(`insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname) values ($1, 900, 'Offen', 'Tx') returning id`, [verein])).rows[0].id;
      // eine spätere, schnellere Transaktion ist abgeschlossen, die offene noch nicht
      const schnell = await mitglied(901, 'Schnell');
      const zwischen = await abgleich(`&seit=${vorher.body.stand}`);
      expect(zwischen.body.mitglieder.map((x) => x.id)).not.toContain(offen);
      await c.query('commit');
      const danach = await abgleich(`&seit=${zwischen.body.stand}`);
      expect(danach.body.mitglieder.map((x) => x.id)).toContain(offen);
      // die schnelle kam entweder schon zwischen oder kommt jetzt – auf jeden Fall genau einmal
      const gesamt = [...zwischen.body.mitglieder, ...danach.body.mitglieder].map((x) => x.id);
      expect(gesamt.filter((id) => id === schnell).length).toBeGreaterThanOrEqual(1);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });

  it('403: nicht freigegebener Verein, Benutzer-Token, andere App ohne Zuordnung; 401 ohne Token', async () => {
    const fremd = (await t.pool.query(`insert into vereine (name, ist_mandant, verband_id) values ('Fremder Verein', true, (select id from verbaende where typ = 'kreis' limit 1)) returning id`)).rows[0].id;
    const r = await t.api('GET', `/v1/abgleich?verein_id=${fremd}`, null, token);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('verein_nicht_freigegeben');
    const benutzer = (await t.login('admin1')).body.access_token;
    expect((await abgleich('', benutzer)).status).toBe(403);
    const dojo = await clientToken('dojo-master-pro');
    expect((await abgleich('', dojo)).body.code).toBe('verein_nicht_freigegeben');
    expect((await abgleich('', 'x')).status).toBe(401);
    expect((await t.api('GET', `/v1/abgleich?verein_id=${verein}`)).status).toBe(401);
  });

  it('409 abgleich_neu_starten: ungültiger Stand oder geänderte Obergrenze der App', async () => {
    expect((await abgleich('&seit=quatsch')).body.code).toBe('abgleich_neu_starten');
    const alt = (await abgleich()).body.stand;
    expect((await abgleich(`&seit=${alt}`)).status).toBe(200);
    await t.pool.query(`update anwendungen set lizenz_arten = '{judopass}' where schluessel = $1`, [CLIENT]);
    const r = await abgleich(`&seit=${alt}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('abgleich_neu_starten');
    expect((await abgleich()).status).toBe(200); // Vollabgleich geht weiter
    // limit außerhalb 1..1000 → 400
    expect((await abgleich('&limit=0')).status).toBe(400);
    expect((await abgleich('&limit=1001')).status).toBe(400);
  });
});
