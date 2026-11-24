// App-Obergrenze unter /v2: Recht → Scope, den anwendungen.scopes enthalten muss. Ohne Eintrag ist das Recht über keine App nutzbar;
// wer ein Recht neu verwendet, trägt es hier ein. Basisrechte brauchen keinen Scope.
const JE_RECHT = {
  zugehoerigkeit: 'benutzer:verwalten',
  rolle: 'rechte:verwalten',
  verbandsbaum: 'verband:verwalten', fristen: 'verband:verwalten', verbandsrolle: 'verband:verwalten',
  personen: 'mitglieder:verwaltung', personen_zusammenfuehrung: 'mitglieder:verwaltung',
};
const LESEN_SCHREIBEN = {
  mitglieder: ['mitglieder:lesen', 'mitglieder:schreiben'],
  transfer: ['mitglieder:lesen', 'mitglieder:schreiben'],
  mitgliedschaftsantrag: ['mitglieder:lesen', 'mitglieder:schreiben'],
  graduierung: ['graduierungen:lesen', 'graduierungen:schreiben'],
  vereine: ['vereine:lesen', 'vereine:schreiben'],
  lizenz: ['lizenzen:lesen', 'lizenzen:schreiben'],
  judopass_antrag: ['lizenzen:lesen', 'lizenzen:schreiben'],
};

export function scopeFuer(recht) {
  const [name, operation] = recht.split(':');
  if (operation === 'DELEGIEREN') return 'rechte:verwalten';
  if (Object.hasOwn(JE_RECHT, name)) return JE_RECHT[name];
  if (Object.hasOwn(LESEN_SCHREIBEN, name)) return LESEN_SCHREIBEN[name][operation === 'LESEN' ? 0 : 1];
  return null;
}
