// Startet ein dauerhaftes lokales PostgreSQL (embedded-postgres) für die Entwicklung. Daten in .pgdata-dev, Port 5440.
//   npm run db        (Vordergrund, Strg+C beendet)
import { existsSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

const dir = '.pgdata-dev';
const port = Number(process.env.PGPORT_DEV ?? 5440);
const pg = new EmbeddedPostgres({
  databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true,
  initdbFlags: ['--encoding=UTF8', '--no-locale'], onLog: () => {}, onError: (e) => console.error(String(e)),
});
const neu = !existsSync(`${dir}/PG_VERSION`);
if (neu) await pg.initialise();
await pg.start();
if (neu) await pg.createDatabase('stammdaten');
console.log(`PostgreSQL läuft: postgres://postgres:postgres@127.0.0.1:${port}/stammdaten  (Strg+C beendet)`);
const zu = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', zu);
process.on('SIGTERM', zu);
