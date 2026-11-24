import { buildApp } from './app.js';

import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { verlangeAktuellesSchema } from './migrate.js';

const pruefPool = createPool(loadConfig().databaseUrl);
await verlangeAktuellesSchema(pruefPool);
await pruefPool.end();
const app = await buildApp({ logger: true });
await app.listen({ port: app.cfg.port, host: app.cfg.host });
const zu = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', zu);
process.on('SIGTERM', zu);
