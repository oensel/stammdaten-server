# Betrieb auf dem VPS

Stack: `docker compose` mit `db` (postgres:18), `api` (Port 4000, `node src/server.js`) und `worker` (gleiches Image, `node src/worker.js`, versendet Mails). Ziele: RTO 4 h, RPO 24 h (AD-13).

## Start

1. `.env.prod` anlegen (Vorlage `.env.example`, `NODE_ENV=production`, `HOST=0.0.0.0`, `DATABASE_URL=postgres://stammdaten:<DB_PASSWORD>@db:5432/stammdaten`). `DB_PASSWORD` zusätzlich in der Shell bzw. in `.env` neben `docker-compose.yml` setzen.
2. `docker compose build` (bei jedem Update zuerst, sonst migriert das alte Image), `docker compose up -d db`, danach `docker compose run --rm --no-deps api node scripts/migrieren.mjs` (nur Migrationen und Schlüssel; nie `setup.mjs`, das lädt Demodaten). Nach jedem Update erneut ausführen; API und Worker starten nicht, solange Migrationen ausstehen.
3. `docker compose up -d --build`. Prüfen: `curl http://127.0.0.1:4000/health`, `docker compose logs worker` zeigt „gestartet".

PostgreSQL 18 speichert unter `/var/lib/postgresql/18/docker`; das Volume hängt deshalb an `/var/lib/postgresql`.

## Sicherung einrichten

1. `age` installieren: `sudo apt-get install age`.
2. Schlüsselpaar **auf dem Rechner des Betreibers** erzeugen, nicht auf dem VPS: `age-keygen -o stammdaten-sicherung.key`. Den privaten Schlüssel offline aufbewahren (z. B. Passwortmanager + Ausdruck).
3. Nur den öffentlichen Schlüssel auf den VPS: `age-keygen -y stammdaten-sicherung.key > /etc/stammdaten/sicherung.pub`.
4. cron-Eintrag (täglich 03:00; später 10/16/22 Uhr):

   ```
   PATH=/usr/local/bin:/usr/bin:/bin
   0 3 * * * cd /opt/stammdaten-server && SICHERUNG_AGE_EMPFAENGER=/etc/stammdaten/sicherung.pub SICHERUNG_VERZEICHNIS=/var/backups/stammdaten scripts/sicherung.sh >> /var/log/stammdaten-sicherung.log 2>&1
   ```

`scripts/sicherung.sh` pipet `pg_dump -Fc` direkt in `age`; es entsteht nie eine unverschlüsselte Datei. Dateien älter als 30 Tage (`SICHERUNG_AUFBEWAHRUNG_TAGE`) werden entfernt.

**Offen:** Die Übertragung außerhalb des VPS fehlt noch; die Sicherung liegt verschlüsselt im lokalen Verzeichnis. Ein externes Ziel ersetzt später nur die Funktion `ablegen` im Skript.

## Wiederherstellung im Ernstfall

Auf einem leeren Stack (neues Volume, `api` und `worker` gestoppt; vorher `docker compose build` mit dem passenden Codestand):

1. `docker compose up -d --wait db`
2. Sicherung einspielen: `age -d -i /root/probe.key <datei>.dump.age | docker compose exec -T db pg_restore -U stammdaten -d stammdaten --no-owner --exit-on-error`
3. `docker compose run --rm --no-deps api node scripts/migrieren.mjs`
4. **Pflicht vor dem Start:** `docker compose exec -T db psql -U stammdaten -d stammdaten -c 'select abgleich_neu_beginnen()'`. Ohne diesen Schritt liefert der Abgleich Bestandsdaten nicht aus. Danach gleichen alle Apps einmal vollständig neu ab (`409 abgleich_neu_starten`).
5. `docker compose up -d api worker`, `/health` prüfen, privaten Schlüssel entfernen.

## Restore-Probe (SYS-OPS-001)

Mindestens quartalsweise und nach Änderungen am Stack:

1. Privaten Schlüssel nur für die Probe auf den VPS holen (z. B. `/root/probe.key`, `chmod 600`).
2. `WIEDERHERSTELLUNG_SCHLUESSEL=/root/probe.key scripts/wiederherstellung.sh` (ohne Argument die neueste Sicherung, sonst Datei angeben). Das Skript legt die Datenbank `restore_probe` (`WIEDERHERSTELLUNG_DB`; `stammdaten` und Systemdatenbanken werden abgewiesen) leer neu an, spielt die Sicherung ein, protokolliert auch Fehlschläge und löscht die Kopie danach wieder (`WIEDERHERSTELLUNG_BEHALTEN=ja` lässt sie stehen).
3. Protokoll prüfen: `restore-probe.log` im Sicherungsverzeichnis erhält eine Zeile mit Start, Dauer, Alter der Sicherung, Ergebnis und Zeilenzahl je Tabelle. Exit ≠ 0, wenn die Sicherung älter als 24 h oder die Dauer über 4 h liegt.
4. Zeilenzahlen mit der Produktivdatenbank vergleichen, danach den privaten Schlüssel vom VPS entfernen.

Die CI (Job `betrieb`) prüft Skripte und Ablauf mit Demodaten; sie ersetzt die Probe auf dem VPS nicht.
