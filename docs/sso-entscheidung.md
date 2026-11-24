# Entscheidung: Single Sign-on über alle Apps (Stand 19.11.2026)

Ziel: Zwischen Apps (Kyu-Manager-Pro, Dan-Manager, Dojo-Master-Pro, Hajime-Pro) **und** Vereinen wechseln, ohne sich neu
anzumelden. Abmelden gilt für alle Apps. Jede App bleibt allein mit dem Stammdaten-Server lauffähig (keine App ruft eine
andere auf).

## 1. Grundsätze

- **Eine Anmeldesitzung pro Person und Browser** (`sid` = `refresh_tokens.familie_id`), nicht pro App und nicht pro Verein.
- **Ein Access-Token für alle Apps und Vereine** der Person (JWT, EdDSA, 600 s). Es enthält nur **Rechte je Verein**
  (Trainer, Prüfer …) und die freigegebenen Apps – **keine Feinrechte**. Was ein Recht in einer App bedeutet, entscheidet
  die App selbst (Kyu: `server/src/rights.js`).
- **Verein wechseln = rein im Client**: Die App wählt den aktiven Verein aus dem Token und schickt ihn bei jeder Anfrage
  im Header `X-Verein: <uuid>` mit. Kein Aufruf beim Stammdaten-Server.
- **App wechseln**: Alle Apps laufen unter einer Domain (siehe api-entwurf 6.1.4) → das Cookie `sd_refresh` ist für alle
  Apps dasselbe. Die Ziel-App ruft beim Start `POST /oauth/token` (Cookie) und ist angemeldet. Den aktiven Verein gibt der
  Umschalter als `?verein=<uuid>` mit.
- **Abmelden** widerruft die `sid` zentral; Apps erfahren es per Back-Channel und beim nächsten Refresh.

## 2. Access-Token (neu)

| Claim | Inhalt |
|---|---|
| `iss`, `sub`, `iat`, `exp`, `jti` | wie bisher |
| `aud` | **Array** aller Apps, die die Person in mindestens einem Verein nutzen darf (`["kyu-manager-pro","dojo-master-pro"]`) |
| `sid` | Anmeldesitzung |
| `super_admin` | boolean |
| `heimatverein_id` | Vorschlag für den Start (`benutzer.heimatverein_id`), sonst erster Verein |
| `vereine` | Map `verein_id → { name, rolle, rechte[], mitglied_id, mitglied_ids[], apps: { <schluessel>: "<scope>" } }` |
| `muss_passwort_aendern` | nur wenn `true` (dann `vereine` leer) |

- `apps` je Verein = Apps aus `anwendung_vereine` für diesen Verein; `scope` = Benutzer-Scopes ∩ `anwendungen.scopes`.
- Nur Vereine mit mindestens einer freigegebenen App erscheinen.
- **Übergang**: Solange nicht alle Apps umgestellt sind, setzt der Server zusätzlich die alten Claims (`verein_id`,
  `rolle`, `rechte`, `scope`, `mitglied_id`, `mitglied_ids`) für den Heimatverein bzw. den beim Login gewählten Verein.
- Größe: bei typischen Benutzern (1–3 Vereine) < 2 KB. Ab 20 Vereinen `mitglied_ids` weglassen (Flag `mitglied_ids_gekuerzt`).

## 3. Endpunkte (Änderungen)

| Endpunkt | Änderung |
|---|---|
| `POST /auth/login` | `client_id` bleibt (Protokoll/Sperre), `verein_id` entfällt als Pflicht – kein `409 verein_waehlen` mehr für Web |
| `POST /oauth/token` (refresh) | Refresh-Token gehört zur Sitzung, nicht zur App: jede App darf mit dem Cookie erneuern. `client_id` nur zum Protokoll |
| `POST /auth/verein-wechseln` | bleibt nur für Geräte-/PIN-Anmeldungen (an einen Verein gebunden), für Web veraltet |
| `POST /auth/logout` | widerruft die ganze `sid` (alle Apps), löscht Cookie, löst Back-Channel aus. `alle_geraete: true` wie bisher |
| `GET /v1/anwendungen` | neu, öffentlich: `[{schluessel, name, url, icon}]` für den App-Umschalter (Spalten `url`, `icon` in `anwendungen`) |
| Back-Channel | neu: bei Logout/Widerruf `POST <app>/api/auth/backchannel-logout` mit signiertem Logout-Token (`typ: logout+jwt`, `sid`, `sub`, `aud` = App, 120 s). Adresse: Spalte `anwendungen.backchannel_url`. Fehlschläge werden 3× wiederholt, danach ignoriert (Access-Token läuft ohnehin nach 600 s ab) |

Gleichzeitige Refreshes zweier Apps mit demselben Cookie: vorhandene 20-s-Regel (`token_ersetzt`) – die App wiederholt
einmal, dann trägt das Cookie bereits das neue Token.

## 4. Pflichten jeder App

1. Token prüfen (JWKS), `aud` enthält eigene App, Verein aus `X-Verein` muss in `vereine` stehen und die eigene App in
   `vereine[v].apps` → sonst `403 verein_nicht_freigegeben`.
2. Rechte lokal aus `vereine[v].rechte` ableiten.
3. Back-Channel-Endpunkt: Logout-Token prüfen, `sid` bis `iat + 600 s` sperren (Speicher genügt; nach Neustart läuft
   das Token ohnehin bald ab).
4. Client: Token nur im Speicher; bei Fokus, 401 und alle 60 s erneuern → `401` = abgemeldet, lokale Daten löschen
   (vorher warnen, wenn Outbox nicht leer).
5. Lokale Offline-Daten **je Verein getrennt** (z. B. IndexedDB `kmp-sync-<verein_id>`).
6. Umschalter „Verein ▾ · App ▾“ aus `vereine` + `GET /v1/anwendungen`.

## 5. Nicht Teil dieser Entscheidung

Authorization Code + PKCE (nur bei fremder Domain), native Apps (System-Browser), TOTP.

## 6. Nachträge zur Umsetzung (19.11.2026)

Diese Punkte waren im Vertrag offen und sind so umgesetzt (Details: `api-entwurf.md` 6.1.9):

- **`azp`**: Zusätzlicher Claim = App, die das Token angefordert hat (`client_id`). Bestimmt die Scope-Obergrenze der alten Claims und ist die App für
  `/geraete`, `/ich`. Apps prüfen weiter `aud` (Array).
- **Geräte-/PIN-Tokens bleiben unverändert**: `aud` ist ein String (nur die eigene App), `vereine` enthält nur den Geräte-Verein, Refresh nur mit der eigenen App
  (`client_id` einer anderen App → `401`). Kein Back-Channel für Geräte-Sitzungen.
- **Back-Channel-Format**: `POST <backchannel_url>` mit `Content-Type: application/json`, Body `{ "logout_token": "<jwt>" }` (kein Formular). Antwort 2xx = zugestellt.
  Das Token hat den Header `typ: logout+jwt`, die Claims `iss`, `sub`, `aud`, `sid`, `iat`, `exp` (+120 s), `jti` und `events` (OIDC-Back-Channel-Event). Prüfen mit JWKS, `typ`, `aud` = eigene App.
- **Auslöser** des Back-Channels: `POST /auth/logout` (auch `alle_geraete`), Wiederverwendung eines Refresh-Tokens, deaktiviertes Konto, entzogener Zugang. Empfänger sind die aktiven Apps mit
  `backchannel_url`, die der Benutzer in mindestens einem seiner Vereine nutzen darf.
- **Apps je Verein** kommen aus `anwendung_vereine` – dieselbe Zuordnung wie beim Abgleich. Ein Verein ohne Eintrag erscheint nicht im Token (Betrieb: neue Vereine/Apps dort eintragen).
- **Wechsel der Übergangs-Claims**: `POST /oauth/token?verein=<uuid>`; ohne Angabe gilt der Verein der Sitzung (zuletzt gewählt), sonst Heimatverein bzw. erster Verein.
- **Web ohne Vereinswahl**: nur bei `client_typ: "web"`; andere Anmeldungen ohne Heimatverein bekommen bei mehreren Vereinen weiter `409 verein_waehlen`.
- **`GET /v1/anwendungen`** liefert nur aktive Apps mit gesetzter `url` (Seed: Kyu-Manager `http://localhost:5173`, Back-Channel `http://127.0.0.1:3000/api/auth/backchannel-logout`, nur per `npm run db:setup`).
