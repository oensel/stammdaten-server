// Migrationen: db/schema.sql (Basis) + db/migrations/*.sql (aufsteigend). Gemerkt in der Tabelle schema_migrationen.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db');

export async function migrate(pool) {
  const c = await pool.connect();
  const angewendet = [];
  try {
    await c.query('select pg_advisory_lock(7313001)');
    await c.query(`create table if not exists schema_migrationen (name text primary key, angewendet_am timestamptz not null default now())`);
    const done = new Set((await c.query('select name from schema_migrationen')).rows.map((r) => r.name));
    const dateien = [['schema.sql', path.join(dbDir, 'schema.sql')]];
    try {
      for (const f of (await readdir(path.join(dbDir, 'migrations'))).filter((f) => f.endsWith('.sql')).sort()) dateien.push([f, path.join(dbDir, 'migrations', f)]);
    } catch { /* keine Migrationen */ }
    for (const [name, datei] of dateien) {
      if (done.has(name)) continue;
      await c.query('begin');
      try {
        await c.query(await readFile(datei, 'utf8'));
        await c.query('insert into schema_migrationen (name) values ($1)', [name]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw new Error(`Migration ${name} fehlgeschlagen: ${e.message}`);
      }
      angewendet.push(name);
    }
  } finally {
    await c.query('select pg_advisory_unlock(7313001)').catch(() => {});
    c.release();
  }
  return angewendet;
}

/** Wirft, wenn Migrationen ausstehen (API und Worker starten nie auf altem Schema). */
export async function verlangeAktuellesSchema(pool) {
  const alle = ['schema.sql', ...(await readdir(path.join(dbDir, 'migrations'))).filter((f) => f.endsWith('.sql'))];
  const da = (await pool.query(`select to_regclass('schema_migrationen') is not null as da`)).rows[0].da;
  const done = new Set(da ? (await pool.query('select name from schema_migrationen')).rows.map((r) => r.name) : []);
  const offen = alle.filter((f) => !done.has(f));
  if (offen.length) throw new Error(`Ausstehende Migrationen (${offen.join(', ')}) – zuerst npm run db:migrieren`);
}
