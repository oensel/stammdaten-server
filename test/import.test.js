import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neueApp } from './helper.js';

let t;
beforeAll(async () => { t = await neueApp(); });
afterAll(() => t.schliessen());

// Erfundene Daten im Format des DJB-Exports (Teilmenge der Spalten genügt)
const KOPF = 'ID;Nachname;Vorname;Geburtsdatum;Geschlecht;Kontoinhaber;IBAN (SEPA);Abbuchungsintervall;Email;Straße;PLZ;Ort;Land;Anmelde-Datum;Beitragsart;Bemerkung;'
  + '1. Kyu - Braun Nr.;1. Kyu - Braun Datum;5. Kyu - Orange Nr.;5. Kyu - Orange Datum;9. Kyu Nr.;9. Kyu Datum;Judopass Nr.;Judopass gültig bis;Erste-Hilfe Datum';
const ZEILEN = [
  '9001;Muster;Mia;2012-05-01;Weiblich;"Max Muster";DE00123;jährlich;mia@example.org;"Hauptstr. 1";8046;Zürich;Schweiz;2024-01-15;"1. Kind";;KYU-1;2024-11-25;KYU-5;2023-03-01;;;J-0001;2027-02-28;2025-06-01',
  '9002;Muster;Max;1980-01-02;Männlich;"Max Muster";;;;"Hauptstr. 1";48308;Senden;;;passiv;Trainer;;;;;;;;;',
  '9003;;Ohne;1999-01-01;;;;;;;;;;;;;;;;;;;;;',
  '9004;Falsch;Datum;31.02.2000;;;;;;;;;;;;;;;;;;;;;',
  '9001;Doppelt;Id;2000-01-01;;;;;;;;;;;;;;;;;;;;;',
];
const csv = (extra = []) => [KOPF, ...ZEILEN, ...extra].join('\r\n');

const post = (token, query, body, type = 'text/csv') =>
  t.app.inject({ method: 'POST', url: `/mitglieder/import${query}`, payload: body, headers: { authorization: `Bearer ${token}`, 'content-type': type } })
    .then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

describe('Mitglieder-Import (DJB-Export)', () => {
  let admin; let trainer;
  beforeAll(async () => { admin = (await t.login('admin1')).body.access_token; trainer = (await t.login('trainer1')).body.access_token; });

  it('nur Admin mit Scope mitglieder:import; ohne Token 401', async () => {
    expect((await post(trainer, '', csv())).status).toBe(403);
    expect((await post('x', '', csv())).status).toBe(401);
  });

  it('Trockenlauf schreibt nichts, meldet aber Zahlen, Fehler und Warnungen', async () => {
    const vorher = (await t.pool.query('select count(*)::int n from mitglieder')).rows[0].n;
    const r = await post(admin, '?pruefen=true', csv());
    expect(r.status).toBe(200);
    expect(r.body.trockenlauf).toBe(true);
    expect(r.body.mitglieder).toEqual({ neu: 2, aktualisiert: 0, fehler: 3 });
    expect(r.body.fehler.map((f) => f.zeile).sort()).toEqual([4, 5, 6]);
        expect((await t.pool.query('select count(*)::int n from mitglieder')).rows[0].n).toBe(vorher);
  });

  it('Import legt Mitglieder, Zahler, Graduierungen und Lizenzen an', async () => {
    const r = await post(admin, '', csv());
    expect(r.body.mitglieder.neu).toBe(2);
    expect(r.body.graduierungen).toBe(2);
    const mia = (await t.pool.query(`select * from mitglieder where djb_id = '9001'`)).rows[0];
    expect(mia).toMatchObject({ vorname: 'Mia', geschlecht: 'w', land: 'CH', plz: '8046' });
    const max = (await t.pool.query(`select * from mitglieder where djb_id = '9002'`)).rows[0];
    expect(max.djb_id).toBe('9002');
    const gr = (await t.pool.query(`select art, stufe, urkunden_nr from graduierungen where mitglied_id = $1 order by stufe`, [mia.id])).rows;
    expect(gr).toEqual([{ art: 'kyu', stufe: 1, urkunden_nr: 'KYU-1' }, { art: 'kyu', stufe: 5, urkunden_nr: 'KYU-5' }]);
    const liz = (await t.pool.query(`select art, nummer from lizenzen where mitglied_id = $1 order by art`, [mia.id])).rows;
    expect(liz.map((l) => l.art)).toEqual(['judopass']);
    // Abrechnungsdaten sind in der Datenbank gar nicht vorgesehen
    const tabellen = (await t.pool.query("select table_name from information_schema.tables where table_name in ('zahler', 'sepa_mandate')")).rows;
    expect(tabellen).toEqual([]);
  });

  it('erneuter Import aktualisiert statt zu verdoppeln und leert nichts', async () => {
    const r = await post(admin, '', csv(['9001;Muster;Mia;;;;;;;;;;;;;;;;;;;;;']).replace('9001;Doppelt;Id;2000-01-01;;;;;;;;;;;;;;;;;;;;;', ''));
    expect(r.body.mitglieder.neu).toBe(0);
    expect(r.body.mitglieder.aktualisiert).toBeGreaterThanOrEqual(2);
    expect((await t.pool.query(`select count(*)::int n from mitglieder where djb_id in ('9001','9002')`)).rows[0].n).toBe(2);
    expect((await t.pool.query(`select email from mitglieder where djb_id = '9001'`)).rows[0].email).toBe('mia@example.org');
    expect((await t.pool.query(`select count(*)::int n from graduierungen g join mitglieder m on m.id = g.mitglied_id where m.djb_id = '9001'`)).rows[0].n).toBe(2);
  });

  it('Lesen: Kontaktdaten nur mit Scope (Dojo-Master-Pro ja, Kyu-Manager-Pro nie); Datei ohne Namensspalten wird abgelehnt', async () => {
    const kyu = await t.api('GET', '/mitglieder', null, trainer);
    expect(kyu.status).toBe(200);
    expect(kyu.body.mitglieder.find((m) => m.vorname === 'Mia').email).toBeUndefined();
    const dojo = (await t.login('trainer1', { client_id: 'dojo-master-pro' })).body.access_token;
    const l = await t.api('GET', '/mitglieder', null, dojo);
    expect(l.body.mitglieder.find((m) => m.vorname === 'Mia').email).toBe('mia@example.org');
    expect((await post(admin, '', 'a;b;c')).status).toBe(400);
  });
});
