import pg from 'pg';

// date bleibt "YYYY-MM-DD" (sonst Zeitzonen-Verschiebung im JSON); bigint als String (Standard)
pg.types.setTypeParser(1082, (v) => v);
export const createPool = (url) => new pg.Pool({ connectionString: url, max: 10 });

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
