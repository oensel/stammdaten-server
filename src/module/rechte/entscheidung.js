// Reine Rechteentscheidung (AD-3, FR-24). Eine Quelle ist
//   { art: 'vereinsrolle'|'verbandsrolle'|'lizenz'|'direkt', schluessel, rechte: ['recht:OPERATION'], bereich, filter: { recht: datenfilter } }
// bereich: { art: 'verein', id } oder { art: 'verband', id, ebene }.
// Ein Ziel ist { global } oder { vereine: [id], verbaende: [id], vorfahren: { id: [verband_id] }, heimatverein_id, judopassdaten, eigen,
//   person: { aktiv, rang, lizenzen }, werte: [{ art, stufe }] }.
import { BASISRECHTE, kennt } from './katalog.js';
import { subjektErfuellt, wertErfuellt } from './filter.js';
import { scopeFuer } from './obergrenze.js';

// Nur der Landesverband des Heimatvereins (E79), auch nicht der Super-Admin (Nutzerentscheid 2026-11-24)
const NUR_LV = ['mitglieder:LOESCHEN', 'personen_zusammenfuehrung:AENDERN'];
// Der Heimatverein muss im Bereich liegen
const NUR_HEIMAT = ['judopass_antrag:LESEN', 'judopass_antrag:ANLEGEN', 'judopass_antrag:AENDERN'];
// Eigene Person und Personen mit Zugriff (FR-18), unabhängig vom Kontext
const EIGEN = ['mitglieder:LESEN', 'graduierung:LESEN'];
const nurLv = (recht, judopassdaten) => NUR_LV.includes(recht) || (recht === 'mitglieder:AENDERN' && !!judopassdaten);

/** Schränkt eine Quelle auf den aktiven Kontext ein (FR-15, E104); null = wirkt dort nicht. `vorfahren`: Verbände über dem Kontextverein. */
export function imKontext(quelle, kontext, vorfahren = []) {
  if (!kontext) return null;
  const { bereich } = quelle;
  if (kontext.art === 'verband') return bereich.art === 'verband' && bereich.id === kontext.id ? quelle : null;
  if (bereich.art === 'verein') return bereich.id === kontext.id ? quelle : null;
  // Im Verein wirken aus Verbandsbereichen nur Lizenzen, und nur für diesen Verein
  return quelle.art === 'lizenz' && vorfahren.includes(bereich.id) ? { ...quelle, bereich: { art: 'verein', id: kontext.id } } : null;
}

const deckt = (bereich, id, ziel) => (bereich.art === 'verein' ? bereich.id === id : (ziel.vorfahren?.[id] ?? []).includes(bereich.id));

function erlaubtQuelle(ctx, q, recht, ziel) {
  if (!q.rechte.includes(recht)) return false;
  const f = q.filter?.[recht];
  if (f && !(subjektErfuellt(f, ziel.person) && (recht.endsWith(':LESEN') || wertErfuellt(f, ziel.werte, ctx.rechte.eigener_rang)))) return false;
  if (ziel.global) return q.bereich.ebene === 'dachverband';
  if (nurLv(recht, ziel.judopassdaten)) {
    return q.bereich.ebene === 'landesverband' && !!ziel.heimatverein_id && deckt(q.bereich, ziel.heimatverein_id, ziel);
  }
  if (NUR_HEIMAT.includes(recht)) return !!ziel.heimatverein_id && deckt(q.bereich, ziel.heimatverein_id, ziel);
  return [...(ziel.vereine ?? []), ...(ziel.verbaende ?? [])].some((id) => deckt(q.bereich, id, ziel));
}

// App-Obergrenze: gilt für alle, auch Super-Admins, in jedem Kontext
const scopeFehlt = (ctx, recht) => !ctx.rechte.app_scopes.includes(scopeFuer(recht));

/** Einzige Rechteentscheidung: ODER über Quellen, UND innerhalb einer Quelle. Ohne Ziel gibt es nur Basisrechte. */
export function darf(ctx, recht, ziel = {}) {
  if (!kennt(recht)) throw new Error(`Unbekanntes Recht: ${recht}`);
  if (!ctx.benutzer) return false;
  if (BASISRECHTE.includes(recht)) return true;
  if (scopeFehlt(ctx, recht)) return false;
  if (ctx.rechte.super_admin && !nurLv(recht, ziel.judopassdaten)) return true;
  if (ziel.eigen && EIGEN.includes(recht)) return true;
  return ctx.rechte.quellen.some((q) => erlaubtQuelle(ctx, q, recht, ziel));
}

/**
 * Bereiche, in denen `recht` gilt, als Prädikat für Listen: { alle } oder { vereine, verbaende } (Verbände samt Teilbaum).
 * `gefiltert`: Quellen mit Subjektfilter als { bereich, filter }; jede ist für sich mit ihrem Filter abzufragen.
 * Muss dieselben Zeilen ergeben wie darf() je Zeile. Für Rechte, die am Heimatverein hängen, ist die Spalte der Heimatverein.
 */
export function listenbereich(ctx, recht, { judopassdaten = false } = {}) {
  if (!kennt(recht)) throw new Error(`Unbekanntes Recht: ${recht}`);
  const leer = { alle: false, vereine: [], verbaende: [], gefiltert: [] };
  if (!ctx.benutzer) return leer;
  if (BASISRECHTE.includes(recht)) return { ...leer, alle: true };
  if (scopeFehlt(ctx, recht)) return leer;
  const lv = nurLv(recht, judopassdaten);
  if (ctx.rechte.super_admin && !lv) return { ...leer, alle: true };
  const passend = ctx.rechte.quellen.filter((q) => q.rechte.includes(recht) && (!lv || q.bereich.ebene === 'landesverband'));
  const frei = (q) => !q.filter?.[recht] || subjektErfuellt(q.filter[recht], null);
  const b = passend.filter(frei).map((q) => q.bereich);
  const ids = (art) => [...new Set(b.filter((x) => x.art === art).map((x) => x.id))];
  return { alle: false, vereine: ids('verein'), verbaende: ids('verband'), gefiltert: passend.filter((q) => !frei(q)).map((q) => ({ bereich: q.bereich, filter: q.filter[recht] })) };
}

// Feldgruppen je Datenart; was hier fehlt, wird nie ausgegeben (Positivliste)
const FELDER = {
  person: {
    stamm: ['id', 'vorname', 'nachname', 'geburtsdatum', 'geschlecht', 'nationalitaet', 'change_seq'],
    kontakt: ['strasse', 'plz', 'ort', 'email', 'telefon'],
  },
};
const LESERECHT = { person: 'mitglieder:LESEN' };

/** Felder, die eine Quelle für ein Recht freigibt. Verbandsrollen sehen nie Kontaktdaten (E10). */
function felderVon(q, recht, art) {
  const gruppen = FELDER[art];
  const erlaubt = q.filter?.[recht]?.felder ?? Object.keys(gruppen);
  const namen = erlaubt.flatMap((f) => (Object.hasOwn(gruppen, f) ? gruppen[f] : Object.values(gruppen).some((g) => g.includes(f)) ? [f] : []));
  return q.art === 'verbandsrolle' ? namen.filter((n) => !(gruppen.kontakt ?? []).includes(n)) : namen;
}

const verlangeArt = (art) => { if (!Object.hasOwn(FELDER, art)) throw new Error(`Unbekannte Datenart: ${art}`); };

/** Feldprojektion (NFR-2): nur Felder, die mindestens eine Quelle für dieses Ziel freigibt; fehlend statt leer. */
export function projiziere(ctx, art, datensatz, ziel) {
  verlangeArt(art);
  const recht = LESERECHT[art];
  if (!darf(ctx, recht, ziel)) return null;
  const namen = ctx.rechte.super_admin || ziel.eigen
    ? Object.values(FELDER[art]).flat()
    : ctx.rechte.quellen.filter((q) => erlaubtQuelle(ctx, q, recht, ziel)).flatMap((q) => felderVon(q, recht, art));
  return Object.fromEntries(Object.entries(datensatz).filter(([k]) => namen.includes(k)));
}

/** Schreiben: eine einzige Quelle muss Ziel und alle genannten Felder erlauben (Filter werden nicht kombiniert). */
export function darfFelder(ctx, recht, art, namen, ziel) {
  verlangeArt(art);
  if (!darf(ctx, recht, ziel)) return false;
  const alle = Object.values(FELDER[art]).flat();
  if (!namen.every((n) => alle.includes(n))) return false;
  if (ctx.rechte.super_admin && !nurLv(recht, ziel.judopassdaten)) return true;
  return ctx.rechte.quellen.some((q) => erlaubtQuelle(ctx, q, recht, ziel) && namen.every((n) => felderVon(q, recht, art).includes(n)));
}
