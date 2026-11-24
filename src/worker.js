// Worker-Prozess (AD-10): läuft aus demselben Image wie die API, Start mit `node src/worker.js`.
import { fileURLToPath } from 'node:url';
import { ladeMailAdresse } from './auth.js';
import { loadConfig } from './config.js';
import { createPool, mitSperre } from './db.js';
import { createMailer } from './mailer.js';
import { verlangeAktuellesSchema } from './migrate.js';
import { versendeMails } from './module/benachrichtigung/dienst.js';
import { systemCtx } from './pipeline/ctx.js';

const log = (text) => console.log(`[worker] ${new Date().toISOString()} ${text}`);

/** Alle Jobs: Name → Dienstaufruf mit System-ctx. */
const JOBS = {
  mailversand: (ctx, pool, { mailer, abbruch }) => versendeMails(ctx, pool, { mailer, adresseVon: ladeMailAdresse, abbruch }),
};

/** Führt einen Job unter seinem Advisory-Lock aus; läuft er schon anderswo, passiert nichts (null). */
export const fuehreAus = (pool, name, umgebung, { jetzt } = {}) =>
  mitSperre(pool, `job:${name}`, () => JOBS[name](systemCtx(name, { jetzt }), pool, umgebung));

/**
 * Startet den Worker. Wirft, wenn die Datenbank nicht erreichbar ist.
 * `beenden(code)` wird nach dem Herunterfahren aufgerufen (Standard: process.exit); ein laufender Job wird abgewartet.
 */
export async function starteWorker({ databaseUrl, mailer, intervallMs, beenden = (code) => process.exit(code) } = {}) {
  const cfg = loadConfig();
  const pool = createPool(databaseUrl ?? cfg.databaseUrl);
  const umgebung = { mailer: mailer ?? createMailer(cfg), abbruch: () => gestoppt };
  let takt;
  let lauf = Promise.resolve();
  let laeuft = false;
  let gestoppt = false;
  const runde = async () => {
    for (const name of Object.keys(JOBS)) {
      if (gestoppt) return;
      try {
        await fuehreAus(pool, name, umgebung);
      } catch (e) {
        log(`Job ${name} fehlgeschlagen: ${e.message}`);
      }
    }
  };
  const starteRunde = () => {
    if (laeuft || gestoppt) return;
    laeuft = true;
    lauf = runde().finally(() => { laeuft = false; });
  };
  const stoppen = async (signal) => {
    if (gestoppt) return;
    gestoppt = true;
    log(`${signal ?? 'stopp'} empfangen, beende`);
    clearInterval(takt);
    process.off('SIGINT', aufSignal);
    process.off('SIGTERM', aufSignal);
    let code = 0;
    await lauf;
    await pool.end().catch(() => { code = 1; });
    beenden(code);
  };
  const aufSignal = (signal) => { stoppen(signal); };
  process.on('SIGINT', aufSignal);
  process.on('SIGTERM', aufSignal);
  try {
    await verlangeAktuellesSchema(pool);
  } catch (e) {
    process.off('SIGINT', aufSignal);
    process.off('SIGTERM', aufSignal);
    await pool.end().catch(() => {});
    throw e;
  }
  if (gestoppt) return { pool, stoppen };
  takt = setInterval(starteRunde, intervallMs ?? cfg.workerIntervallSek * 1000);
  starteRunde();
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
