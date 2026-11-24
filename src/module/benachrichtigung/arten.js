// Benachrichtigungsarten: art → (daten) => { titel, text }. Jede Story ergänzt ihre Art.
export const ARTEN = Object.freeze({
  hinweis: ({ titel, text }) => ({ titel, text }),
  zugehoerigkeit_angefragt: ({ name }) => ({
    titel: 'Neue Anfrage zur Vereinszugehörigkeit',
    text: `${name} möchte dem Verein zugeordnet werden. Bitte die Anfrage freigeben oder ablehnen.`,
  }),
  verein_verbandswechsel: ({ verein, alt, neu }) => ({
    titel: `Verbandswechsel: ${verein}`,
    text: `Der Verein ${verein} ist vom Verband ${alt} zum Verband ${neu} gewechselt. Die Verbandsrechte gelten ab sofort nach der neuen Zuordnung.`,
  }),
});
