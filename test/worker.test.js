// Worker: startet gegen die Test-DB, endet auf SIGTERM sauber mit 0; ohne DB scheitert der Start.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { starteWorker } from '../src/worker.js';

async function testDb() {
  const base = inject('pgBase');
  const name = `t_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query(`create database ${name} template vorlage`);
  await admin.end();
  return `${base}/${name}`;
}

describe('Worker', () => {
  it('startet und endet auf SIGTERM mit Exit 0', async () => {
    const vorher = process.listeners('SIGTERM').length;
    let code;
    const beendet = new Promise((r) => { code = r; });
    await starteWorker({ databaseUrl: await testDb(), beenden: code });
    process.emit('SIGTERM', 'SIGTERM');
    expect(await beendet).toBe(0);
    expect(process.listeners('SIGTERM').length).toBe(vorher);
  });

  it('scheitert, wenn die Datenbank nicht erreichbar ist', async () => {
    await expect(starteWorker({ databaseUrl: 'postgres://x:y@127.0.0.1:1/nichts', beenden: () => {} })).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('als eigener Prozess: SIGTERM → Exit 0', async () => {
    const url = await testDb();
    const kind = spawn(process.execPath, ['src/worker.js'], { env: { ...process.env, DATABASE_URL: url } });
    await new Promise((ok, fehler) => {
      kind.stdout.on('data', (d) => { if (String(d).includes('gestartet')) ok(); });
      kind.on('exit', (c) => fehler(new Error(`vorzeitig beendet: ${c}`)));
    });
    const exit = new Promise((r) => kind.on('exit', (c) => r(c)));
    kind.kill('SIGTERM');
    expect(await exit).toBe(0);
  });
});
