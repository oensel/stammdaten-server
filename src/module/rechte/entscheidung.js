// Reine Rechteentscheidung (AD-3, FR-24). Eine Quelle ist
//   { art: 'vereinsrolle'|'verbandsrolle'|'lizenz'|'direkt', schluessel, rechte: ['recht:OPERATION'], bereich, felder }
// bereich: { art: 'verein', id } oder { art: 'verband', id, ebene }; felder: null = alle Feldgruppen, sonst erlaubte Gruppen.
// Ein Ziel ist { global } oder { vereine: [id], verbaende: [id], vorfahren: { id: [verband_id] }, heimatverein_id, judopassdaten, eigen }.
import { BASISRECHTE, kennt } from './katalog.js';
import { scopeFuer } from './obergrenze.js';

// Nur der Landesverband des Heimatvereins (E79)
const NUR_LV = ['mitglieder:LOESCHEN', 'personen_zusammenfuehrung:AENDERN'];
// Der Heimatverein muss im Bereich liegen
const NUR_HEIMAT = ['judopass_antrag:LESEN', 'judopass_antrag:ANLEGEN', 'judopass_antrag:AENDERN'];
// Eigene Person und Personen mit Zugriff (FR-18), unabhängig vom Kontext
const EIGEN = ['mitglieder:LESEN', 'graduierung:LESEN'];
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

function erlaubtQuelle(q, recht, ziel) {
  if (!q.rechte.includes(recht)) return false;
  if (ziel.global) return q.bereich.ebene === 'dachverband';
  if (NUR_LV.includes(recht) || (recht === 'mitglieder:AENDERN' && ziel.judopassdaten)) {
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
  if (ctx.rechte.super_admin) return true;
  if (ziel.eigen && EIGEN.includes(recht)) return true;
  return ctx.rechte.quellen.some((q) => erlaubtQuelle(q, recht, ziel));
}

/**
 * Bereiche, in denen `recht` gilt, als Prädikat für Listen: { alle } oder { vereine, verbaende } (Verbände samt Teilbaum).
 * Muss dieselben Zeilen ergeben wie darf() je Zeile. Für Rechte, die am Heimatverein hängen, ist die Spalte der Heimatverein.
 */
export function listenbereich(ctx, recht, { judopassdaten = false } = {}) {
  if (!kennt(recht)) throw new Error(`Unbekanntes Recht: ${recht}`);
  const leer = { alle: false, vereine: [], verbaende: [] };
  if (!ctx.benutzer) return leer;
  if (BASISRECHTE.includes(recht)) return { ...leer, alle: true };
  if (scopeFehlt(ctx, recht)) return leer;
  if (ctx.rechte.super_admin) return { ...leer, alle: true };
  const nurLv = NUR_LV.includes(recht) || (recht === 'mitglieder:AENDERN' && judopassdaten);
  const b = ctx.rechte.quellen.filter((q) => q.rechte.includes(recht) && (!nurLv || q.bereich.ebene === 'landesverband')).map((q) => q.bereich);
  const ids = (art) => [...new Set(b.filter((x) => x.art === art).map((x) => x.id))];
  return { alle: false, vereine: ids('verein'), verbaende: ids('verband') };
}

// Feldgruppen je Datenart; was hier fehlt, wird nie ausgegeben (Positivliste)
const FELDER = {
  person: {
    stamm: ['id', 'vorname', 'nachname', 'geburtsdatum', 'geschlecht', 'nationalitaet', 'change_seq'],
    kontakt: ['strasse', 'plz', 'ort', 'email', 'telefon'],
  },
};
const LESERECHT = { person: 'mitglieder:LESEN' };

/** Feldprojektion (NFR-2): nur Felder, die mindestens eine Quelle für dieses Ziel freigibt; fehlend statt leer. */
export function projiziere(ctx, art, datensatz, ziel) {
  if (!Object.hasOwn(FELDER, art)) throw new Error(`Unbekannte Datenart: ${art}`);
  const recht = LESERECHT[art];
  if (!darf(ctx, recht, ziel)) return null;
  const gruppen = Object.keys(FELDER[art]);
  const alle = ctx.rechte.super_admin || ziel.eigen;
  const passend = alle ? [] : ctx.rechte.quellen.filter((q) => erlaubtQuelle(q, recht, ziel));
  const erlaubt = gruppen.filter((g) => alle || passend.some((q) => q.felder === null || q.felder.includes(g)));
  const namen = erlaubt.flatMap((g) => FELDER[art][g]);
  return Object.fromEntries(Object.entries(datensatz).filter(([k]) => namen.includes(k)));
}
