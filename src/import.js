// Mitglieder-Import aus dem DJB-Portal-Export (CSV mit „;“ oder xlsx, Blatt „Members“, gleiche Spalten).
// Übernommen werden Mitglieder, Graduierungen (Spalten „n. Kyu/Dan … Nr./Datum“) und Lizenzen. Bewusst NICHT übernommen
// (gehören dem Abrechnungs-Tool bzw. werden zentral nicht gebraucht): Kontoinhaber, IBAN, Abbuchungsintervall, Anmelde-Datum,
// Beitragsart, Bemerkung, führender Verein, Erste-Hilfe-Datum und -Scan, Führungszeugnis-Scan, Passfoto.
// Gemeinsamer Schlüssel zum Abrechnungs-Tool ist die DJB-ID (mitglieder.djb_id).
import readXlsx from 'read-excel-file/node';
import { badRequest } from './errors.js';

/* ---------- Einlesen ---------- */

/** CSV (Trenner „;“, Anführungszeichen mit "" als Escape, Zeilenumbrüche in Feldern erlaubt) → Array von Zeilen. */
export function parseCsv(text) {
  const t = text.replace(/^﻿/, '');
  const zeilen = []; let zeile = []; let feld = ''; let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"') { if (t[i + 1] === '"') { feld += '"'; i++; } else inQ = false; } else feld += c;
    } else if (c === '"') inQ = true;
    else if (c === ';') { zeile.push(feld); feld = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      zeile.push(feld); feld = '';
      zeilen.push(zeile); zeile = [];
    } else feld += c;
  }
  if (feld !== '' || zeile.length) { zeile.push(feld); zeilen.push(zeile); }
  return zeilen;
}

export async function parseXlsx(buffer) {
  let blaetter;
  try { blaetter = await readXlsx(buffer); } catch { throw badRequest('Die Datei ist keine gültige xlsx-Datei', 'datei_ungueltig'); }
  // je nach Version: Array von Zeilen oder [{ sheet, data }]
  if (blaetter.length && !Array.isArray(blaetter[0])) {
    const b = blaetter.find((x) => x.sheet === 'Members') || blaetter[0];
    return b.data;
  }
  return blaetter;
}

/** Zeilen (erste = Kopf) → Objekte mit Kopfnamen. Leere Zeilen entfallen; `zeile` = Zeilennummer in der Datei (1 = Kopf). */
export function alsObjekte(zeilen) {
  if (!zeilen.length) throw badRequest('Die Datei ist leer', 'datei_leer');
  const kopf = zeilen[0].map((k) => String(k ?? '').trim());
  if (!kopf.includes('Nachname') || !kopf.includes('Vorname')) {
    throw badRequest('Das ist kein DJB-Mitgliederexport (Spalten „Nachname“ und „Vorname“ fehlen)', 'datei_ungueltig');
  }
  const out = [];
  zeilen.slice(1).forEach((z, i) => {
    if (z.every((c) => c === null || c === undefined || String(c).trim() === '')) return;
    const o = { _zeile: i + 2 };
    kopf.forEach((k, j) => { if (k) o[k] = z[j] ?? null; });
    out.push(o);
  });
  return { kopf, zeilen: out };
}

/* ---------- Umwandeln ---------- */

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

function datum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  let [j, mo, d] = m ? [m[1], m[2], m[3]] : [];
  if (!m && (m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) [d, mo, j] = [m[1].padStart(2, '0'), m[2].padStart(2, '0'), m[3]];
  if (!j) return undefined;
  const t = new Date(Date.UTC(+j, +mo - 1, +d));
  return t.getUTCFullYear() === +j && t.getUTCMonth() === +mo - 1 && t.getUTCDate() === +d ? `${j}-${mo}-${d}` : undefined;
}

const GESCHLECHT = { maennlich: 'm', männlich: 'm', m: 'm', weiblich: 'w', w: 'w', divers: 'd', d: 'd' };
const LAENDER = {
  deutschland: 'DE', deutsch: 'DE', d: 'DE', oesterreich: 'AT', österreich: 'AT', schweiz: 'CH', ukraine: 'UA', украина: 'UA',
  niederlande: 'NL', polen: 'PL', frankreich: 'FR', italien: 'IT', tuerkei: 'TR', türkei: 'TR',
};

const LIZENZEN = [
  { spalte: 'eFZ Prüfer', art: 'efz_pruefer', bezeichnung: 'eFZ Prüfer' },
  { spalte: 'Ehrenkodex des Deutschen Judo-Bund e.V.', art: 'ehrenkodex', bezeichnung: 'Ehrenkodex DJB' },
  { spalte: 'Erweitertes Führungszeugnis', art: 'sonstige', bezeichnung: 'Erweitertes Führungszeugnis' },
  { spalte: 'Graduierungslizenz - NW', art: 'graduierungslizenz', bezeichnung: 'Graduierungslizenz – NW' },
  { spalte: 'Judopass', art: 'judopass', bezeichnung: null },
  { spalte: 'Wettkampflizenz', art: 'wettkampflizenz', bezeichnung: null },
];
const GRAD_RE = /^(\d+)\. (Kyu|Dan)(?: - .+?)? (Nr\.|Datum)$/;

/** Eine Zeile → { mitglied, graduierungen, lizenzen, warnungen } oder { fehler, warnungen }. */
export function wandleZeile(o, kopf) {
  const warnungen = []; const fehler = [];
  const vorname = text(o.Vorname); const nachname = text(o.Nachname);
  if (!vorname || !nachname) fehler.push('Vor- oder Nachname fehlt');
  const geb = datum(o.Geburtsdatum);
  if (geb === undefined) fehler.push(`Geburtsdatum nicht lesbar: „${o.Geburtsdatum}“`);
  const g = text(o.Geschlecht);
  const geschlecht = g ? GESCHLECHT[g.toLowerCase()] : null;
  if (g && !geschlecht) warnungen.push(`Geschlecht „${g}“ unbekannt`);

  const landRoh = text(o.Land);
  let land = null;
  if (landRoh) {
    land = /^[A-Za-z]{2}$/.test(landRoh) ? landRoh.toUpperCase() : LAENDER[landRoh.toLowerCase()] || null;
    if (!land) warnungen.push(`Land „${landRoh}“ unbekannt – DE angenommen`);
  }
  let plz = text(o.PLZ);
  if (plz && /^\d{4}$/.test(plz) && (!land || land === 'DE')) plz = plz.padStart(5, '0'); // xlsx verliert führende Nullen
  const mail = text(o.Email)?.toLowerCase() || null;
  if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) warnungen.push(`E-Mail-Adresse „${mail}“ ungültig – nicht übernommen`);

  const mitglied = {
    djb_id: text(o.ID), vorname, nachname, geburtsdatum: geb, geschlecht, nationalitaet: text(o.Nationalität),
    strasse: text(o['Straße']), plz, ort: text(o.Ort), land, email: mail && !warnungen.some((w) => w.startsWith('E-Mail')) ? mail : null,
    telefon: text(o.Telefon),
  };

  const grad = new Map();
  for (const k of kopf) {
    const m = GRAD_RE.exec(k);
    if (!m) continue;
    const art = m[1] && m[2] === 'Kyu' ? 'kyu' : 'dan'; const stufe = +m[1];
    if (!(art === 'kyu' ? stufe >= 1 && stufe <= 9 : stufe >= 1 && stufe <= 10)) continue;
    const key = `${art}${stufe}`;
    const e = grad.get(key) || { art, stufe, urkunden_nr: null, datum: null };
    if (m[3] === 'Nr.') e.urkunden_nr = text(o[k]);
    else {
      const d = datum(o[k]);
      if (d === undefined) warnungen.push(`${stufe}. ${m[2]}: Datum nicht lesbar`); else e.datum = d;
    }
    grad.set(key, e);
  }
  const graduierungen = [...grad.values()].filter((e) => e.urkunden_nr || e.datum);

  const lizenzen = [];
  for (const l of LIZENZEN) {
    const nummer = text(o[`${l.spalte} Nr.`]); const bis = datum(o[`${l.spalte} gültig bis`]);
    if (bis === undefined) warnungen.push(`${l.spalte}: Gültigkeit nicht lesbar`);
    if (nummer || bis) lizenzen.push({ art: l.art, bezeichnung: l.bezeichnung, nummer, gueltig_bis: bis || null, ausgestellt_am: null });
  }
  if (fehler.length) return { fehler, warnungen };
  return { mitglied, graduierungen, lizenzen, warnungen };
}

/* ---------- Schreiben ---------- */

/**
 * Importiert in einen Verein (innerhalb der Transaktion des Aufrufers). Vorhandene Mitglieder werden über die DJB-ID erkannt und
 * nur mit nicht-leeren Werten aktualisiert (nichts wird geleert). Liefert den Bericht.
 */
export async function importiere(db, vereinId, { kopf, zeilen }, benutzerId) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`import:${vereinId}`]);
  const bericht = {
    zeilen: zeilen.length,
    mitglieder: { neu: 0, aktualisiert: 0, fehler: 0 }, graduierungen: 0, lizenzen: 0,
    fehler: [], warnungen: [],
  };
  let nr = (await db.query('select coalesce(max(mitgliedsnr), 0) as n from mitglieder where verein_id = $1', [vereinId])).rows[0].n;
  const gesehen = new Set();
  for (const o of zeilen) {
    const r = wandleZeile(o, kopf);
    for (const w of r.warnungen) bericht.warnungen.push({ zeile: o._zeile, meldung: w });
    if (r.fehler) { bericht.mitglieder.fehler++; for (const f of r.fehler) bericht.fehler.push({ zeile: o._zeile, meldung: f }); continue; }
    const m = r.mitglied;
    if (m.djb_id) {
      if (gesehen.has(m.djb_id)) { bericht.mitglieder.fehler++; bericht.fehler.push({ zeile: o._zeile, meldung: `ID ${m.djb_id} kommt mehrfach in der Datei vor` }); continue; }
      gesehen.add(m.djb_id);
    }
    const vorhanden = m.djb_id
      ? (await db.query('select id from mitglieder where verein_id = $1 and djb_id = $2 and geloescht_am is null', [vereinId, m.djb_id])).rows[0]
      : null;
    let mitgliedId;
    if (vorhanden) {
      mitgliedId = vorhanden.id;
      await db.query(
        `update mitglieder set vorname = $2, nachname = $3, geburtsdatum = coalesce($4, geburtsdatum), geschlecht = coalesce($5, geschlecht),
            nationalitaet = coalesce($6, nationalitaet), strasse = coalesce($7, strasse), plz = coalesce($8, plz), ort = coalesce($9, ort),
            land = coalesce($10, land), email = coalesce($11, email), telefon = coalesce($12, telefon), geaendert_am = now(), geaendert_von = $13
          where id = $1`,
        [mitgliedId, m.vorname, m.nachname, m.geburtsdatum, m.geschlecht, m.nationalitaet, m.strasse, m.plz, m.ort, m.land, m.email, m.telefon, benutzerId]);
      bericht.mitglieder.aktualisiert++;
    } else {
      nr += 1;
      mitgliedId = (await db.query(
        `insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname, geburtsdatum, geschlecht, nationalitaet, strasse, plz, ort, land, email,
                                 telefon, djb_id, geaendert_von)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11,'DE'),$12,$13,$14,$15) returning id`,
        [vereinId, nr, m.vorname, m.nachname, m.geburtsdatum, m.geschlecht, m.nationalitaet, m.strasse, m.plz, m.ort, m.land, m.email, m.telefon,
          m.djb_id, benutzerId])).rows[0].id;
      bericht.mitglieder.neu++;
    }
    for (const gr of r.graduierungen) {
      await db.query(
        `insert into graduierungen (verein_id, mitglied_id, art, stufe, datum, urkunden_nr, quelle, geaendert_von)
         values ($1,$2,$3,$4,$5,$6,'import',$7)
         on conflict (mitglied_id, art, stufe) do update set datum = coalesce(excluded.datum, graduierungen.datum),
           urkunden_nr = coalesce(excluded.urkunden_nr, graduierungen.urkunden_nr), geloescht_am = null, geaendert_am = now(), geaendert_von = excluded.geaendert_von`,
        [vereinId, mitgliedId, gr.art, gr.stufe, gr.datum, gr.urkunden_nr, benutzerId]);
      bericht.graduierungen++;
    }
    for (const l of r.lizenzen) {
      const alt = (await db.query(
        `select id from lizenzen where mitglied_id = $1 and art = $2 and coalesce(bezeichnung, '') = coalesce($3, '') and geloescht_am is null`,
        [mitgliedId, l.art, l.bezeichnung])).rows[0];
      if (alt) {
        await db.query(
          `update lizenzen set nummer = coalesce($2, nummer), gueltig_bis = coalesce($3, gueltig_bis), ausgestellt_am = coalesce($4, ausgestellt_am),
              geaendert_am = now(), geaendert_von = $5 where id = $1`,
          [alt.id, l.nummer, l.gueltig_bis, l.ausgestellt_am, benutzerId]);
      } else {
        await db.query(
          `insert into lizenzen (verein_id, mitglied_id, art, bezeichnung, nummer, gueltig_bis, ausgestellt_am, geaendert_von)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [vereinId, mitgliedId, l.art, l.bezeichnung, l.nummer, l.gueltig_bis, l.ausgestellt_am, benutzerId]);
      }
      bericht.lizenzen++;
    }
  }
  return bericht;
}
