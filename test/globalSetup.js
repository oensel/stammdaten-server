// Startet ein Wegwerf-PostgreSQL, bereitet eine Vorlagen-Datenbank (Schema + Demo-Seed) vor. Jede Testdatei klont sie.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { ladeSchluessel } from '../src/keys.js';
import { seedAnwendungVereine, seedClientSecret, seedDemo } from '../src/seed.js';
import { loadConfig } from '../src/config.js';

const PORT = 54330;
let pg; let dir;

export async function setup({ provide }) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'stammdaten-test-'));
  pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false,
    initdbFlags: ['--encoding=UTF8', '--no-locale'], onLog: () => {}, onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('vorlage');
  const base = `postgres://postgres:postgres@127.0.0.1:${PORT}`;
  const cfg = loadConfig();
  const pool = createPool(`${base}/vorlage`);
  await migrate(pool);
  await ladeSchluessel(pool, cfg.schluesselKek);
  await seedDemo(pool, cfg.demoPasswort);
  await seedClientSecret(pool, cfg.demoClientSecret);
  await seedAnwendungVereine(pool);
  await pool.end();
  provide('pgBase', base);
}

export async function teardown() {
  await pg?.stop();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
