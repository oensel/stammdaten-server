// Worker-Prozess (AD-1): läuft aus demselben Image wie die API, Start mit `node src/worker.js`.
// Noch ohne Jobs (kommen mit späteren Stories); prüft nur die DB-Verbindung und bleibt wach.
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const log = (text) => console.log(`[worker] ${new Date().toISOString()} ${text}`);

/**
 * Startet den Worker. Wirft, wenn die Datenbank nicht erreichbar ist.
 * `beenden(code)` wird nach dem Herunterfahren aufgerufen (Standard: process.exit).
 */
export async function starteWorker({ databaseUrl = loadConfig().databaseUrl, beenden = (code) => process.exit(code) } = {}) {
  const pool = createPool(databaseUrl);
  let wach;
  let gestoppt = false;
  const stoppen = async (signal) => {
    if (gestoppt) return;
    gestoppt = true;
    log(`${signal ?? 'stopp'} empfangen, beende`);
    clearInterval(wach);
    process.off('SIGINT', aufSignal);
    process.off('SIGTERM', aufSignal);
    let code = 0;
    await pool.end().catch(() => { code = 1; });
    beenden(code);
  };
  const aufSignal = (signal) => { stoppen(signal); };
  process.on('SIGINT', aufSignal);
  process.on('SIGTERM', aufSignal);
  try {
    await pool.query('select 1');
  } catch (e) {
    process.off('SIGINT', aufSignal);
    process.off('SIGTERM', aufSignal);
    await pool.end().catch(() => {});
    throw e;
  }
  if (gestoppt) return { pool, stoppen };
  wach = setInterval(() => {}, 60 * 60 * 1000);
  log('gestartet, Datenbank erreichbar');
  return { pool, stoppen };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await starteWorker();
  } catch (e) {
    console.error(`[worker] Start fehlgeschlagen: ${e.message}`);
    process.exit(1);
  }
}
