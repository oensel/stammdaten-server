// Scopes aus Rolle und Rechten (datenbankentwurf.md 2.4 / api-entwurf.md 3) – nicht gespeichert, sondern hier festgelegt.
export const ALLE_SCOPES = [
  'mitglieder:selbst', 'mitglieder:lesen', 'mitglieder:person', 'mitglieder:mitgliedschaft', 'mitglieder:kontakt', 'mitglieder:tarif',
  'mitglieder:verwaltung', 'mitglieder:ausgetretene', 'mitglieder:schreiben', 'graduierungen:lesen', 'graduierungen:schreiben',
  'lizenzen:judopass', 'lizenzen:lesen', 'lizenzen:schreiben', 'mitglieder:efz', 'vereine:lesen', 'vereine:kontakt', 'vereine:finanzen',
  'vereine:schreiben', 'gruppen:lesen', 'gruppen:schreiben',
  'benutzer:verwalten', 'benutzer:schueler', 'rechte:verwalten', 'mitglieder:import', 'mitglieder:eintritt',
];

const MITGLIED = ['mitglieder:selbst', 'vereine:lesen', 'gruppen:lesen'];
const RECHTE = {
  trainer: ['mitglieder:lesen', 'mitglieder:person', 'mitglieder:mitgliedschaft', 'mitglieder:kontakt', 'mitglieder:schreiben', 'graduierungen:lesen',
    'lizenzen:judopass', 'lizenzen:lesen', 'vereine:kontakt', 'gruppen:schreiben', 'benutzer:schueler'],
  pruefer: ['mitglieder:lesen', 'mitglieder:person', 'graduierungen:lesen', 'graduierungen:schreiben', 'lizenzen:judopass', 'lizenzen:lesen', 'vereine:kontakt'],
  kassierer: ['mitglieder:lesen', 'mitglieder:person', 'mitglieder:mitgliedschaft', 'mitglieder:kontakt', 'mitglieder:tarif', 'mitglieder:ausgetretene', 'mitglieder:eintritt',
    'vereine:kontakt', 'vereine:finanzen'],
  kassenpruefer: ['mitglieder:lesen', 'mitglieder:person', 'mitglieder:mitgliedschaft', 'mitglieder:tarif', 'mitglieder:ausgetretene',
    'vereine:kontakt', 'vereine:finanzen'],
};

/** Benutzer-Scopes (vor Schnittmenge mit der App-Obergrenze). */
export function benutzerScopes({ rolle, rechte = [], superAdmin = false }) {
  if (superAdmin || rolle === 'admin') return [...ALLE_SCOPES];
  const s = new Set(MITGLIED);
  for (const r of rechte) for (const x of RECHTE[r] || []) s.add(x);
  return [...s];
}

/** Wirksame Scopes = Benutzer-Scopes ∩ Obergrenze der App (anwendungen.scopes). */
export const wirksameScopes = (benutzer, obergrenze) => {
  const b = benutzerScopes(benutzer);
  return obergrenze ? b.filter((x) => obergrenze.includes(x)) : b;
};
