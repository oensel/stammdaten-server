import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neueApp } from './helper.js';

let t;
beforeAll(async () => { t = await neueApp(); });
afterAll(() => t.schliessen());

// winziges gültiges PNG (Signatur genügt für die Typprüfung)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-des-bildes')]);

const formular = (name, inhalt, typ = 'image/png') => {
  const b = '----testgrenze';
  const kopf = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="datei"; filename="${name}"\r\nContent-Type: ${typ}\r\n\r\n`);
  return { payload: Buffer.concat([kopf, inhalt, Buffer.from(`\r\n--${b}--\r\n`)]), type: `multipart/form-data; boundary=${b}` };
};
const roh = (method, url, token, payload, type) =>
  t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, ...(type ? { 'content-type': type } : {}) } });

describe('Eintrittsdatum', () => {
  it('nur mit Scope mitglieder:eintritt (Dojo-Master-Pro); der Import setzt es nie', async () => {
    const m = (await t.pool.query('select id from mitglieder order by mitgliedsnr limit 1')).rows[0].id;
    const kyu = (await t.login('admin1')).body.access_token;
    expect((await t.api('PATCH', `/mitglieder/${m}`, { eintritt: '2020-03-01' }, kyu)).status).toBe(403);
    const dojo = (await t.login('admin1', { client_id: 'dojo-master-pro' })).body.access_token;
    const r = await t.api('PATCH', `/mitglieder/${m}`, { eintritt: '2020-03-01' }, dojo);
    expect(r.status).toBe(200);
    expect(r.body.eintritt).toBe('2020-03-01');
    const csv = ['ID;Nachname;Vorname;Anmelde-Datum', `${'7001'};Neu;Person;2019-01-01`].join('\r\n');
    await roh('POST', '/mitglieder/import', kyu, csv, 'text/csv');
    expect((await t.pool.query(`select eintritt from mitglieder where djb_id = '7001'`)).rows[0].eintritt).toBeNull();
    const l = await t.api('GET', '/mitglieder', null, dojo);
    expect(l.body.mitglieder.find((x) => x.id === m).eintritt).toBe('2020-03-01');
  });
});

describe('Passfoto', () => {
  it('Upload per Formular durch das Mitglied selbst, Abruf, Ersetzen, Löschen', async () => {
    const eigen = (await t.pool.query(`select bv.mitglied_id from benutzer_vereine bv join benutzer b on b.id = bv.benutzer_id where b.benutzername = 'schueler1'`)).rows[0].mitglied_id;
    const tok = (await t.login('schueler1')).body.access_token;
    const f = formular('Foto Mia.png', PNG);
    const up = await roh('PUT', `/mitglieder/${eigen}/passfoto`, tok, f.payload, f.type);
    expect(up.statusCode).toBe(200);
    expect(JSON.parse(up.body).mime_typ).toBe('image/png');
    const get = await roh('GET', `/mitglieder/${eigen}/passfoto`, tok);
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(get.rawPayload, PNG)).toBe(0);
    // direkter Bild-Upload ersetzt das vorhandene (nur ein aktives Passfoto)
    const neu = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jpeg')]);
    expect((await roh('PUT', `/mitglieder/${eigen}/passfoto`, tok, neu, 'image/jpeg')).statusCode).toBe(200);
    expect((await t.pool.query(`select count(*)::int n from dokumente where mitglied_id = $1 and art = 'passfoto' and geloescht_am is null`, [eigen])).rows[0].n).toBe(1);
    expect((await roh('DELETE', `/mitglieder/${eigen}/passfoto`, tok)).statusCode).toBe(204);
    expect((await roh('GET', `/mitglieder/${eigen}/passfoto`, tok)).statusCode).toBe(404);
  });

  it('abgelehnt: fremdes Mitglied, falscher Dateityp, ohne Anmeldung', async () => {
    const eigen = (await t.pool.query(`select bv.mitglied_id from benutzer_vereine bv join benutzer b on b.id = bv.benutzer_id where b.benutzername = 'schueler1'`)).rows[0].mitglied_id;
    const fremd = (await t.pool.query('select id from mitglieder where id <> $1 limit 1', [eigen])).rows[0].id;
    const tok = (await t.login('schueler1')).body.access_token;
    const f = formular('x.png', PNG);
    expect((await roh('PUT', `/mitglieder/${fremd}/passfoto`, tok, f.payload, f.type)).statusCode).toBe(403);
    const pdf = formular('x.pdf', Buffer.from('%PDF-1.4 ...'), 'application/pdf');
    expect((await roh('PUT', `/mitglieder/${eigen}/passfoto`, tok, pdf.payload, pdf.type)).statusCode).toBe(400);
    expect((await roh('PUT', `/mitglieder/${eigen}/passfoto`, 'x', f.payload, f.type)).statusCode).toBe(401);
  });
});
