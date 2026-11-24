import pg from 'pg';

// date bleibt "YYYY-MM-DD" (sonst Zeitzonen-Verschiebung im JSON); bigint als String (Standard)
pg.types.setTypeParser(1082, (v) => v);
// Ohne error-Listener beendet ein Verbindungsverlust den ganzen Prozess; laufende Abfragen melden den Fehler ohnehin selbst.
export function createPool(url) {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const melde = (e) => console.error(`[db] Verbindung verloren: ${e.message}`);
  pool.on('error', melde);
  pool.on('connect', (c) => c.on('error', melde));
  return pool;
}

export async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const istPool = (db) => db instanceof pg.Pool;

/** Pool → eigene Transaktion, Transaktion → keine eigene (AD-2). */
export const inTransaktion = (db, fn) => (istPool(db) ? tx(db, fn) : fn(db));

export function verlangeTransaktion(db, wer) {
  if (istPool(db)) throw new Error(`${wer} braucht die Transaktion des Aufrufers, nicht den Pool`);
}

/** Führt fn unter einem Advisory-Lock aus; hält ihn schon jemand, liefert es null ohne auszuführen. */
export async function mitSperre(pool, name, fn) {
  const c = await pool.connect();
  let defekt;
  try {
    const { rows: [{ frei }] } = await c.query('select pg_try_advisory_lock(hashtextextended($1, 0)) frei', [name]);
    if (!frei) return null;
    try {
      return await fn();
    } finally {
      // Scheitert das Freigeben, wird die Verbindung verworfen und damit auch die Sperre
      await c.query('select pg_advisory_unlock(hashtextextended($1, 0))', [name]).catch((e) => { defekt = e; });
    }
  } finally {
    c.release(defekt);
  }
}
