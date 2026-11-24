// Konformitätsprüfung (SYS-STAT-001, AD-1/AD-2). Arbeitet auf einer Map Pfad → Quelltext, damit Verstöße testbar sind.
import path from 'node:path';

/** Erlaubte Abhängigkeiten (Spine-Diagramm). `rechte` ist die unterste Schicht; Blattmodule darf jeder rufen. */
export const PFEILE = {
  zugang: ['rechte'], organisation: ['rechte'], personen: ['organisation', 'rechte'], rechte: [],
  lizenzen: ['rechte'], graduierung: ['rechte', 'finanzen'], finanzen: ['rechte'],
  lehrgaenge: ['rechte', 'finanzen', 'lizenzen', 'graduierung'], kalender: ['rechte', 'finanzen', 'lizenzen'],
  judopass: ['rechte', 'finanzen', 'lizenzen'], abgleich: ['personen', 'graduierung', 'lizenzen'],
  benachrichtigung: [], audit: [],
};
const BLATT = ['benachrichtigung', 'audit'];
const PIPELINE = ['zugang', 'rechte'];
const WORKER = ['finanzen', 'lehrgaenge', 'personen', 'lizenzen', 'benachrichtigung'];
// Tabellennamen, die auch Spaltennamen sind; für sie gilt nur die Prüfung an Tabellenpositionen
const MEHRDEUTIG = ['rechte'];
const GEMEINSAM = ['src/db.js', 'src/errors.js', 'src/passwords.js'] /* reine Technik */;

/** Zerlegt JS in Code (ohne Kommentare, Zeichenketten durch §n§ ersetzt) und die Zeichenketten. */
export function zerlege(quelle, texte = []) {
  let code = ''; let i = 0;
  const regexMoeglich = () => /(^|[=(,:[!&|?{};>\n]|\breturn)\s*$/.test(code.slice(-20));
  while (i < quelle.length) {
    const z = quelle[i];
    if (quelle.startsWith('//', i)) { while (i < quelle.length && quelle[i] !== '\n') i++; continue; }
    if (quelle.startsWith('/*', i)) { const e = quelle.indexOf('*/', i + 2); i = e < 0 ? quelle.length : e + 2; code += ' '; continue; }
    if (z === '/' && regexMoeglich()) {
      let klasse = false; i++;
      while (i < quelle.length && quelle[i] !== '\n' && (klasse || quelle[i] !== '/')) {
        if (quelle[i] === '\\') i++; else if (quelle[i] === '[') klasse = true; else if (quelle[i] === ']') klasse = false;
        i++;
      }
      i++; code += '0'; continue;
    }
    if (z === "'" || z === '"' || z === '`') {
      let t = ''; let innen = ''; i++;
      while (i < quelle.length && quelle[i] !== z) {
        if (quelle[i] === '\\') { t += quelle[i + 1] ?? ''; i += 2; continue; }
        if (z === '`' && quelle.startsWith('${', i)) {
          let tiefe = 1; const a = i + 2; i = a;
          while (i < quelle.length && tiefe) { if (quelle[i] === '{') tiefe++; if (quelle[i] === '}') tiefe--; i++; }
          innen += ` (${zerlege(quelle.slice(a, i - 1), texte).code})`;
          t += '${}'; continue;
        }
        t += quelle[i++];
      }
      i++; code += `§${texte.length}§${innen}`; texte.push(t); continue;
    }
    code += z; i++;
  }
  return { code, texte };
}

const SQL = /\bselect\b[\s\S]*\bfrom\b|^\s*select\s|\binsert\s+into\b|\bupdate\s+\S+[\s\S]*\bset\b|\bdelete\s+from\b|\btruncate\b|^\s*with\b[\s\S]*\bas\s*\(/i;
export const enthaeltSql = (quelle) => {
  const { code, texte } = zerlege(quelle);
  return texte.some((t) => SQL.test(t)) || /\bquery\b/.test(code.replace(/\b(?:req|request)\.query\b|(?<![.\w])query\.(?!call\b|apply\b|bind\b)\w+|\bquery\s*:|\{[^{}()=]*\bquery\b[^{}()=]*\}\s*\)\s*=>/g, '')) || texte.includes('query');
};

const importe = (quelle) => {
  const { code, texte } = zerlege(quelle);
  return [...code.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*§(\d+)§/g)].map((m) => texte[m[1]]);
};
const modulVon = (p) => /^src\/module\/([^/]+)\//.exec(p)?.[1] ?? null;

/** Tabellen, die ein SQL-Text anspricht: [{ name, schreibt }] (nur bekannte Namen). */
export function tabellenIn(sql, bekannt) {
  const s = sql.toLowerCase().replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/"/g, '').replace(/\bpublic\./g, '');
  const out = [];
  const merke = (name, schreibt) => { if (bekannt.has(name)) out.push({ name, schreibt }); };
  for (const m of s.matchAll(/\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|merge\s+into)\s+(?:only\s+)?([a-z_]\w*)/g)) merke(m[1], true);
  // "delete from x" zählt oben als Schreiben und hier zusätzlich als Lesen
  for (const m of s.matchAll(/\b(?:from|join|using)\s+(?:only\s+|lateral\s+)?\(?\s*([a-z_]\w*)/g)) merke(m[1], false);
  for (const m of s.matchAll(/\bfrom\s+((?:[a-z_]\w*(?:\s+(?:as\s+)?[a-z_]\w*)?\s*,\s*)+[a-z_]\w*)/g)) {
    for (const teil of m[1].split(',')) merke(teil.trim().split(/\s+/)[0], false);
  }
  return out;
}

/** Namen aller Tabellen und Views aus den SQL-Dateien. */
export const bekannteTabellen = (sqlTexte) => new Set(sqlTexte.flatMap((s) =>
  [...s.matchAll(/^\s*create (?:or replace )?(?:materialized )?(?:table|view)\s+(?:if not exists\s+)?(\w+)/gim)].map((m) => m[1].toLowerCase())));

/**
 * dateien: Map 'src/…' → Quelltext; eigentum: { modul: [tabellen] }; bekannt: Set aller Tabellennamen;
 * altdateien: Dateien außerhalb von module/ und pipeline/, die noch da sein dürfen. Liefert Verstöße { regel, datei, text }.
 */
export function pruefe({ dateien, eigentum, bekannt, altdateien = [] }) {
  const v = [];
  const melde = (regel, datei, text) => v.push({ regel, datei, text });
  const besitzer = {};
  for (const [modul, liste] of Object.entries(eigentum)) {
    for (const t of liste) {
      if (besitzer[t]) melde('eigentum', modul, `${t} gehört schon ${besitzer[t]}`);
      if (!bekannt.has(t)) melde('eigentum', modul, `${t} gibt es nicht`);
      besitzer[t] = modul;
    }
  }
  for (const [datei, quelle] of dateien) {
    const modul = modulVon(datei);
    const pipeline = datei.startsWith('src/pipeline/');
    const { code, texte } = zerlege(quelle);
    if (!modul && !pipeline && !altdateien.includes(datei)) melde('neue_datei', datei, 'außerhalb von module/ und pipeline/');
    if (modul && !(modul in PFEILE)) melde('unbekanntes_modul', datei, modul);

    const erlaubt = modul ? [...(PFEILE[modul] || []), ...(BLATT.includes(modul) ? [] : BLATT)]
      : pipeline ? PIPELINE : datei === 'src/worker.js' ? WORKER : datei === 'src/auth.js' ? [...PFEILE.zugang, ...BLATT] /* Altcode von zugang */ : datei === 'src/app.js' ? Object.keys(PFEILE) : [];
    const oeffentlich = datei === 'src/app.js' ? 'routen.js' : 'dienst.js';
    for (const imp of importe(quelle)) {
      if (!imp.startsWith('.')) {
        if (modul) melde('pfeil', datei, `Modul importiert das Paket ${imp}`);
        continue;
      }
      const ziel = path.posix.join(path.posix.dirname(datei), imp);
      const zm = modulVon(ziel);
      if (zm && zm !== modul) {
        if (!erlaubt.includes(zm)) melde('pfeil', datei, `${modul || datei} → ${zm} ist keine erlaubte Richtung`);
        else if (ziel !== `src/module/${zm}/${oeffentlich}`) melde('pfeil', datei, `${ziel} ist nicht öffentlich`);
        else if (datei.endsWith('/daten.js')) melde('pfeil', datei, 'daten.js ruft kein anderes Modul');
      } else if (modul && !zm && !GEMEINSAM.includes(ziel)) melde('pfeil', datei, `Modul importiert ${ziel}`);
    }
    if (modul && /\bimport\s*\((?!\s*§)/.test(code)) melde('pfeil', datei, 'dynamischer Import mit berechnetem Pfad');

    const istDaten = modul && datei === `src/module/${modul}/daten.js`;
    if ((modul || pipeline) && !istDaten && enthaeltSql(quelle)) melde('sql', datei, 'SQL außerhalb von daten.js');
    if (datei.startsWith('src/routes/') && texte.some((t) => t.startsWith('/v2')) && !(datei === 'src/routes/auth.js' && texte.filter((t) => t.startsWith('/v2')).join() === '/v2/auth/kontext-wechseln')) melde('v2_altroute', datei, '/v2 außerhalb der Pipeline');
    if (datei.startsWith('src/routes/') && enthaeltSql(quelle)) melde('sql_altroute', datei, 'SQL in Route');
    if (modul && /\bnew Date\s*(?:\(\s*\)|(?!\s*\())|\bDate\.now\b|(?<!new )\bDate\(|globalThis|performance\.now/.test(code)) melde('zeit', datei, 'fachliche Zeit nur aus ctx.jetzt');
    if (istDaten) {
      const verkettet = new Set([...code.matchAll(/§(\d+)§(?:\s*\([^)]*\))*\s*\+|\+\s*§(\d+)§/g)].map((m) => texte[m[1] ?? m[2]]));
      for (const t of texte) {
        if (/\bnow\(\)|\blocaltime(stamp)?\b|'now'|\bcurrent_(date|timestamp|time)\b|\b(clock|statement|transaction)_timestamp\b/i.test(t)) melde('zeit', datei, 'now() im SQL');
        if (/\b(from|join|into|update)\s+\$\{\}/i.test(t)) melde('fremde_tabelle', datei, 'dynamischer Tabellenname');
        if (SQL.test(t) && verkettet.has(t)) melde('fremde_tabelle', datei, 'SQL durch Verkettung zusammengesetzt');
        // Jeder bekannte Tabellenname als Wort, außer als Spalte (a.x) oder Alias (as x)
        if (SQL.test(t) || /^\s*table\s/i.test(t)) {
          for (const [, davor, wort] of t.toLowerCase().matchAll(/(\.\s*|\bas\s+|['\w]?)\b([a-z_]\w*)\b/g)) {
            if (davor || !bekannt.has(wort) || wort === 'verband_pfade' || MEHRDEUTIG.includes(wort)) continue;
            if (!(eigentum[modul] || []).includes(wort)) melde('fremde_tabelle', datei, wort);
          }
        }
        for (const { name, schreibt } of tabellenIn(t, bekannt)) {
          if (name === 'verband_pfade' && !schreibt) continue;
          if (!(eigentum[modul] || []).includes(name)) melde('fremde_tabelle', datei, name);
        }
      }
    }
  }
  for (const m of new Set([...dateien.keys()].map(modulVon).filter(Boolean))) if (!eigentum[m]) melde('eigentum', m, 'tabellen.js fehlt');
  return v;
}
