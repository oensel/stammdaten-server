// Zweiten Faktor eines Super-Admins zurücksetzen (Gerät und Backup-Codes verloren). Nur mit Zugriff auf den Server:
//   npm run 2fa:reset -- <benutzername>
// Danach muss der Faktor beim nächsten Login neu eingerichtet werden; alle Sitzungen des Kontos enden.
import { loadConfig } from '../src/config.js';
import { createPool, tx } from '../src/db.js';

const name = process.argv[2];
if (!name) { console.error('Aufruf: npm run 2fa:reset -- <benutzername>'); process.exit(1); }
const pool = createPool(loadConfig().databaseUrl);
try {
  const u = (await pool.query('select id, ist_super_admin from benutzer where lower(benutzername) = lower($1) and geloescht_am is null', [name])).rows[0];
  if (!u) { console.error(`Benutzer „${name}“ gibt es nicht`); process.exit(1); }
  if (!u.ist_super_admin) { console.error('Das Konto ist kein Super-Admin'); process.exit(1); }
  const s = await tx(pool, async (c) => {
    await c.query('update benutzer set totp_secret_verschluesselt = null, totp_aktiv_am = null, totp_letzter_schritt = null where id = $1', [u.id]);
    await c.query('delete from totp_backup_codes where benutzer_id = $1', [u.id]);
    return c.query('update refresh_tokens set widerrufen_am = now() where benutzer_id = $1 and widerrufen_am is null', [u.id]);
  });
  console.log(`Zweiter Faktor von „${name}“ zurückgesetzt, ${s.rowCount} Sitzung(en) beendet. Neu einrichten beim nächsten Login.`);
} finally {
  await pool.end();
}
