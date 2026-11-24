// Rechte und ihre Operationen; muss mit rechte_operationen übereinstimmen (Test).
export const KATALOG = Object.freeze({
  mitglieder: ['LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN', 'DELEGIEREN'],
  personen: ['SUCHEN'],
  personen_zusammenfuehrung: ['AENDERN'],
  graduierung: ['LESEN', 'DELEGIEREN'],
  pruefung: ['LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN', 'DELEGIEREN'],
  pruefung_abnahme: ['AENDERN'],
  pruefung_abschluss: ['AENDERN'],
  vereine: ['LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN'],
  verbandsbaum: ['LESEN', 'AENDERN'],
  fristen: ['LESEN', 'AENDERN'],
  zugehoerigkeit: ['LESEN', 'AENDERN'],
  rolle: ['LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN'],
  verbandsrolle: ['LESEN', 'ANLEGEN', 'LOESCHEN'],
  mitgliedschaftsantrag: ['LESEN', 'ANLEGEN', 'AENDERN', 'DELEGIEREN'],
  transfer: ['LESEN', 'ANLEGEN', 'AENDERN'],
  lizenz: ['LESEN', 'ANLEGEN', 'AENDERN'],
  lizenz_aussetzung: ['ANLEGEN', 'AENDERN'],
  judopass_antrag: ['LESEN', 'ANLEGEN', 'AENDERN'],
  zahlungsweise: ['LESEN', 'AENDERN'],
  gebuehren: ['LESEN', 'AENDERN'],
  ueberweisung: ['LESEN', 'ANLEGEN', 'AENDERN', 'DELEGIEREN'],
  beitraege: ['LESEN', 'AENDERN', 'DELEGIEREN'],
  rechnungslauf: ['LESEN', 'ANLEGEN', 'AENDERN'],
  forderungen: ['LESEN', 'AENDERN'],
  mandate: ['LESEN'],
  lehrgang: ['LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN'],
  lehrgang_freigabe: ['AENDERN'],
  lehrgang_teilnahme: ['LESEN', 'AENDERN', 'DELEGIEREN'],
  lehrgangstyp: ['LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN'],
  turnier: ['LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN'],
  veranstaltung: ['LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN'],
  turnier_meldung: ['LESEN', 'ANLEGEN', 'AENDERN', 'DELEGIEREN'],
  mannschaft: ['LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN', 'DELEGIEREN'],
  veranstaltung_anmeldung: ['LESEN', 'AENDERN', 'DELEGIEREN'],
});

/** FR-25: darf jeder angemeldete Benutzer. */
export const BASISRECHTE = Object.freeze([
  'lehrgang:ANLEGEN', 'turnier:ANLEGEN', 'veranstaltung:ANLEGEN', 'mitgliedschaftsantrag:ANLEGEN', 'verbandsbaum:LESEN', 'fristen:LESEN',
]);

export const kennt = (recht) => {
  const [name, operation] = recht.split(':');
  return Object.hasOwn(KATALOG, name) && KATALOG[name].includes(operation);
};
