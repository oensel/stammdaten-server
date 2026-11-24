// Benachrichtigungsarten: art → (daten) => { titel, text }. Jede Story ergänzt ihre Art.
export const ARTEN = Object.freeze({
  hinweis: ({ titel, text }) => ({ titel, text }),
  zugehoerigkeit_angefragt: ({ name }) => ({
    titel: 'Neue Anfrage zur Vereinszugehörigkeit',
    text: `${name} möchte dem Verein zugeordnet werden. Bitte die Anfrage freigeben oder ablehnen.`,
  }),
  zugriff_erteilt: ({ vorname }) => ({ titel: 'Neuer Zugriff auf Personendaten', text: `Für ${vorname} wurde ein weiterer Zugriff auf die Daten erteilt.` }),
  zugriff_entzogen: ({ vorname }) => ({ titel: 'Zugriff auf Personendaten beendet', text: `Für ${vorname} wurde ein Zugriff auf die Daten beendet.` }),
  verein_verbandswechsel: ({ verein, alt, neu }) => ({
    titel: `Verbandswechsel: ${verein}`,
    text: `Der Verein ${verein} ist vom Verband ${alt} zum Verband ${neu} gewechselt. Die Verbandsrechte gelten ab sofort nach der neuen Zuordnung.`,
  }),
});
