# Stammdaten-Server

Zentraler Dienst für Benutzer, Rollen, Vereine und Mitglieder (Zahler/IBAN liegen im Abrechnungs-Tool; Dojo-Master-Pro, Hajime-Pro, Kyu-Manager-Pro).
**Umgesetzt:** Anmeldung (inkl. Single Sign-on über alle Apps und Vereine: `docs/sso-entscheidung.md`, Back-Channel-Logout, `GET /v1/anwendungen`), Benutzer/Rechte (`PUT/DELETE /benutzer/{id}/rechte/{schluessel}`), Mitglieder-Import, Abgleich und Graduierungen (Stand siehe `docs/api-entwurf.md`). Entwurf: `docs/api-entwurf.md`, `docs/datenbankentwurf.md`, `db/schema.sql`.

## Start (ohne PostgreSQL-Installation)

```powershell
npm install
Copy-Item .env.example .env
npm run db          # Vordergrund: eingebettetes PostgreSQL, Port 5440, Daten in .pgdata-dev
npm run db:setup    # in zweitem Terminal, einmalig: Schema + Demo-Seed + Signaturschlüssel
npm start           # http://127.0.0.1:4000
npm test            # Vitest (eigene Wegwerf-Datenbank)
```

## Endpunkte (siehe api-entwurf.md 6.1 / 6.2)

`GET /.well-known/jwks.json`, `GET /.well-known/openid-configuration`, `POST /auth/login`, `POST /auth/pin`,
`POST /oauth/token` (refresh_token), `POST /auth/logout`, `POST /mitglieder/import` (DJB-Export CSV/xlsx, `?pruefen=true` = Trockenlauf), `GET /mitglieder`, `POST /v1/graduierungen` + `DELETE /v1/graduierungen/{id}` (Apps schreiben Graduierungen zurück), `GET /v1/abgleich` (Delta-Abgleich für Apps per client_credentials; Vereine pro App in `anwendung_vereine`), `PATCH /mitglieder/{id}` (Eintritt, nur Dojo-Master-Pro), `PUT/GET/DELETE /mitglieder/{id}/passfoto` (Formular-Upload), `POST /auth/verein-wechseln` (Heimatverein: `PATCH /ich`), `POST /oauth/token` (auch `client_credentials`, Secret: `npm run client:secret -- <app>`), `GET/PATCH/DELETE /ich`, `POST /benutzer`,
`POST /benutzer/{id}/passwort-zuruecksetzen`, `POST /auth/passwort-vergessen`, `/auth/passwort-zuruecksetzen`, `/auth/email-bestaetigen`, `/auth/einladung-annehmen`, `POST /einladungen`, `GET/POST /geraete`, `PATCH /geraete/{id}`, `GET /health`.
Web-Clients: `client_typ: "web"` → Refresh-Token als HttpOnly-Cookie (`COOKIE_SECURE=true` hinter HTTPS).

## Demo-Zugänge (App `kyu-manager-pro`, Verein „JC Demo“)

`schueler1` (Schüler), `trainer1`, `pruefer1`, `admin1`, `eltern1` (Kinder Lena + Tim).
Passwort für alle: `DEMO_PASSWORT` aus `.env.example`/`.env` (nur Entwicklung).

## Noch offen

Authorization Code + PKCE (nur bei fremder Domain), TOTP, Oberfläche für die Mail-Links, Schlüsselrotation
ohne Neustart, Rate-Limit pro IP, Mitglieder-/Abgleich-Endpunkte.
