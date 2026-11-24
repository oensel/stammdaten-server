<!-- bmad:context -->
<!-- Verified 2026-11-24 against 9047fed. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## Stammdaten-Server

Zentraler Dienst des Judo-Software-Verbunds für Anmeldung (SSO, JWKS), Verbandsbaum, Personen, Rechte, Graduierungen, Lizenzen, Finanzen und den Abgleich der Fachanwendungen (Kyu-Manager Pro, Dojo Master Pro, Hajime Pro). Node/Fastify, PostgreSQL 18, Vitest. Planung im Workspace: `../_bmad-output/` (Spine `planning-artifacts/architecture/architecture-stammdaten-server-2026-11-23/ARCHITECTURE-SPINE.md`, `specs/spec-stammdaten-server/SPEC.md`, `planning-artifacts/epics.md`, Test-Design `test-artifacts/`).

## Policy

- Nie direkt auf `main` arbeiten; je Story ein Branch `story/<nr>-<kurzname>`, Abschluss per PR.
- Nie Geheimnisse committen: `.env`, `.env.prod`, Schlüssel, Client-Secrets. Neue Konfiguration bekommt einen Platzhalter in `.env.example`.
- Nie einen Abzug aus Hajime Pro oder anderen Produktivdaten ins Repo legen, auch nicht anonymisiert. Er liegt nur lokal bzw. in der CI-Umgebung.
- `/v1`-Endpunkte sind eingefroren: Antworten bleiben vertragsgleich. Neue Endpunkte nur unter `/v2`.
- Der Vertrag in `../judo-common` ändert sich nur additiv, mit erhöhter `stammdaten/contract/VERSION`; der Server wird vor dem Paket ausgerollt.
- Eine Entscheidung aus dem Spine (AD-1 bis AD-14) weicht nicht stillschweigend ab: Widerspruch melden statt umgehen.

## Where things are

- Umsetzung nach Story: Akzeptanzkriterien in `../_bmad-output/planning-artifacts/epics.md`; die Story nennt ihre FRs, ADs und SYS-Testfälle.
- Schema: `db/schema.sql` als Basis plus `db/migrations/NNN_name.sql`, aufsteigend angewendet von `src/migrate.js`. Neue Änderungen nur als neue Migration; bestehende Migrationen nie ändern.
- Fachentwürfe: `docs/` (API, Datenbank, Finanzen, Lehrgänge, Kalender, Rollen/Rechte/Lizenzen, SSO).

## Running and verifying

- Entwicklung nur unter Windows; Befehle in PowerShell.
- `npm test` startet ein eigenes Wegwerf-PostgreSQL (Port 54330) und braucht keine laufende Dev-Datenbank; nie gegen die Dev-Datenbank in `.pgdata-dev` testen.
- Die Suite dauert ca. 1 Minute; beim Iterieren einzelne Dateien laufen lassen: `npx vitest run test/<datei>.test.js`.
- Dev-Server: zuerst `npm run db` (Port 5440, läuft im Vordergrund), einmalig `npm run db:setup`, dann `npm start` (Port 4000).
- Eine Story ist erst fertig, wenn `npm test` vollständig grün ist; CI (`.github/workflows/ci.yml`) prüft zusätzlich, dass keine `.env`-, Dump- oder Abzugsdateien getrackt sind.

## Conventions that differ from defaults

- Bezeichner, Kommentare, Fehlermeldungen und Commit-Messages auf Deutsch.
- Zielstruktur (AD-1): je Fachmodul `src/<modul>/` mit `routen.js`, `dienst.js`, `daten.js`, `tabellen.js`. Ein Modul liest fremde Tabellen nie direkt, sondern ruft den Dienst des anderen Moduls. Bis Story 1.1 umgesetzt ist, liegt der Altcode in `src/routes/`.
- Dienstfunktionen haben die Form `fn(ctx, db, args)`; `ctx` = `{benutzer, kontext, rechte, anwendung, jetzt}`, Jobs nutzen `systemCtx(name)`. Nie `new Date()` im Dienst, sondern `ctx.jetzt`.
- Rechte prüft `darf()` im Code, nicht die Datenbank. Kein Zugriff auf eine Person unter `/v2` liefert 404, nie 403.
- Forderungen schreibt nur das Modul `finanzen` (`forderungErzeugen`, `forderungStornieren`, `forderungErstatten`, `forderungStatus`).
- Audit wird im Code in derselben Transaktion geschrieben; jede auditpflichtige Aktion (NFR-18) bekommt einen Test, der den Audit-Eintrag prüft.
- `change_seq`/`change_xid` setzt der Trigger `stammdaten_touch`; nie von Hand setzen.
- Hintergrundjobs laufen im Worker mit Advisory-Lock, nie im Web-Prozess.

<!-- /bmad:context -->
