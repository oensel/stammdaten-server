// Startet ein lokales PostgreSQL (embedded-postgres), spielt db/schema.sql in eine frische Datenbank ein und prüft
// die wichtigsten Regeln. Daten liegen in .pgdata/ und werden am Ende gelöscht.
//
//   npm run db:test
//   npm run db:test -- --behalten   → Server läuft weiter (Port wird ausgegeben), Strg+C beendet und löscht

import { readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.pgdata');
const port = Number(process.env.PGPORT_TEST ?? 54329);
const behalten = process.argv.includes('--behalten');

await rm(dataDir, { recursive: true, force: true });
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: false,
  initdbFlags: ['--encoding=UTF8', '--no-locale'],
  onLog: () => {},
});

let fehler = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (e) {
    fehler++;
    console.log(`  ✘ ${name}\n      ${e.message}`);
  }
}
async function wirdAbgelehnt(db, sql, params, muster) {
  await db.query('savepoint t');
  try {
    await db.query(sql, params);
  } catch (e) {
    await db.query('rollback to savepoint t');
    if (muster && !muster.test(e.message)) throw new Error(`falscher Fehler: ${e.message}`);
    return;
  }
  await db.query('rollback to savepoint t');
  throw new Error('wurde nicht abgelehnt');
}

await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('stammdaten_test');
  const db = pg.getPgClient('stammdaten_test');
  await db.connect();

  const { rows: [{ server_version: version }] } = await db.query('show server_version');
  console.log(`PostgreSQL ${version} auf Port ${port}`);

  const schema = await readFile(path.join(root, 'db', 'schema.sql'), 'utf8');
  await db.query(schema);
  const migDir = path.join(root, 'db', 'migrations');
  for (const f of (await readdir(migDir)).filter((f) => f.endsWith('.sql')).sort()) await db.query(await readFile(path.join(migDir, f), 'utf8'));
  console.log('✔ schema.sql und Migrationen eingespielt\n');

  await db.query('begin');

  await test('Seed: vier Anwendungen (mit Migrationen), vier Rechte', async () => {
    const { rows: [r] } = await db.query(
      `select (select count(*) from anwendungen)::int a, (select count(*) from rechte)::int r`);
    assert.deepEqual(r, { a: 4, r: 4 });
  });

  await test('client_scopes muss Teilmenge von scopes sein', () => wirdAbgelehnt(db,
    `insert into anwendungen (schluessel, name, scopes, client_scopes) values ('x', 'X', '{a}', '{a,b}')`,
    [], /check/i));

  // Testdaten: zwei Vereine
  let kreis = null;
  for (const typ of ['dachverband', 'landesverband', 'bezirk', 'kreis']) {
    kreis = (await db.query('insert into verbaende (name, typ, uebergeordnet_id) values ($1, $1, $2) returning id', [typ, kreis])).rows[0].id;
  }
  const { rows: [v1] } = await db.query(`insert into vereine (name, ist_mandant, verband_id) values ('JC Test', true, $1) returning id`, [kreis]);
  await db.query(`insert into vereine (name, ist_mandant, verband_id) values ('JC Anders', true, $1)`, [kreis]);
  const { rows: [m1] } = await db.query(
    `insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname) values ($1, 1, 'Lena', 'Schmidt')
     returning id, change_seq, change_xid::text`, [v1.id]);

  await test('Trigger setzt change_seq und change_xid neu', async () => {
    const { rows: [n] } = await db.query(
      `update mitglieder set vorname = 'Lena Marie' where id = $1 returning change_seq, change_xid::text`, [m1.id]);
    assert.ok(Number(n.change_seq) > Number(m1.change_seq));
  });

  await test('View mitglied_aktueller_grad: Dan vor Kyu, beim Kyu die kleinste Zahl', async () => {
    await db.query(`insert into graduierungen (verein_id, mitglied_id, art, stufe) values
      ($1, $2, 'kyu', 6), ($1, $2, 'kyu', 1), ($1, $2, 'kyu', 3)`, [v1.id, m1.id]);
    let { rows: [g] } = await db.query(`select bezeichnung from mitglied_aktueller_grad where mitglied_id = $1`, [m1.id]);
    assert.equal(g.bezeichnung, '1. Kyu');
    await db.query(`insert into graduierungen (verein_id, mitglied_id, art, stufe) values ($1, $2, 'dan', 1)`, [v1.id, m1.id]);
    ({ rows: [g] } = await db.query(`select bezeichnung from mitglied_aktueller_grad where mitglied_id = $1`, [m1.id]));
    assert.equal(g.bezeichnung, '1. Dan');
  });

  await test('Ungültige Graduierung (10. Kyu) wird abgelehnt', () => wirdAbgelehnt(db,
    `insert into graduierungen (verein_id, mitglied_id, art, stufe) values ($1, $2, 'kyu', 10)`, [v1.id, m1.id], /check/i));

  await test('View mitglied_judopass liefert den neuesten Pass', async () => {
    await db.query(`insert into lizenzen (verein_id, mitglied_id, art, nummer, gueltig_bis) values
      ($1, $2, 'judopass', 'A1', '2024-12-31'), ($1, $2, 'judopass', 'A2', '2027-12-31')`, [v1.id, m1.id]);
    const { rows: [p] } = await db.query(`select nummer from mitglied_judopass where mitglied_id = $1`, [m1.id]);
    assert.equal(p.nummer, 'A2');
  });

  await test('Wirksame Rechte nur bei freigegebener Vereinszugehörigkeit', async () => {
    const { rows: [b] } = await db.query(`insert into benutzer (benutzername) values ('trainer1') returning id`);
    await db.query(`insert into benutzer_vereine (benutzer_id, verein_id, status) values ($1, $2, 'angefragt')`, [b.id, v1.id]);
    await db.query(`insert into benutzer_rechte (benutzer_id, verein_id, recht_id)
      select $1, $2, id from rechte where schluessel = 'trainer'`, [b.id, v1.id]);
    const zaehle = async () => (await db.query(
      `select count(*)::int n from benutzer_wirksame_rechte where benutzer_id = $1`, [b.id])).rows[0].n;
    assert.equal(await zaehle(), 0);
    await db.query(`update benutzer_vereine set status = 'freigegeben' where benutzer_id = $1`, [b.id]);
    assert.equal(await zaehle(), 1);
  });

  await test('datenschutz_bereinigen() lässt ausgetretene Mitglieder unverändert (FR-78)', async () => {
    const { rows: [alt] } = await db.query(
      `insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname, austritt, status, email)
       values ($1, 2, 'Max', 'Alt', current_date - interval '4 years', 'ausgetreten', 'max@example.org')
       returning id`, [v1.id]);
    const { rows } = await db.query(`select * from datenschutz_bereinigen()`);
    assert.ok(!rows.find((r) => r.bereich === 'mitglieder'), JSON.stringify(rows));
    const { rows: [m] } = await db.query(`select nachname, email, anonymisiert_am from mitglieder where id = $1`, [alt.id]);
    assert.equal(m.nachname, 'Alt');
    assert.equal(m.email, 'max@example.org');
    assert.equal(m.anonymisiert_am, null);
  });

  await db.query('commit');

  await test('Abgleich-Cursor (change_xid) liefert abgeschlossene Änderungen', async () => {
    const { rows: [{ bis }] } = await db.query(`select pg_snapshot_xmin(pg_current_snapshot())::text bis`);
    const { rows } = await db.query(
      `select id from mitglieder where verein_id = $1 and change_xid >= '0'::xid8 and change_xid < $2::xid8`,
      [v1.id, bis]);
    assert.equal(rows.length, 2);
  });

  await db.end();
} finally {
  if (behalten) {
    console.log(`\nServer läuft: postgres://postgres:postgres@localhost:${port}/stammdaten_test (Strg+C beendet)`);
    process.on('SIGINT', async () => { await pg.stop(); process.exit(fehler ? 1 : 0); });
  } else {
    await pg.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

console.log(fehler ? `\n${fehler} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
// embedded-postgres hält den Prozess offen; process.exit beendet ihn (der Hinweis „SYNCHRONOUS TERMINATION NOTICE“ ist harmlos,
// der Server ist zu diesem Zeitpunkt schon gestoppt).
if (!behalten) process.exit(fehler ? 1 : 0);
