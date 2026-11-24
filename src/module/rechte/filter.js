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
