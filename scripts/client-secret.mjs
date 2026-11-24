// Neues Client-Secret für eine App erzeugen (wird nur einmal angezeigt, in der Datenbank liegt der argon2-Hash):
//   npm run client:secret -- kyu-manager-pro
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { hashSecret } from '../src/passwords.js';

const schluessel = process.argv[2];
if (!schluessel) { console.error('Aufruf: npm run client:secret -- <anwendung>'); process.exit(1); }
const pool = createPool(loadConfig().databaseUrl);
try {
  const secret = randomBytes(32).toString('base64url');
  const r = await pool.query('update anwendungen set client_secret_hash = $2 where schluessel = $1', [schluessel, await hashSecret(secret)]);
  if (!r.rowCount) { console.error(`Anwendung „${schluessel}“ gibt es nicht`); process.exit(1); }
  console.log(`client_id:     ${schluessel}\nclient_secret: ${secret}\n(wird nicht wieder angezeigt)`);
} finally {
  await pool.end();
}
