// Nur Migrationen und Signaturschlüssel, ohne Demo-Daten – für Produktion:  npm run db:migrieren
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { ladeSchluessel } from '../src/keys.js';

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
try {
  const m = await migrate(pool);
  console.log(m.length ? `Migrationen: ${m.join(', ')}` : 'Migrationen: nichts zu tun');
  await ladeSchluessel(pool, cfg.schluesselKek);
} finally {
  await pool.end();
}
