# Stammdaten-Server – API-Entwurf

REST-API für Dojo-Master-Pro, Hajime-Pro und Kyu-Manager-Pro. Grundlage ist der [Datenbankentwurf](datenbankentwurf.md).

Leitgedanke: **Jede Antwort enthält nur die Zeilen und Felder, die der Aufrufer in genau dieser App für seine
Aufgabe braucht.** Ein Mitglied, das im Kyu-Manager-Pro seinen Prüfungsstand ansieht, bekommt Name, Grad und
Gruppen – nicht Anschrift, Geburtsdatum, Mitgliedsnummer-Historie oder Zahlerdaten, obwohl all das gespeichert ist.

---

## 1. Wie Sichtbarkeit entsteht

Drei Stufen, jede kann nur einschränken, nie erweitern:

```
 Rolle + Rechte des Benutzers ──► Scopes des Benutzers
                                        │
                                        ▼  Schnittmenge
 Obergrenze der App (aud im Token) ─► wirksame Scopes ──► Zeilenfilter + Feldgruppen
                                        │
                                        ▼  Schnittmenge
 ?felder= in der Anfrage (optional) ─► tatsächlich gelieferte Feldgruppen
```

1. **Benutzer-Scopes** werden wie im Datenbankentwurf aus Rolle und Rechten abgeleitet (Abschnitt 3 präzisiert sie).
2. **App-Obergrenze**: Jede App hat eine feste Höchstmenge an Scopes. Sie gilt für Benutzer-Tokens **und** für den
   Server-zu-Server-Abgleich. Ein Trainer hat in Dojo-Master-Pro `mitglieder:kontakt`, im Kyu-Manager-Pro nicht,
   weil Kyu-Manager-Pro keine Anschriften braucht.
3. **`?felder=`**: Die App kann weniger anfordern, als sie dürfte (z. B. nur `kern` für eine Auswahlliste).

Daraus ergeben sich zwei unabhängige Einschränkungen:

- **Zeilenfilter** – *welche* Datensätze: nur eigene + Kinder, nur aktive, ganzer Verein, inkl. Ausgetretene.
- **Feldgruppen** – *welche* Spalten je Datensatz.

### 1.1 Regeln für die Umsetzung

- **Projektion in SQL, nicht im JSON.** Der Server baut das `select` aus den erlaubten Feldgruppen. Nicht erlaubte
  Spalten verlassen die Datenbank gar nicht erst.
- **Fehlend ≠ leer.** Nicht erlaubte Felder fehlen im JSON. `null` bedeutet „erlaubt, aber leer“. Sonst würde eine
  App beim Upsert vorhandene Werte mit `null` überschreiben.
- **Antwort-Header `X-Feldgruppen: kern,sport`** nennt, was geliefert wurde.
- **Deny by default.** Jede Spalte muss genau einer Feldgruppe zugeordnet sein. Ein Test schlägt fehl, wenn eine neue
  Spalte in `mitglieder` usw. keiner Gruppe zugeordnet ist.
- **404 statt 403** für Datensätze außerhalb des Zeilenfilters, damit nicht erkennbar ist, ob es sie gibt.
  403 nur, wenn der Endpunkt als Ganzes nicht erlaubt ist.
- **Keine personenbezogenen Daten in URLs** (Suche nach IBAN, E-Mail, Name per `POST` mit Body, nicht als Query).
- Die Regeln liegen in einem Modul `sichtbarkeit` (`kontext → { zeilenfilter, feldgruppen }`), das als npm-Paket
  auch von den Apps genutzt wird (siehe 5.2).

---

## 2. Feldgruppen

### 2.1 Mitglied

| Feldgruppe | Felder |
|---|---|
| `kern` | `id`, `verein_id`, `mitgliedsnr`, `vorname`, `nachname`, `status`, `change_seq`, `geloescht_am` |
| `sport` | `aktueller_grad` {`art`, `stufe`, `bezeichnung`, `datum`}, `gruppen` [ids] |
| `person` | `geburtsdatum`, `geschlecht` |
| `judopass` | `judopass` {`nummer`, `gueltig_bis`} |
| `mitgliedschaft` | `eintritt`, `kuendigung_am`, `austritt` |
| `kontakt` | `strasse`, `plz`, `ort`, `land`, `email`, `telefon`, `nationalitaet` |
| `tarif` | `ehrenmitglied`, `ausbildung_bis` |
| `verwaltung` | `djb_id`, `judopass_url`, `erstellt_am`, `geaendert_am`, `geaendert_von` |

Unterressourcen sind eigene Endpunkte mit eigenem Scope: Graduierungshistorie, Lizenzen (zusätzlich nach `art`
gefiltert), Dokumente, Führungszeugnis-Einsicht.

### 2.2 Verein

| Feldgruppe | Felder | Wer |
|---|---|---|
| `oeffentlich` | `id`, `name`, `kurzname`, `ort`, `bundesland`, `verband_id`, `ist_mandant`, Logo-URL | alle angemeldeten (auch Gastvereine in Hajime-Pro) |
| `kontakt` | Anschrift, `email`, `telefon`, `website`, `vereinsnummer` | Admin, alle Rechte |
| `finanzen` | `glaeubiger_id`, `konto_inhaber`, `iban_maske`, `bic`, Steuer-/Freistellungsangaben | Admin, kassierer, kassenpruefer |

### 2.3 Zahler, Mandate, IBAN – entfallen

Zahler, SEPA-Mandate und IBANs liegen **nicht** im Stammdaten-Server, sondern im Abrechnungs-Tool (Dojo-Master-Pro). Gemeinsamer Schlüssel
zum Zuordnen ist die DJB-ID (`mitglieder.djb_id`) bzw. die Mitglieds-ID. Entsprechend gibt es keine Scopes `zahler:*` und keine Zahler-Endpunkte;
auch `passiv`, `fuehrender_verein` und `notizen` werden nicht gespeichert (Migration `004_ohne_zahler.sql`). `eintritt` (Anmeldedatum) bleibt,
wird aber **nur von Dojo-Master-Pro** gesetzt (Scope `mitglieder:eintritt`, `PATCH /mitglieder/{id}`); der Import setzt es nie.

## 3. Scopes (Verfeinerung des Datenbankentwurfs)

`mitglieder:lesen` wird aufgeteilt, damit Feldgruppen einzeln vergeben werden können.

| Scope | Zeilen / Felder | Super-Admin | Admin | Mitglied | trainer | pruefer | kassierer | kassenpruefer |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `mitglieder:selbst` | eigene Zeile + Kinder; Felder laut Selbst-Profil der App (4.2) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `mitglieder:lesen` | ganzer Verein (aktiv, ruhend); `kern`, `sport` | ✔ | ✔ | | ✔ | ✔ | ✔ | ✔ |
| `mitglieder:person` | `person` | ✔ | ✔ | | ✔ | ✔ | ✔ | ✔ |
| `mitglieder:mitgliedschaft` | `mitgliedschaft` | ✔ | ✔ | | ✔ | | ✔ | ✔ |
| `mitglieder:kontakt` | `kontakt` | ✔ | ✔ | | ✔ | | ✔ | |
| `mitglieder:tarif` | `tarif` | ✔ | ✔ | | | | ✔ | ✔ |
| `mitglieder:verwaltung` | `verwaltung` | ✔ | ✔ | | | | | |
| `mitglieder:ausgetretene` | Zeilen mit Status `ausgetreten` | ✔ | ✔ | | | | ✔ | ✔ |
| `mitglieder:schreiben` | | ✔ | ✔ | | ✔ | | | |
| `mitglieder:import` | Mitglieder-Import (6.4) | ✔ | ✔ | | | | | |
| `mitglieder:eintritt` | Eintrittsdatum setzen (nur Dojo-Master-Pro in der Obergrenze) | ✔ | ✔ | | | | ✔ | |
| `graduierungen:lesen` / `:schreiben` | Historie | ✔/✔ | ✔/✔ | | ✔/– | ✔/✔ | | |
| `lizenzen:judopass` | Feldgruppe `judopass` + Lizenzart `judopass` | ✔ | ✔ | | ✔ | ✔ | | |
| `lizenzen:lesen` / `:schreiben` | alle Lizenzarten | ✔/✔ | ✔/✔ | | ✔/– | ✔/– | | |
| `mitglieder:efz` | Führungszeugnis-Einsicht | ✔ | ✔ | | | | | |
| `vereine:lesen` | `oeffentlich` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `vereine:kontakt` / `vereine:finanzen` | | ✔/✔ | ✔/✔ | | ✔/– | ✔/– | ✔/✔ | ✔/✔ |
| `vereine:schreiben` | | ✔ | ✔ | | | | | |
| `gruppen:lesen` / `:schreiben` | | ✔/✔ | ✔/✔ | eigene/– | ✔/✔ | ✔/– | ✔/– | ✔/– |
| `benutzer:verwalten`, `rechte:verwalten` | | ✔ | ✔ | | | | | |
| `benutzer:schueler` | Schüler-Zugänge (Rolle Mitglied, ohne Rechte) im eigenen Verein anlegen, Passwort zurücksetzen | ✔ | ✔ | | ✔ | | | |

### 3.1 App-Obergrenzen

| Scope | Dojo-Master-Pro | Hajime-Pro | Kyu-Manager-Pro |
|---|:-:|:-:|:-:|
| `mitglieder:selbst`, `mitglieder:lesen` | ✔ | ✔ | ✔ |
| `mitglieder:person` | ✔ | ✔ (Altersklasse) | ✔ (Mindestalter) |
| `mitglieder:mitgliedschaft` | ✔ | | |
| `mitglieder:kontakt` | ✔ | | |
| `mitglieder:tarif`, `mitglieder:verwaltung`, `mitglieder:ausgetretene` | ✔ | | |
| `mitglieder:schreiben` | ✔ | | |
| `graduierungen:lesen` / `:schreiben` | ✔/✔ | | ✔/✔ |
| `lizenzen:judopass` | ✔ | ✔ | ✔ |
| `lizenzen:lesen` | ✔ | nur `wettkampflizenz` | nur `graduierungslizenz`, `pruefer_lizenz` |
| `lizenzen:schreiben`, `mitglieder:efz` | ✔ | | |
| `vereine:*` | ✔ | `lesen` | `lesen` |
| `gruppen:*` | ✔ | | ✔ |
| `benutzer:verwalten`, `rechte:verwalten` | ✔ | ✔ (Freigaben) | ✔ |
| `benutzer:schueler` | ✔ | | ✔ |

Die Obergrenze steht in der Datenbank: `anwendungen.scopes` gilt für Benutzer-Tokens, `anwendungen.client_scopes`
(Teilmenge von `scopes`) für den Server-zu-Server-Abgleich ohne Benutzer, `anwendungen.lizenz_arten text[]` für die
Lizenzarten-Einschränkung (`null` = alle). Die Verwaltungsoberfläche des Stammdaten-Servers selbst
(`aud = stammdaten`) hat keine Obergrenze.

---

## 4. Ergebnis je App und Rolle

### 4.1 `GET /mitglieder` – was kommt an?

| App | Mitglied | Trainer | Prüfer | Kassierer | Admin |
|---|---|---|---|---|---|
| **Kyu-Manager-Pro** | eigene Zeile + Kinder · `kern`, `sport` | Verein · `kern`, `sport`, `person`, `judopass` | wie Trainer (+ Graduierungen schreiben) | Verein · `kern`, `sport`, `person` | wie Trainer |
| **Hajime-Pro** | eigene Zeile · `kern` | Verein · `kern`, `sport`, `person`, `judopass` | wie Trainer | Verein · `kern`, `sport`, `person` | wie Trainer |
| **Dojo-Master-Pro** | eigene Zeile + Kinder · Selbst-Profil | Verein · `kern`, `sport`, `person`, `judopass`, `mitgliedschaft`, `kontakt` | Verein · `kern`, `sport`, `person`, `judopass` | Verein inkl. Ausgetretene · alles außer `verwaltung` | alles |

Ein Admin im Kyu-Manager-Pro sieht also **nicht** mehr als ein Trainer: Die App-Obergrenze schneidet Kontakt,
Tarif und Verwaltung ab. Wer das braucht, öffnet Dojo-Master-Pro.

### 4.2 Selbst-Profile (Rolle Mitglied, eigene Daten und Kinder)

| App | Feldgruppen | Unterressourcen |
|---|---|---|
| Kyu-Manager-Pro | `kern`, `sport` | eigene Graduierungshistorie (ohne `pruefer`, `ort`) |
| Hajime-Pro | `kern` | – |
| Dojo-Master-Pro | `kern`, `sport`, `person`, `mitgliedschaft`, `kontakt` | |
| Stammdaten-Portal | alles | `GET /ich/auskunft` (Art. 15 DSGVO, vollständiger Export) |

Beispiel: Mitglied (Elternteil mit einem Kind) im Kyu-Manager-Pro

```http
GET /v1/mitglieder
Authorization: Bearer <aud=kyu-manager-pro, rolle=mitglied>
```

```json
{
  "daten": [
    { "id": "…a1", "verein_id": "…", "mitgliedsnr": 214, "vorname": "Lena", "nachname": "Schmidt", "status": "aktiv",
      "aktueller_grad": { "art": "kyu", "stufe": 6, "bezeichnung": "6. Kyu – Gelb-Orange", "datum": "2026-03-14" },
      "gruppen": ["…g2"], "change_seq": 88123, "geloescht_am": null }
  ],
  "naechster": null
}
```

Dieselbe Abfrage durch den Kassierer in Dojo-Master-Pro liefert zum selben Datensatz zusätzlich Geburtsdatum,
Anschrift, E-Mail usw.

### 4.3 Nicht verteilt, nur live

- **Führungszeugnis-Einsicht**: kein `?seit`, nicht im Abgleich, nicht in Webhooks; jeder Lesezugriff im `audit_log`.
- **Dokumente** (Passfoto, Scans): Liste liefert nur Metadaten, Inhalt über eigenen Endpunkt.

---

## 5. Abgleich und Apps mit eigener Datenhaltung

### 5.1 Delta-Abgleich

`GET /v1/abgleich?verein_id=<uuid>&seit=<stand>&limit=<1..1000, Standard 500>` – `seit` fehlt oder ist leer = alles.

- **Auth:** nur Bearer-Token aus `grant_type=client_credentials` (6.1.7). Benutzer-Tokens → `403 nur_anwendung`.
- **Vereine:** eine App darf nur Vereine abgleichen, die ihr in `anwendung_vereine` zugeordnet sind, sonst
  `403 verein_nicht_freigegeben` (Demo-Seed: JC Demo ↔ kyu-manager-pro).
- **Antwort:** `{ stand, mehr, mitglieder[], gruppen[], mitglied_gruppen[], graduierungen[], lizenzen[] }`. Felder nur innerhalb der
  `client_scopes` der App (Kyu-Manager-Pro: keine Kontakt-/Adressdaten), Lizenzen nur aus `lizenz_arten`. Fehlt der Scope für eine
  Tabelle (z. B. `gruppen:lesen`), kommt sie als leeres Array.
  - `mitglieder`: `id`, `mitgliedsnr`, `vorname`, `nachname`, `geburtsdatum` (mit `mitglieder:person`), `status`, `geloescht_am`, `anonymisiert_am`.
    Ausgetretene Mitglieder ohne Scope `mitglieder:ausgetretene` kommen nur als Hinweis (`status: ausgetreten`, Namen/Geburtsdatum `null`).
  - `gruppen`: `id`, `name`, `sortierung`, `trainingszeiten`, `geloescht_am` · `mitglied_gruppen`: `mitglied_id`, `gruppe_id`, `geloescht_am`
  - `graduierungen`: `id`, `mitglied_id`, `art`, `stufe`, `datum`, `quelle`, `geloescht_am` · `lizenzen`: `id`, `mitglied_id`, `art`, `nummer`, `gueltig_bis`, `geloescht_am`
- **Cursor:** ein gemeinsamer, opaker `stand` für alle Tabellen (`change_xid`, Datenbankentwurf 2.5). Der Server liefert nur Zeilen aus
  abgeschlossenen Transaktionen (Obergrenze `pg_snapshot_xmin`); laufende Schreibvorgänge erscheinen erst im nächsten Abruf, es geht nichts
  verloren. `mehr: true` → mit `seit=stand` erneut abrufen, bis `mehr: false`. Eine angefangene Transaktion wird nie zerrissen, eine Seite kann
  deshalb größer als `limit` sein (z. B. nach einem Import).
- **Löschhinweise** (`geloescht_am`, `anonymisiert_am`) kommen immer mit, damit Apps lokal löschen.
- **`409 abgleich_neu_starten`:** Stand ungültig/unbekannt oder die Obergrenze der App (`client_scopes`, `lizenz_arten`) hat sich geändert
  (der Stand enthält einen Fingerabdruck davon). Die App verwirft ihre Kopie und lädt ohne `seit` neu, damit nicht mehr erlaubte Felder
  lokal verschwinden.

### 5.1a Graduierungen zurückschreiben

`POST /v1/graduierungen` und `DELETE /v1/graduierungen/{id}?verein_id=` – nur Client-Credentials-Token einer App (Benutzer-Token →
`403 nur_anwendung`), `graduierungen:schreiben` in den `client_scopes` (sonst `403 scope_fehlt`), Verein in `anwendung_vereine`
(sonst `403 verein_nicht_freigegeben`). `quelle` = Schlüssel der App (muss zu den erlaubten Quellen gehören, sonst `403 quelle_nicht_erlaubt`),
`geaendert_von` bleibt leer. Änderungen kommen über `/v1/abgleich` zurück.

- **POST** Body `{ verein_id, mitglied_id, art: kyu|dan, stufe, datum, ort?, pruefer? }`. Mitglied nicht im Verein → `404 mitglied_unbekannt`.
  - neu → `201 { id, mitglied_id, art, stufe, datum, quelle }`
  - (mitglied_id, art, stufe) gibt es schon: gleiche Quelle oder weich gelöscht → aktualisieren bzw. wiederbeleben, `200` (unverändert: kein Schreibvorgang);
    andere Quelle, gleiches Datum → `200` unverändert (idempotent); andere Quelle, anderes Datum → `409 graduierung_vorhanden` mit `id` und `datum`
    des Bestands (die App verknüpft dann nur).
- **DELETE** nur eigene Quelle: weich löschen, `204` (wiederholt ebenfalls `204`); fremde Quelle → `403 fremde_quelle`; unbekannt → `404 graduierung_unbekannt`.

### 5.2 Zeilenfilter in den Apps

Kyu-Manager-Pro und Hajime-Pro halten eine lokale Kopie (Offline-Tablets). Für diese Kopie kann der
Stammdaten-Server den Zugriff des einzelnen Benutzers nicht mehr durchsetzen; das muss die App tun:

- Das Access-Token enthält `mitglied_ids` (eigenes Mitglied + Kinder), damit die App ohne Rückfrage filtern kann.
- Die App nutzt das npm-Paket `@stammdaten/sichtbarkeit` mit denselben Regeln wie der Server
  (`projiziere(datensatz, kontext)`), statt eigene Logik zu schreiben.
- Ein gemeinsamer Konformitätstest (Matrix aus 4.1) läuft im Server und in jeder App.
- Wo keine Offline-Fähigkeit nötig ist (Mitglieder-Ansichten, Eltern-Zugang), fragt die App mit dem Benutzer-Token
  direkt beim Stammdaten-Server an – dann greift die Filterung serverseitig.

### 5.3 Webhooks

Webhook-Nutzlast enthält **nur** `ereignis`, `tabelle`, `id`, `verein_id`, `change_seq` – keine Personendaten.
Die App holt den Datensatz danach mit ihren eigenen Scopes.

---

## 6. Endpunkte

Basis `/v1`, JSON in `snake_case` (wie die Datenbank). Listen: `?limit` (max. 500), `?cursor`, Antwort
`{ daten, naechster }`. Schreiben mit `If-Match: <change_seq>`, sonst `428`; veraltet → `412`.
Fehler als `application/problem+json`.

### 6.1 Anmeldung

**Umgesetzt** (Stand 19.11.2026): `/.well-known/*`, `POST /auth/login`, `POST /auth/pin`, `POST /oauth/token` (nur
`grant_type=refresh_token`), `POST /auth/logout`, `POST /auth/passwort-vergessen`, `/auth/passwort-zuruecksetzen`, `/auth/email-bestaetigen`,
`/auth/einladung-annehmen`, `POST /einladungen`, `POST /auth/verein-wechseln`, **Single Sign-on** (siehe 6.1.9: `aud`-Array, `vereine`-Claim, sitzungsgebundenes Refresh, Back-Channel-Logout, `GET /v1/anwendungen`), Geräte, `/ich`, `/benutzer` (Schüler-Zugänge, Rechte), `/mitglieder` (Import, Lesen, Eintritt, Passfoto), `/v1/abgleich`, `/v1/graduierungen`. Alle anderen Zeilen sind noch Entwurf.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/.well-known/openid-configuration`, `/.well-known/jwks.json` | Metadaten, öffentliche Schlüssel |
| GET | `/oauth/authorize` | Login-Weiterleitung (Authorization Code + PKCE) |
| POST | `/oauth/token` | Code tauschen, Refresh, Client-Credentials (Server-zu-Server) |
| POST | `/auth/login` | Benutzername **oder E-Mail** + Passwort (für Apps ohne Weiterleitung) |
| POST | `/auth/pin` | PIN-Anmeldung am registrierten Gerät, **online** (`geraet_id` Pflicht); Offline siehe 6.1.3 |
| POST | `/auth/totp` | zweiter Faktor |
| POST | `/auth/logout` | Refresh-Token widerrufen (`{refresh_token}`) bzw. alle Anmeldungen (`{alle_geraete: true}` mit Bearer-Token) |
| POST | `/auth/verein-wechseln` | neues Token für anderen Verein |
| POST | `/auth/passwort-vergessen`, `/auth/passwort-zuruecksetzen`, `/auth/email-bestaetigen`, `/auth/einladung-annehmen` | Einmal-Tokens |

#### 6.1.1 Login, Token, Rotation

`POST /auth/login` `{ benutzername, passwort, client_id, verein_id?, geraet?: {id?, typ, name}, geraet_token? }` →
`{ access_token, token_type, expires_in, refresh_token, scope, verein_id, muss_passwort_aendern }`. `client_id` ist der
`schluessel` der App (`kyu-manager-pro`) und wird zu `azp` (und Teil von `aud`, siehe 6.1.9). Hat der Benutzer mehrere freigegebene
Vereine, keinen Heimatverein und kein `verein_id` angegeben, antwortet der Server mit `409 verein_waehlen` und der Vereinsliste –
**nicht bei Web-Anmeldungen** (`client_typ: "web"`): dort gibt es keine Pflicht-Vereinswahl (SSO).

- **Sperre**: nach 5 Fehlversuchen 15 Minuten `429` (auch mit richtigem Passwort). Unbekannter Benutzer und falsches
  Passwort liefern dieselbe Antwort; für unbekannte Benutzer wird trotzdem ein Hash gerechnet.
- **Passwortwechsel-Pflicht** (`benutzer.muss_passwort_aendern`, z. B. Startpasswort): Das Token enthält `scope: ""` und
  `muss_passwort_aendern: true` und gilt nur für `GET/PATCH /ich`. Nach `PATCH /ich` mit neuem Passwort liefert der
  nächste Refresh das reguläre Token.
- **Refresh** (`POST /oauth/token`, `grant_type=refresh_token`, `refresh_token`, `client_id`) rotiert: Das alte Token
  wird ungültig. Wird ein bereits rotiertes Token **nach mehr als 20 Sekunden** erneut vorgelegt, gilt das als Diebstahl:
  die ganze Anmeldung (`familie_id`) wird widerrufen (`401 token_wiederverwendet`). Innerhalb von 20 Sekunden (zwei Tabs)
  nur `401 token_ersetzt`. Bei jedem Refresh werden Rolle, Rechte und Vereinszugehörigkeit neu gelesen; ein Entzug wirkt
  also spätestens nach `expires_in` (600 s).
- **Gerät**: Wird `geraet` mitgeschickt, legt der Server eine `geraete`-Zeile an (oder verwendet `geraet.id` wieder). Ein
  gesperrtes Gerät kann sich nicht anmelden, sein Refresh-Token endet.
- Fehler: `application/problem+json` mit `code` (`anmeldung_fehlgeschlagen`, `zu_viele_versuche`, `token_abgelaufen` …).

#### 6.1.2 Access-Token (JWT, EdDSA)

Header `{alg: EdDSA, typ: at+jwt, kid}`; Claims:

| Claim | Inhalt |
|---|---|
| `iss`, `sub`, `iat`, `exp`, `jti` | Standard; `exp` = `iat` + 600 s |
| `aud` | **Array** der Apps, die die Person in mindestens einem Verein nutzen darf (Geräte-Tokens: String, nur die eigene App) |
| `azp` | App, die das Token angefordert hat (`client_id`) |
| `heimatverein_id` | Vorschlag für den Start: `benutzer.heimatverein_id`, sonst der erste Verein in `vereine` |
| `vereine` | Map `verein_id → { name, rolle, rechte[], mitglied_id, mitglied_ids[], apps: { <schluessel>: "<scope>" } }` (Details 6.1.9) |
| `verein_id` | **Übergang:** Heimatverein bzw. beim Login/`?verein=` gewählter Verein (`null` nur beim Super-Admin ohne Vereinszugehörigkeit) |
| `rolle` | (Übergang, aktiver Verein) `admin` oder `mitglied` |
| `super_admin` | boolean |
| `rechte` | (Übergang) z. B. `["trainer","pruefer"]` (nur gültige Rechte des aktiven Vereins) |
| `scope` | (Übergang) Leerzeichen-getrennt = Benutzer-Scopes ∩ `anwendungen.scopes` der App (`azp`) |
| `mitglied_id` | **eigenes** Mitglied im aktiven Verein oder `null` (z. B. Eltern-Konto) |
| `mitglied_ids` | eigenes Mitglied + Kinder (`erziehungsberechtigte`) |
| `sid` | Anmelde-Sitzung (= `refresh_tokens.familie_id`) |
| `geraet_id` | nur wenn ein Gerät registriert ist |
| `muss_passwort_aendern` | nur wenn `true` (dann `scope` leer) |

**Entscheidung (Kyu-Manager-Pro, Lücke 1):** `mitglied_id` steht getrennt neben `mitglied_ids`, damit die App weiß, wer
der Angemeldete selbst ist (z. B. Prüfer einer Prüfung), und nicht raten muss, welches der Kinder gemeint ist.

#### 6.1.3 Offline-PIN am Tablet

**Entscheidung (Lücke 4):** Der Server prüft die PIN nur **online** (`POST /auth/pin`, 5 Fehlversuche entwerten die PIN).
Für das Entsperren **ohne Netz** gibt es kein vom Server geliefertes PIN-Prüfmerkmal – eine 4–6-stellige PIN lässt sich
aus einem lokal gespeicherten Hash in Sekunden erraten. Stattdessen:

1. Beim ersten Anmelden am Tablet schickt die App `geraet` und `geraet_token: true`. Sie erhält ein **Geräte-Refresh-Token**
   (`refresh_tokens.art = 'geraet'`, 90 Tage, gleitend durch Rotation, an Benutzer + Gerät gebunden).
2. Die App legt es im Schlüsselbund des Betriebssystems ab (Keychain/Keystore) und gibt es nur nach lokaler PIN-Eingabe
   frei. Die PIN prüft die App selbst, **zählt Fehlversuche lokal** und löscht das Token nach 5 Fehlern → danach nur noch
   Passwort-Anmeldung. Das ist ein Komfortschutz, kein Ersatz für die Geräte-Sicherheit.
3. Online löst das Geräte-Token wie jedes Refresh-Token neue Access-Tokens aus. Sperrt der Verein das Gerät oder den
   Benutzer, endet es beim nächsten Refresh; „alle Geräte abmelden“ widerruft es ebenfalls.

#### 6.1.4 Web-Anmeldung (Lücke 6)
 ist nur zulässig, wenn
**Entscheidung:** Der Refresh-Token-Cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, Pfad `/`, nicht `/oauth`: auch `POST /auth/logout` und `POST /oauth/token` brauchen es; so in `src/routes/auth.js`) ist nur zulässig, wenn
Web-App und Stammdaten-Server dieselbe registrierbare Domain nutzen (z. B. `auth.verein.de` und `kyu.verein.de`). Sonst
gilt **Authorization Code + PKCE** (`GET /oauth/authorize`, Anmeldeseite des Stammdaten-Servers, `redirect_uris` je App in
`anwendungen`); das Refresh-Token landet dann nie im Browser-Speicher. Native Apps (`https://localhost`,
`capacitor://localhost`) nutzen `/auth/login` mit Bearer-Tokens im Body.
**Umgesetzt (Cookie):** `client_typ: "web"` bei `/auth/login` bzw. `/auth/pin` → Refresh-Token nur als Cookie `sd_refresh`
(`HttpOnly`, `SameSite=Strict`, `Secure` über `COOKIE_SECURE=true`, Pfad `/`), nicht im Body. `POST /oauth/token` ohne
`refresh_token` im Body liest das Cookie, `POST /auth/logout` löscht es. Entscheidung: Alle Apps laufen als eigene
Docker-Instanzen auf einem Server unter einer Domain → Cookie genügt. **Nicht umgesetzt:** `/oauth/authorize` (PKCE), nur
nötig, falls eine Web-App auf einer fremden Domain läuft.

#### 6.1.6 Einmal-Links (Passwort vergessen, Einladung, E-Mail bestätigen)

Mailversand über SMTP wie in Hajime-Pro (`SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM`, `PUBLIC_BASE_URL` für die Links; ohne
`SMTP_HOST` wird nur Empfänger + Betreff geloggt). Die Links zeigen auf eine Seite der Anmelde-Oberfläche (noch nicht gebaut)
und tragen das Token im **Fragment** (`…/passwort-zuruecksetzen#token=…`), damit es in keinem Server-Log landet. Tokens sind
einmalig nutzbar, nur der Hash liegt in `einmal_tokens`.

- `POST /auth/passwort-vergessen` `{kennung}` antwortet immer `202`. Mail nur, wenn das Konto eine E-Mail hat (Kinder-Konten
  ohne E-Mail: Reset durch den Trainer, 6.6). Max. 3 Anforderungen pro Stunde und Konto; ein neuer Link entwertet die alten; gültig 1 Stunde.
- `POST /auth/passwort-zuruecksetzen` `{token, passwort_neu}`: Passwort prüfen (Tippfehler verbrauchen den Link nicht), setzen,
  Sperre und PIN zurücksetzen, **alle Anmeldungen beenden**, E-Mail gilt als bestätigt.
- `PATCH /ich` mit neuer E-Mail schickt einen Bestätigungslink (48 h) → `POST /auth/email-bestaetigen` `{token}`.
- `POST /einladungen` `{email, rolle?, rechte?, mitglied_id?}` (Admin, `benutzer:verwalten`; Rechte zusätzlich `rechte:verwalten`) → Mail, 7 Tage gültig.
  `POST /auth/einladung-annehmen` `{token, benutzername?, passwort_neu?}`: Neue Person wählt Benutzername + Passwort (Konto entsteht
  erst jetzt); existiert die E-Mail schon, bekommt das bestehende Konto nur die Zugehörigkeit (freigegeben) mit Rolle, Rechten und Mitglied.

#### 6.1.8 Benutzer-Objekt, Heimatverein, Vereinswechsel

Jede Anmelde-/Refresh-Antwort enthält `benutzer`: Stammdaten, `heimatverein_id`, `aktiver_verein_id` und **alle freigegebenen Vereine**
mit `rolle`, `rechte`, wirksamen `scope` (für diese App) und `mitglied_id`/`mitglied_ids`. Die App entscheidet damit selbst
(Vereinswahl, Menüs); `GET /ich` liefert dasselbe (`vereine`). Das Token enthält weiterhin nur den **aktiven** Verein.
Ohne `verein_id` landet die Anmeldung im **Heimatverein** (`PATCH /ich {heimatverein_id}`, nur eigene freigegebene Vereine);
ohne Heimatverein und bei mehreren Vereinen → 409 `verein_waehlen`. `POST /auth/verein-wechseln {verein_id}` (Bearer) stellt ohne
Passwort neue Tokens für den anderen Verein aus und beendet die bisherige Anmeldung (nicht für Geräte-Anmeldungen). **Für Web veraltet:**
mit SSO wechselt die App den Verein im Client (siehe 6.1.9).

#### 6.1.9 Single Sign-on über alle Apps und Vereine

Vertrag: [`sso-entscheidung.md`](sso-entscheidung.md). Zusammenfassung der Umsetzung:

- **Eine Sitzung** (`sid` = `refresh_tokens.familie_id`) und **ein Token** für alle Apps und Vereine der Person. `vereine` enthält je
  Verein Rolle, Rechte, Mitglieder und `apps` (`schluessel → Scope`); es erscheinen nur Vereine, für die mindestens eine aktive App in
  `anwendung_vereine` freigegeben ist (dieselbe Tabelle wie beim Abgleich). `aud` = Vereinigung aller `apps`-Schlüssel. Ab 20 Vereinen fehlt
  `mitglied_ids` (`mitglied_ids_gekuerzt: true`).
- **Verein wechseln** geschieht im Client (`X-Verein`-Header der App, kein Aufruf hier). Die App prüft: `aud` enthält sie selbst, der Verein steht in
  `vereine` und die App in `vereine[v].apps`, sonst `403 verein_nicht_freigegeben`.
- **App wechseln**: Das Cookie `sd_refresh` gilt für alle Apps (gleiche Domain). `POST /oauth/token` (`grant_type=refresh_token`, `client_id` = Ziel-App,
  optional `?verein=<uuid>` für die Übergangs-Claims) erneuert die Sitzung für **jede** App; die Sitzung bleibt dieselbe (`sid`). Unbekannte/deaktivierte
  `client_id` → `401 unbekannte_anwendung`; fremder Verein in `?verein=` → `403 kein_zugang_zum_verein` (Anmeldung bleibt). Geräte-Tokens bleiben an ihre App gebunden.
- **Abmelden**: `POST /auth/logout` (Cookie oder `refresh_token`) widerruft die ganze `sid`; `{ "alle_geraete": true }` (Bearer) alle Web-/App-Sitzungen. Danach
  geht ein **Back-Channel-Logout** an jede aktive App des Benutzers mit `anwendungen.backchannel_url`: `POST` mit JSON `{ "logout_token": "<jwt>" }`; Header `typ: logout+jwt`,
  Claims `iss`, `sub`, `aud` = App, `sid`, `iat`, `exp` = +120 s, `jti`, `events`. 3 Versuche (Wartezeit `BACKCHANNEL_WARTEN_MS`, Standard `0,1000,3000`), danach wird
  aufgegeben. Geräte-Anmeldungen lösen keinen Back-Channel aus. Dasselbe passiert, wenn ein Refresh-Token wiederverwendet wird oder das Konto nicht mehr gilt.
- `GET /v1/anwendungen` (öffentlich): `[{ schluessel, name, url, icon }]` aller aktiven Apps mit gesetzter `url`, für den App-Umschalter.

#### 6.1.7 Server-zu-Server (client_credentials)

`POST /oauth/token` `grant_type=client_credentials` mit `client_id` + `client_secret` (Body oder HTTP Basic) → Access-Token
**ohne Benutzer und ohne Refresh-Token**: `sub = app:<schluessel>`, `aud` = App, `client: true`, `scope` = `anwendungen.client_scopes`
(Obergrenze für den Abgleich, nicht die Benutzer-Obergrenze), `lizenz_arten` = erlaubte Lizenzarten (`null` = alle), gültig 600 s.
Das Secret liegt nur als argon2id-Hash in `anwendungen.client_secret_hash`; neu erzeugen mit `npm run client:secret -- <app>`
(wird einmal angezeigt; die Demo-Apps bekommen `DEMO_CLIENT_SECRET`). Client-Tokens werden von Benutzer-Endpunkten (`/ich`,
`/benutzer` …) mit 403 abgewiesen. Welche Vereine eine App per Abgleich sehen darf, steht in `anwendung_vereine` (siehe 5.1).

#### 6.1.5 Vereinsgeräte (Hallen-Tablet, mehrere Personen)

Ein Admin registriert das Tablet einmal (`POST /geraete`, Scope `benutzer:verwalten`, gilt für die App im Token; `GET /geraete`,
`PATCH /geraete/{id}` `{gesperrt}`). Jede Person meldet sich einmal online mit `geraet.id` + `geraet_token: true` an und
bekommt ein **eigenes** Geräte-Token hinter ihrer eigenen PIN; die App führt eine Profilliste und filtert offline nach den
Claims des gewählten Profils. Neue Personen brauchen für die Erstanmeldung Netz; eine Sperre wirkt erst beim nächsten Refresh.

### 6.2 Eigenes Konto

| Methode | Pfad | Zweck | Daten |
|---|---|---|---|
| GET | `/ich` | Benutzer, Vereine, Rolle, Rechte, `mitglied_id`, `mitglied_ids`, wirksame Scopes | nur eigene |
| PATCH | `/ich` | `vorname`, `nachname`, `email` (setzt Bestätigung zurück), `passwort_neu` (+ `passwort_alt`), `pin` (+ `passwort_alt`; `null` entfernt) | Passwortwechsel beendet alle anderen Anmeldungen |
| DELETE | `/ich` | Konto löschen (Body `{passwort}`), Soft Delete; Anonymisierung nach Frist (`datenschutz_bereinigen()`) | |
| GET/POST/DELETE | `/ich/totp` | 2FA einrichten/entfernen | |
| GET | `/ich/auskunft` | DSGVO-Auskunft (nur Stammdaten-Portal) | vollständig |

### 6.3 Vereine, Verbände, Gruppen

| Methode | Pfad | Scope |
|---|---|---|
| GET | `/verbaende` | `vereine:lesen` |
| GET | `/vereine?q=` | `vereine:lesen` (`oeffentlich`, auch Nicht-Mandanten) |
| GET | `/vereine/{id}` | Feldgruppen nach `vereine:lesen`/`:kontakt`/`:finanzen` |
| POST, PATCH | `/vereine`, `/vereine/{id}` | `vereine:schreiben`; Anlegen von Mandanten nur Super-Admin |
| GET, PUT | `/vereine/{id}/logo` | lesen / `vereine:schreiben` |
| GET | `/gruppen` | `gruppen:lesen` (Mitglied: nur eigene Gruppen, ohne Mitgliederliste) |
| POST, PATCH, DELETE | `/gruppen`, `/gruppen/{id}` | `gruppen:schreiben` |
| PUT, DELETE | `/gruppen/{id}/mitglieder/{mitglied_id}` | `gruppen:schreiben` |

### 6.4 Mitglieder

| Methode | Pfad | Scope / Bemerkung |
|---|---|---|
| GET | `/mitglieder?status=&gruppe_id=&felder=` | Zeilen und Felder laut Abschnitt 4 |
| POST | `/mitglieder/suche` | Body `{ "q": "…" }`; nur mit `mitglieder:lesen` |
| GET | `/mitglieder/{id}` | 404 außerhalb des Zeilenfilters |
| POST, PATCH, DELETE | `/mitglieder`, `/mitglieder/{id}` | `mitglieder:schreiben`; PATCH nur Felder aus Gruppen, die der Aufrufer lesen darf |
| PATCH | `/mitglieder/{id}` | nur `{ "eintritt": "YYYY-MM-DD" }`, Scope `mitglieder:eintritt` (nur Dojo-Master-Pro) |
| PUT, GET, DELETE | `/mitglieder/{id}/passfoto` | **Upload per Formular** (`multipart/form-data`, Feld `datei`) oder direkt als `image/jpeg`/`png`/`webp`; max. 5 MB, Typ wird an den Dateikopf geprüft; ein aktives Foto je Mitglied (PUT ersetzt). Schreiben: `mitglieder:schreiben` oder eigenes Mitglied/Kind (`mitglieder:selbst`); Lesen: `mitglieder:person` oder eigenes. Ablage in `dokumente` (art `passfoto`), `Cache-Control: private, no-store` |
| POST | `/mitglieder/import?pruefen=true` | DJB-Portal-Export als **CSV (`text/csv`, „;“) oder xlsx** im Body, Scope `mitglieder:import` (Admin; in **allen** Apps erlaubt), Verein aus dem Token (Super-Admin: `?verein_id=`). Erkennt vorhandene Mitglieder über die DJB-ID (`ID`), aktualisiert nur nicht-leere Felder, legt Graduierungen (`n. Kyu/Dan … Nr./Datum`) und Lizenzen an. **Nicht übernommen** werden Kontoinhaber, IBAN, Abbuchungsintervall, Anmelde-Datum, Beitragsart, Bemerkung, führender Verein, Erste-Hilfe und Scans (Abrechnungs-Tool bzw. nicht zentral nötig). `pruefen=true` = Trockenlauf (alles wird zurückgerollt). Antwort: Zahlen, `fehler[]`/`warnungen[]` je Zeile (Zeilen mit Fehlern werden übersprungen) |
| GET, POST, PATCH, DELETE | `/mitglieder/{id}/graduierungen` | `graduierungen:lesen`/`:schreiben`; Mitglied im Kyu-Manager-Pro: eigene, gekürzt |
| GET, POST, PATCH, DELETE | `/mitglieder/{id}/lizenzen?art=` | Lizenzarten laut Obergrenze |
| GET | `/lizenzen/ablaufend?tage=60` | Ablaufwarnungen, gleiche Filter |
| GET, POST, DELETE | `/mitglieder/{id}/dokumente`, `/dokumente/{id}/inhalt` | `mitglieder:verwaltung` bzw. eigene |
| GET, POST, PATCH | `/mitglieder/{id}/fuehrungszeugnis` | `mitglieder:efz`, protokolliert |
| PUT, DELETE | `/mitglieder/{id}/erziehungsberechtigte/{benutzer_id}` | `benutzer:verwalten` |

### 6.5 Zahler und Mandate – entfallen

Siehe 2.3: liegt im Abrechnungs-Tool.

### 6.6 Benutzer und Rechte (Vereinsverwaltung)

| Methode | Pfad | Scope |
|---|---|---|
| GET | `/benutzer` | `benutzer:verwalten` – Benutzer des aktiven Vereins |
| POST | `/einladungen` | E-Mail, Rolle, Rechte, optional `mitglied_id` |
| GET | `/beitrittsanfragen` | offene `benutzer_vereine` |
| POST | `/beitrittsanfragen/{id}/freigeben`, `/ablehnen` | |
| PATCH | `/mitgliedschaften/{id}` | Rolle, Status (sperren), verknüpftes Mitglied |
| PUT, DELETE | `/benutzer/{id}/rechte/{schluessel}` | **Umgesetzt.** `rechte:verwalten` (Admin), im Verein des Tokens; Ziel braucht eine freigegebene Zugehörigkeit (sonst `404 benutzer_unbekannt`), Recht muss in `rechte` existieren (`404 recht_unbekannt`); eigenes Konto und Super-Admins `403 konto_geschuetzt`. PUT-Body (optional): `gueltig_von`, `gueltig_bis`, `attribute`; idempotent (200), belebt weich gelöschte Einträge. DELETE löscht weich (204, idempotent). Bestehende Anmeldungen bleiben, der nächste Refresh lädt die Rechte neu |
| GET | `/audit?tabelle=&datensatz_id=` | Admin |

**Schüler-Zugänge durch Trainer** (Kyu-Manager-Pro, Lücken 2 und 3) – Scope `benutzer:schueler` (Trainer, Admin):

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/benutzer` | `{ benutzername, vorname?, nachname?, email?, mitglied_id? }` → Konto mit Rolle `mitglied` im aktiven Verein, sofort freigegeben, **Startpasswort** (10 Zeichen, einmalig in der Antwort), `muss_passwort_aendern = true`. E-Mail optional (Kinder). |
| POST | `/benutzer/{id}/passwort-zuruecksetzen` | neues Startpasswort, Wechselpflicht; beendet alle Anmeldungen, entwertet die PIN, hebt die Sperre auf |

Schutzregeln beim Zurücksetzen: nie Super-Admins und nie Konten mit Zugehörigkeit zu **mehr als einem Verein**; ein Trainer
nur Konten mit Rolle `mitglied` **ohne Rechte** (keine Prüfer, Trainer, Admins); nicht das eigene Konto; Konten anderer
Vereine antworten mit 404. Ein Admin (`benutzer:verwalten`) darf zusätzlich Trainer/Prüfer seines Vereins zurücksetzen.

Trainer und Prüfer sehen keine Benutzerliste. Wer „Trainer meiner Gruppe“ anzeigen will, bekommt dafür einen
schmalen Endpunkt (siehe offene Punkte).

### 6.7 Betreiber (Super-Admin)

`/admin/vereine` (Freischaltung, Mandant ja/nein) · `/admin/anwendungen` (Obergrenzen, Secrets, Redirect-URIs) ·
`/admin/aufbewahrungsfristen` · `/admin/signaturschluessel/rotieren`. Alle Aufrufe mit 2FA.

---

## 7. Änderungen am Datenbankentwurf (umgesetzt)

Umgesetzt in [`db/schema.sql`](../db/schema.sql) und [`datenbankentwurf.md`](datenbankentwurf.md):

1. Scope-Tabelle in `datenbankentwurf.md` 2.4 entspricht Abschnitt 3.
2. `anwendungen.scopes` ist die Obergrenze für Benutzer-Tokens; neu `anwendungen.client_scopes` (Abgleich ohne
   Benutzer, per Check Teilmenge von `scopes`) und `anwendungen.lizenz_arten text[]` (`null` = alle Arten).
   Seed: Hajime-Pro nur `judopass` und `wettkampflizenz`, Kyu-Manager-Pro nur `judopass`, `graduierungslizenz` und
   `pruefer_lizenz`, Dojo-Master-Pro alle.
3. Token-Claim `mitglied_ids` (eigenes Mitglied + Kinder) steht im Ablauf der Autorisierung (`datenbankentwurf.md` 2.4).

---

## 8. Offene Punkte

1. **Trainer nur für eigene Gruppen?** Strenger wäre: Trainer sehen `person`/`kontakt` nur von Mitgliedern ihrer
   Gruppen. Dafür fehlt eine Zuordnung Trainer ↔ Gruppe (z. B. `benutzer_rechte.attribute.gruppen`).
2. **Eltern-Zugang ab 18**: Endet die Sicht der Eltern automatisch mit Volljährigkeit des Kindes?
3. **„Wer trainiert meine Gruppe?“** Soll ein Mitglied Namen der Trainer seiner Gruppen sehen? Wenn ja, nur
   `vorname`, `nachname` aus `benutzer`, nichts weiter.
4. **Geburtsdatum vs. Alter**: Hajime-Pro bräuchte für Altersklassen nur den Jahrgang. Reicht `geburtsjahr` statt
   `geburtsdatum` als eigene, kleinere Feldgruppe?
5. **Kassierer im Kyu-Manager-Pro/Hajime-Pro**: Braucht er dort überhaupt Mitgliederlisten, oder nur `mitglieder:selbst`?
