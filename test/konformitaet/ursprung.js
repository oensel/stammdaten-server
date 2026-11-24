// Eingefrorener Stand der Ausnahmen aus Story 1.3 (2026-11-24). Nie ändern.
const routen = (namen) => namen.map((n) => `src/routes/${n}.js`);
const kern = (namen) => namen.map((n) => `src/${n}.js`);

export const URSPRUNG_ROUTEN = routen(['abgleich', 'anwendungen', 'auth', 'benutzer', 'einmal', 'geraete', 'graduierungen', 'ich', 'mitglieder', 'rechte']);

export const URSPRUNG_DATEIEN = [
  ...routen(['abgleich', 'anwendungen', 'auth', 'benutzer', 'einmal', 'geraete', 'graduierungen', 'ich', 'mitglieder', 'rechte']),
  ...kern(['app', 'auth', 'backchannel', 'config', 'db', 'einmal', 'errors', 'import', 'jwt', 'keys', 'mailer', 'migrate', 'passwords', 'scopes', 'seed', 'server', 'worker']),
];
