// Datenfilter (FR-23), reine Prüfung. Fehlende Angaben am Ziel erfüllen einen gesetzten Filter nie.

/** Gürtelrang: 9. Kyu = 1 … 1. Kyu = 9, 1. Dan = 10 … 10. Dan = 19; null bei ungültigem Grad. */
export function gradRang(grad) {
  if (!grad || !Number.isInteger(grad.stufe) || grad.stufe < 1) return null;
  if (grad.art === 'kyu') return grad.stufe <= 9 ? 10 - grad.stufe : null;
  return grad.art === 'dan' && grad.stufe <= 10 ? 9 + grad.stufe : null;
}

const zwischen = (x, min, max) => Number.isInteger(x) && (min == null || x >= min) && (max == null || x <= max);

/** ziel.person = { aktiv, rang, lizenzen: [schluessel] } */
export function subjektErfuellt(f, person) {
  const beschraenkt = f.nur_aktive || f.subjekt_min_rang != null || f.subjekt_max_rang != null || f.subjekt_lizenz != null;
  if (!beschraenkt) return true;
  if (!person) return false;
  if (f.nur_aktive && person.aktiv !== true) return false;
  if ((f.subjekt_min_rang != null || f.subjekt_max_rang != null) && !zwischen(person.rang, f.subjekt_min_rang, f.subjekt_max_rang)) return false;
  return f.subjekt_lizenz == null || (person.lizenzen ?? []).includes(f.subjekt_lizenz);
}

/** Alle berührten Grade (beim Ändern alter und neuer) müssen erlaubt sein; gilt nicht fürs Lesen. */
export function wertErfuellt(f, werte, eigenerRang) {
  const beschraenkt = f.wert_art != null || f.wert_min_rang != null || f.wert_max_rang != null || f.wert_bis_eigener_grad;
  if (!beschraenkt) return true;
  if (!werte?.length) return false;
  return werte.every((g) => {
    const rang = gradRang(g);
    return rang !== null && (f.wert_art == null || g.art === f.wert_art) && zwischen(rang, f.wert_min_rang, f.wert_max_rang)
      && (!f.wert_bis_eigener_grad || (Number.isInteger(eigenerRang) && rang <= eigenerRang));
  });
}

/** Feldgruppen je Person; Filter nennen Gruppen oder einzelne Felder. */
export const PERSON_FELDER = {
  stamm: ['id', 'vorname', 'nachname', 'geburtsdatum', 'geschlecht', 'nationalitaet', 'change_seq'],
  kontakt: ['strasse', 'plz', 'ort', 'land', 'email', 'telefon'],
};
const einzeln = (felder) => new Set(felder.flatMap((f) => (Object.hasOwn(PERSON_FELDER, f) ? PERSON_FELDER[f] : [f])));

/**
 * Ist der Filter `neu` höchstens so weit wie der des Gebers (Delegation, FR-22)? null = unbeschränkt.
 * Hat der Geber einen Filter, braucht die Delegation einen; Spannen und Felder müssen innerhalb liegen, nur_aktive darf nicht fallen.
 */
export function filterEngerOderGleich(neu, geber) {
  if (!geber) return true;
  if (!neu) return false;
  if (geber.nur_aktive && !neu.nur_aktive) return false;
  const spanne = (f, [min, max]) => [f[min] ?? 1, f[max] ?? 19];
  for (const [min, max] of [['subjekt_min_rang', 'subjekt_max_rang'], ['wert_min_rang', 'wert_max_rang']]) {
    const [a1, a2] = spanne(neu, [min, max]); const [b1, b2] = spanne(geber, [min, max]);
    if (a1 < b1 || a2 > b2) return false;
  }
  if (geber.wert_art != null && neu.wert_art !== geber.wert_art) return false;
  if (geber.subjekt_lizenz != null && neu.subjekt_lizenz !== geber.subjekt_lizenz) return false;
  if (geber.wert_bis_eigener_grad && !neu.wert_bis_eigener_grad) return false;
  if (geber.felder != null) {
    if (neu.felder == null) return false;
    const erlaubt = einzeln(geber.felder);
    if (![...einzeln(neu.felder)].every((f) => erlaubt.has(f))) return false;
  }
  return true;
}
