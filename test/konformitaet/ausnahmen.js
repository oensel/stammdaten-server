// Altbestand, der noch nicht umgezogen ist. Diese Listen dürfen nur kürzer werden (geprüft gegen ursprung.js).
const routen = (namen) => namen.map((n) => `src/routes/${n}.js`);
const kern = (namen) => namen.map((n) => `src/${n}.js`);

export const ROUTEN_MIT_SQL = routen(['abgleich', 'anwendungen', 'auth', 'benutzer', 'einmal', 'geraete', 'graduierungen', 'ich', 'mitglieder', 'rechte']);

export const ALTDATEIEN = [
  ...routen(['abgleich', 'anwendungen', 'auth', 'benutzer', 'einmal', 'geraete', 'graduierungen', 'ich', 'mitglieder', 'rechte']),
  ...kern(['app', 'auth', 'backchannel', 'config', 'db', 'einmal', 'errors', 'import', 'jwt', 'keys', 'mailer', 'migrate', 'passwords', 'scopes', 'seed', 'server', 'worker']),
];
