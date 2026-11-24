// Migrationen (db/schema.sql) einspielen und Demo-Daten anlegen:  npm run db:setup
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { ladeSchluessel } from '../src/keys.js';
import { seedAnwendungAdressen, seedAnwendungVereine, seedClientSecret, seedDemo } from '../src/seed.js';

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
try {
  const m = await migrate(pool);
  console.log(m.length ? `Migrationen: ${m.join(', ')}` : 'Migrationen: nichts zu tun');
  await ladeSchluessel(pool, cfg.schluesselKek);
  await seedClientSecret(pool, cfg.demoClientSecret);
  const s = await seedDemo(pool, cfg.demoPasswort);
  await seedAnwendungVereine(pool);
  await seedAnwendungAdressen(pool);
  console.log(s.uebersprungen ? 'Demo-Daten: schon vorhanden' : 'Demo-Daten angelegt (Zugänge siehe README, Passwort DEMO_PASSWORT)');
} finally {
  await pool.end();
}
