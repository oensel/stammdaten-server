import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT, cfgDefault, neueApp } from './helper.js';

let t; let verein; let mitglied; let token;
beforeAll(async () => {
  t = await neueApp();
  verein = (await t.pool.query(`select id from vereine where name = 'JC Demo'`)).rows[0].id;
  mitglied = (await t.pool.query(`select id from mitglieder where verein_id = $1 and mitgliedsnr = 1`, [verein])).rows[0].id;
  token = await clientToken();
});
afterAll(() => t.schliessen());

async function clientToken(clientId = CLIENT) {
  return (await t.api('POST', '/oauth/token', { grant_type: 'client_credentials', client_id: clientId, client_secret: cfgDefault.demoClientSecret })).body.access_token;
}
const post = (body, tok = token) => t.api('POST', '/v1/graduierungen', { verein_id: verein, mitglied_id: mitglied, art: 'kyu', stufe: 5, datum: '2025-03-01', ...body }, tok);
const loesche = (id, tok = token, v = verein) => t.api('DELETE', `/v1/graduierungen/${id}?verein_id=${v}`, null, tok);
const zeile = async (id) => (await t.pool.query('select * from graduierungen where id = $1', [id])).rows[0];
const abgleich = (seit = '') => t.api('GET', `/v1/abgleich?verein_id=${verein}${seit ? `&seit=${seit}` : ''}`, null, token);

describe('Graduierungen zurückschreiben', () => {
  it('neu → 201 mit quelle der App; erscheint im Abgleich', async () => {
    const vorher = (await abgleich()).body.stand;
    const r = await post({ ort: 'Halle', pruefer: 'P. Prüfer' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mitglied_id: mitglied, art: 'kyu', stufe: 5, datum: '2025-03-01', quelle: 'kyu-manager-pro' });
    const z = await zeile(r.body.id);
    expect(z).toMatchObject({ ort: 'Halle', pruefer: 'P. Prüfer', geaendert_von: null });
    const d = await abgleich(vorher);
    expect(d.body.graduierungen.map((g) => g.id)).toEqual([r.body.id]);
  });

  it('gleiche Quelle: aktualisiert (200); unverändert bleibt unverändert', async () => {
    const r = await post({ stufe: 4, datum: '2025-04-01' });
    const seq = (await zeile(r.body.id)).change_seq;
    const gleich = await post({ stufe: 4, datum: '2025-04-01' });
    expect(gleich.status).toBe(200);
    expect((await zeile(r.body.id)).change_seq).toBe(seq); // nichts angefasst
    const neu = await post({ stufe: 4, datum: '2025-04-15' });
    expect(neu.status).toBe(200);
    expect(neu.body.id).toBe(r.body.id);
    expect((await zeile(r.body.id)).datum).toBe('2025-04-15');
  });

  it('weich gelöscht: wird wiederbelebt', async () => {
    const r = await post({ stufe: 3, datum: '2025-05-01' });
    expect((await loesche(r.body.id)).status).toBe(204);
    expect((await zeile(r.body.id)).geloescht_am).not.toBeNull();
    const w = await post({ stufe: 3, datum: '2025-06-01' });
    expect(w.status).toBe(200);
    expect(w.body.id).toBe(r.body.id);
    const z = await zeile(r.body.id);
    expect(z.geloescht_am).toBeNull();
    expect(z.datum).toBe('2025-06-01');
  });

  it('andere Quelle: gleiches Datum → 200 unverändert, anderes Datum → 409 graduierung_vorhanden', async () => {
    const id = (await t.pool.query(
      `insert into graduierungen (verein_id, mitglied_id, art, stufe, datum, quelle) values ($1,$2,'kyu',2,'2024-01-10','import') returning id`, [verein, mitglied])).rows[0].id;
    const gleich = await post({ stufe: 2, datum: '2024-01-10' });
    expect(gleich.status).toBe(200);
    expect(gleich.body).toMatchObject({ id, quelle: 'import', datum: '2024-01-10' });
    const anders = await post({ stufe: 2, datum: '2024-02-20' });
    expect(anders.status).toBe(409);
    expect(anders.body).toMatchObject({ code: 'graduierung_vorhanden', id, datum: '2024-01-10' });
    expect((await zeile(id)).datum).toBe('2024-01-10');
    expect((await zeile(id)).quelle).toBe('import');
  });

  it('DELETE: nur eigene Quelle (403 fremde_quelle), unbekannt 404, doppelt löschen ist idempotent; Löschung kommt im Abgleich', async () => {
    const fremd = (await t.pool.query(
      `insert into graduierungen (verein_id, mitglied_id, art, stufe, datum, quelle) values ($1,$2,'dan',1,'2020-01-01','dojo-master-pro') returning id`, [verein, mitglied])).rows[0].id;
    const r = await loesche(fremd);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('fremde_quelle');
    expect((await zeile(fremd)).geloescht_am).toBeNull();
    expect((await loesche('00000000-0000-4000-8000-000000000000')).status).toBe(404);

    const eigen = (await post({ stufe: 1, datum: '2025-07-01' })).body.id;
    const stand = (await abgleich()).body.stand;
    expect((await loesche(eigen)).status).toBe(204);
    expect((await loesche(eigen)).status).toBe(204);
    const d = await abgleich(stand);
    expect(d.body.graduierungen.find((g) => g.id === eigen).geloescht_am).not.toBeNull();
  });

  it('Fehlerfälle: Benutzer-Token 403, fremder Verein 403, unbekanntes Mitglied 404, ungültige Stufe 400, App ohne Scope/Quelle 403', async () => {
    const benutzer = (await t.login('admin1')).body.access_token;
    const b = await post({}, benutzer);
    expect(b.status).toBe(403);
    expect(b.body.code).toBe('nur_anwendung');
    expect((await loesche('00000000-0000-4000-8000-000000000000', benutzer)).body.code).toBe('nur_anwendung');

    const fremdVerein = (await t.pool.query(`insert into vereine (name, ist_mandant, verband_id) values ('Fremd', true, (select id from verbaende where typ = 'kreis' limit 1)) returning id`)).rows[0].id;
    const f = await post({ verein_id: fremdVerein });
    expect(f.status).toBe(403);
    expect(f.body.code).toBe('verein_nicht_freigegeben');

    const fremdesMitglied = (await t.pool.query(`insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname) values ($1,1,'F','F') returning id`, [fremdVerein])).rows[0].id;
    const m = await post({ mitglied_id: fremdesMitglied });
    expect(m.status).toBe(404);
    expect(m.body.code).toBe('mitglied_unbekannt');

    expect((await post({ art: 'kyu', stufe: 10 })).status).toBe(400);
    expect((await post({ datum: 'gestern' })).status).toBe(400);
    expect((await post({}, 'x')).status).toBe(401);

    // Hajime-Pro: kein Scope graduierungen:schreiben (und kein Verein zugeordnet)
    await t.pool.query(`insert into anwendung_vereine (anwendung_id, verein_id) select id, $1 from anwendungen where schluessel = 'hajime-pro'`, [verein]);
    const h = await post({}, await clientToken('hajime-pro'));
    expect(h.status).toBe(403);
    expect(h.body.code).toBe('scope_fehlt');
  });
});
