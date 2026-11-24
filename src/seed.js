// Demo-Daten: ein Verein, Mitglieder und je ein Zugang für Schüler, Trainer, Prüfer, Admin (+ Eltern) – App kyu-manager-pro.
import { hashSecret } from './passwords.js';

export const DEMO_ZUGAENGE = [
  { benutzername: 'schueler1', rolle: 'mitglied', rechte: [], mitglied: 1, vorname: 'Lena', nachname: 'Schmidt' },
  { benutzername: 'trainer1', rolle: 'mitglied', rechte: ['trainer'], mitglied: 3, vorname: 'Thomas', nachname: 'Trainer' },
  { benutzername: 'pruefer1', rolle: 'mitglied', rechte: ['pruefer'], mitglied: 4, vorname: 'Petra', nachname: 'Prüfer' },
  { benutzername: 'admin1', rolle: 'admin', rechte: [], mitglied: 5, vorname: 'Anton', nachname: 'Admin' },
  { benutzername: 'eltern1', rolle: 'mitglied', rechte: [], mitglied: null, vorname: 'Monika', nachname: 'Schmidt', kinder: [1, 2] },
];

/** Demo-Client-Secret für die Apps setzen (nur wo noch keins gesetzt ist). */
export async function seedClientSecret(pool, secret) {
  if (!secret) return;
  await pool.query(`update anwendungen set client_secret_hash = $1 where client_secret_hash is null`, [await hashSecret(secret)]);
}

/** Demo-Zuordnung für den Abgleich: JC Demo darf von kyu-manager-pro abgeglichen werden (idempotent). */
export async function seedAnwendungVereine(pool) {
  await pool.query(
    `insert into anwendung_vereine (anwendung_id, verein_id)
     select a.id, v.id from anwendungen a, vereine v where a.schluessel = 'kyu-manager-pro' and v.name = 'JC Demo'
     on conflict do nothing`);
}

/** Demo-Adressen für den App-Umschalter und den Back-Channel-Logout (nur wo noch nichts gesetzt ist). */
export async function seedAnwendungAdressen(pool) {
  await pool.query(
    `update anwendungen set url = coalesce(url, 'http://localhost:5173'), backchannel_url = coalesce(backchannel_url, 'http://127.0.0.1:3000/api/auth/backchannel-logout')
      where schluessel = 'kyu-manager-pro'`);
}

export async function seedDemo(pool, passwort) {
  const vorhanden = (await pool.query(`select id from vereine where name = 'JC Demo'`)).rows[0];
  if (vorhanden) return { uebersprungen: true };
  const hash = await hashSecret(passwort);
  const c = await pool.connect();
  try {
    await c.query('begin');
    const verein = (await c.query(`insert into vereine (name, kurzname, ort, ist_mandant) values ('JC Demo', 'JCD', 'Musterstadt', true) returning id`)).rows[0].id;
    const mitglieder = {};
    for (const [nr, vn, nn, gd] of [[1, 'Lena', 'Schmidt', '2014-05-02'], [2, 'Tim', 'Schmidt', '2016-09-14'], [3, 'Thomas', 'Trainer', '1985-03-01'],
      [4, 'Petra', 'Prüfer', '1980-07-21'], [5, 'Anton', 'Admin', '1975-01-30']]) {
      mitglieder[nr] = (await c.query(
        `insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname, geburtsdatum) values ($1,$2,$3,$4,$5) returning id`,
        [verein, nr, vn, nn, gd])).rows[0].id;
    }
    for (const z of DEMO_ZUGAENGE) {
      const b = (await c.query(
        `insert into benutzer (benutzername, vorname, nachname, passwort_hash) values ($1,$2,$3,$4) returning id`,
        [z.benutzername, z.vorname, z.nachname, hash])).rows[0].id;
      await c.query(
        `insert into benutzer_vereine (benutzer_id, verein_id, rolle, mitglied_id, status, angefragt_ueber, entschieden_am)
         values ($1,$2,$3,$4,'freigegeben','verwaltung', now())`, [b, verein, z.rolle, z.mitglied ? mitglieder[z.mitglied] : null]);
      for (const r of z.rechte) {
        await c.query(`insert into benutzer_rechte (benutzer_id, verein_id, recht_id) select $1, $2, id from rechte where schluessel = $3`, [b, verein, r]);
      }
      for (const k of z.kinder || []) {
        await c.query(`insert into erziehungsberechtigte (benutzer_id, verein_id, mitglied_id, beziehung) values ($1,$2,$3,'mutter')`, [b, verein, mitglieder[k]]);
      }
    }
    await c.query('commit');
    return { verein };
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
