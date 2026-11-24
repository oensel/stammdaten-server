// SYS-STAT-001: Importgraph nur in Pfeilrichtung, kein SQL in Routen, keine Fremdtabelle in daten.js; Ausnahmen schrumpfen nur.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALT_SQL } from './konformitaet/altsql.js';
import { ALTDATEIEN, ROUTEN_MIT_SQL } from './konformitaet/ausnahmen.js';
import { bekannteTabellen, PFEILE, pruefe } from './konformitaet/pruefer.js';
import { URSPRUNG_DATEIEN, URSPRUNG_ROUTEN } from './konformitaet/ursprung.js';

const root = path.resolve(import.meta.dirname, '..');
async function ladeProjekt() {
  const dateien = new Map();
  for (const e of await readdir(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.[cm]?js$/.test(e.name)) continue;
    const voll = path.join(e.parentPath, e.name);
    dateien.set(path.relative(root, voll).replaceAll('\\', '/'), await readFile(voll, 'utf8'));
  }
  const eigentum = {};
  for (const p of dateien.keys()) {
    const m = /^src\/module\/([^/]+)\/tabellen\.js$/.exec(p);
    if (m) eigentum[m[1]] = (await import(pathToFileURL(path.join(root, p)).href)).tabellen;
  }
  const mig = path.join(root, 'db', 'migrations');
  const sql = [path.join(root, 'db', 'schema.sql'), ...(await readdir(mig)).map((f) => path.join(mig, f))];
  return { dateien, eigentum, bekannt: bekannteTabellen(await Promise.all(sql.map((f) => readFile(f, 'utf8')))) };
}

describe('Konformität des Projekts', () => {
  it('hat keine Verstöße außer den gelisteten Altrouten', async () => {
    const v = pruefe({ ...await ladeProjekt(), altdateien: ALTDATEIEN });
    expect(v.filter((x) => x.regel !== 'sql_altroute')).toEqual([]);
    // Gleichheit: neue Verstöße UND erledigte, aber noch gelistete Ausnahmen schlagen fehl
    expect(v.filter((x) => x.regel === 'sql_altroute').map((x) => x.datei).sort()).toEqual([...ROUTEN_MIT_SQL].sort());
  });

  it('Ausnahmelisten schrumpfen nur', () => {
    expect(ROUTEN_MIT_SQL.filter((x) => !URSPRUNG_ROUTEN.includes(x))).toEqual([]);
    expect(ALTDATEIEN.filter((x) => !URSPRUNG_DATEIEN.includes(x))).toEqual([]);
    expect(ALTDATEIEN.filter((x) => !existsSync(path.join(root, x)))).toEqual([]);
  });

  it('Altrouten bekommen kein neues SQL', async () => {
    const { dateien } = await ladeProjekt();
    const zuviel = [...dateien].filter(([d]) => d.startsWith('src/routes/')).filter(([d, s]) => (s.match(/\.query\(/g) || []).length > (ALT_SQL[d] ?? 0)).map(([d]) => d);
    expect(zuviel).toEqual([]);
  });

  it('die erlaubten Abhängigkeiten haben keinen Zyklus', () => {
    const besuche = (m, weg) => {
      expect(weg).not.toContain(m);
      for (const z of PFEILE[m]) besuche(z, [...weg, m]);
    };
    for (const m of Object.keys(PFEILE)) besuche(m, []);
  });
});

describe('Der Prüfer erkennt Verstöße', () => {
  const bekannt = new Set(['personen', 'forderungen', 'verband_pfade', 'rechte']);
  const eigentum = { personen: ['personen'], finanzen: ['forderungen'], rechte: ['rechte'], audit: [] };
  const regeln = (datei, quelle) => pruefe({ dateien: new Map([[datei, quelle]]), eigentum, bekannt }).map((x) => x.regel);
  const P = 'src/module/personen/';

  it.each([
    ['gegen die Pfeilrichtung', 'src/module/finanzen/dienst.js', `import { a } from '../personen/dienst.js';`, 'pfeil'],
    ['als dynamischer Import', 'src/module/finanzen/dienst.js', `const a = await import('../personen/dienst.js');`, 'pfeil'],
    ['als Re-Export', 'src/module/finanzen/dienst.js', `export * from "../personen/dienst.js";`, 'pfeil'],
    ['Import mit berechnetem Pfad', `${P}dienst.js`, 'await import(p);', 'pfeil'],
    ['Blattmodul ruft Modul', 'src/module/audit/dienst.js', `import '../rechte/dienst.js';`, 'pfeil'],
    ['nicht öffentliche Datei', `${P}dienst.js`, `import '../rechte/daten.js';`, 'pfeil'],
    ['Modul importiert Altcode', `${P}dienst.js`, `import '../../auth.js';`, 'pfeil'],
    ['Altroute importiert Modul', 'src/routes/x.js', `import '../module/personen/dienst.js';`, 'pfeil'],
    ['SQL in Route', `${P}routen.js`, 'const s = `select 1 from personen`;', 'sql'],
    ['query() in Route', `${P}routen.js`, 'db.query(q)', 'sql'],
    ['SQL in Altroute', 'src/routes/x.js', `p.query('delete from personen')`, 'sql_altroute'],
    ["query über Klammern", `${P}routen.js`, `db['query'](q)`, 'sql'],
    ['query zerlegt', `${P}dienst.js`, 'const { query } = db; query(q)', 'sql'],
    ['query.call', `${P}dienst.js`, 'db.query.call(db, q)', 'sql'],
    ['eigener Datenbankzugang', `${P}dienst.js`, `import pg from 'pg';`, 'pfeil'],
    ['createRequire', `${P}dienst.js`, `import { createRequire } from 'node:module';`, 'pfeil'],
    ['Date()', `${P}dienst.js`, 'const d = Date();', 'zeit'],
    ['localtimestamp', `${P}daten.js`, `'update personen set a = localtimestamp'`, 'zeit'],
    ['Komma nach Join', `${P}daten.js`, '`select * from personen p join personen q on true, forderungen f`', 'fremde_tabelle'],
    ['Komma nach lateral', `${P}daten.js`, '`select * from personen p, lateral (select 1) x, forderungen f`', 'fremde_tabelle'],
    ['table-Befehl', `${P}daten.js`, `'table forderungen'`, 'fremde_tabelle'],
    ['verkettetes SQL', `${P}daten.js`, `'select * from ' + t`, 'fremde_tabelle'],
    ['/v2 in Altroute', 'src/routes/x.js', `app.get('/v2/neu', h)`, 'v2_altroute'],
    ['fremde Tabelle per Join', `${P}daten.js`, '`select * from personen p join forderungen f on true`', 'fremde_tabelle'],
    ['fremde Tabelle per Kommaliste', `${P}daten.js`, '`select * from personen p, forderungen f`', 'fremde_tabelle'],
    ['fremde Tabelle schreibend', `${P}daten.js`, `'insert into forderungen (a) values (1)'`, 'fremde_tabelle'],
    ['verband_pfade schreibend', `${P}daten.js`, `'delete from verband_pfade'`, 'fremde_tabelle'],
    ['dynamischer Tabellenname', `${P}daten.js`, '`select * from ${t}`', 'fremde_tabelle'],
    ['new Date() im Dienst', `${P}dienst.js`, 'const d = new Date();', 'zeit'],
    ['now() im SQL', `${P}daten.js`, `'update personen set a = now()'`, 'zeit'],
    ['neue Datei im Altbestand', 'src/neu.js', '', 'neue_datei'],
    ['unbekanntes Modul', 'src/module/foo/dienst.js', '', 'unbekanntes_modul'],
  ])('%s', (_name, datei, quelle, regel) => { expect(regeln(datei, quelle)).toContain(regel); });

  it('lässt Erlaubtes durch', () => {
    expect(regeln(`${P}dienst.js`, `import { darf } from '../rechte/dienst.js';\nimport { schreiben } from '../audit/dienst.js';\n// select x from forderungen\nconst d = new Date(ctx.jetzt);`)).toEqual([]);
    expect(regeln(`${P}daten.js`, 'db.query(`select rechte from personen p join verband_pfade v on v.id = p.id for update`)')).toEqual([]);
  });

  it('meldet doppeltes und fehlendes Tabelleneigentum', () => {
    expect(pruefe({ dateien: new Map(), eigentum: { personen: ['personen'], rechte: ['personen'] }, bekannt }).map((x) => x.regel)).toEqual(['eigentum']);
    expect(pruefe({ dateien: new Map([['src/module/kalender/dienst.js', '']]), eigentum, bekannt }).map((x) => x.regel)).toEqual(['eigentum']);
  });
});
