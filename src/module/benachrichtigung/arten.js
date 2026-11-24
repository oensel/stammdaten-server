// Benachrichtigungsarten: art → (daten) => { titel, text }. Jede Story ergänzt ihre Art.
export const ARTEN = Object.freeze({
  hinweis: ({ titel, text }) => ({ titel, text }),
  verein_verbandswechsel: ({ verein, alt, neu }) => ({
    titel: `Verbandswechsel: ${verein}`,
    text: `Der Verein ${verein} ist vom Verband ${alt} zum Verband ${neu} gewechselt. Die Verbandsrechte gelten ab sofort nach der neuen Zuordnung.`,
  }),
});
