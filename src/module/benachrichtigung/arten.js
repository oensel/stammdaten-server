// Benachrichtigungsarten: art → (daten) => { titel, text }. Jede Story ergänzt ihre Art.
export const ARTEN = Object.freeze({
  hinweis: ({ titel, text }) => ({ titel, text }),
});
