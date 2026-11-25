// Benachrichtigungsarten: art → (daten) => { titel, text }. Jede Story ergänzt ihre Art.
export const ARTEN = Object.freeze({
  hinweis: ({ titel, text }) => ({ titel, text }),
  zugehoerigkeit_angefragt: ({ name }) => ({
    titel: 'Neue Anfrage zur Vereinszugehörigkeit',
    text: `${name} möchte dem Verein zugeordnet werden. Bitte die Anfrage freigeben oder ablehnen.`,
  }),
  zugriff_erteilt: ({ vorname }) => ({ titel: 'Neuer Zugriff auf Personendaten', text: `Für ${vorname} wurde ein weiterer Zugriff auf die Daten erteilt.` }),
  zugriff_entzogen: ({ vorname }) => ({ titel: 'Zugriff auf Personendaten beendet', text: `Für ${vorname} wurde ein Zugriff auf die Daten beendet.` }),
  antrag_eingegangen: () => ({ titel: 'Neuer Mitgliedschaftsantrag', text: 'Ein neuer Antrag auf Mitgliedschaft liegt vor. Bitte annehmen oder ablehnen.' }),
  antrag_erinnerung: () => ({ titel: 'Offener Mitgliedschaftsantrag', text: 'Ein Mitgliedschaftsantrag wartet noch auf eure Entscheidung und verfällt sonst.' }),
  antrag_gestellt: ({ vorname, verein }) => ({ titel: 'Mitgliedschaftsantrag gestellt', text: `Für ${vorname} wurde eine Mitgliedschaft im Verein ${verein} beantragt. War das nicht gewollt, wende dich bitte an den Verein.` }),
  antrag_entschieden: ({ verein, ergebnis }) => ({ titel: 'Mitgliedschaftsantrag', text: `Der Antrag auf Mitgliedschaft im Verein ${verein} wurde ${ergebnis}.` }),
  antrag_verfallen: ({ verein }) => ({ titel: 'Mitgliedschaftsantrag verfallen', text: `Der Antrag auf Mitgliedschaft im Verein ${verein} ist ohne Entscheidung verfallen.` }),
  verein_verbandswechsel: ({ verein, alt, neu }) => ({
    titel: `Verbandswechsel: ${verein}`,
    text: `Der Verein ${verein} ist vom Verband ${alt} zum Verband ${neu} gewechselt. Die Verbandsrechte gelten ab sofort nach der neuen Zuordnung.`,
  }),
});
