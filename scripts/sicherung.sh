#!/usr/bin/env bash
# Tägliche Sicherung: pg_dump -Fc aus dem db-Container, direkt mit age verschlüsselt (nie unverschlüsselt auf Platte).
# Aufruf im Repo-Verzeichnis auf dem VPS, z. B. per cron (siehe docs/betrieb.md).
#   SICHERUNG_VERZEICHNIS      Zielverzeichnis (Standard /var/backups/stammdaten)
#   SICHERUNG_AGE_EMPFAENGER   Datei mit öffentlichem age-Schlüssel (Pflicht)
#   SICHERUNG_AUFBEWAHRUNG_TAGE Aufbewahrung in Tagen (Standard 30)
#   SICHERUNG_DB / SICHERUNG_DB_BENUTZER  Datenbank und Benutzer im Container (Standard stammdaten)
set -euo pipefail
umask 077

VERZ="${SICHERUNG_VERZEICHNIS:-/var/backups/stammdaten}"
EMPF="${SICHERUNG_AGE_EMPFAENGER:?SICHERUNG_AGE_EMPFAENGER fehlt (Datei mit öffentlichem age-Schlüssel)}"
TAGE="${SICHERUNG_AUFBEWAHRUNG_TAGE:-30}"
DB="${SICHERUNG_DB:-stammdaten}"
BEN="${SICHERUNG_DB_BENUTZER:-stammdaten}"

[[ "$TAGE" =~ ^[1-9][0-9]*$ ]] || { echo "SICHERUNG_AUFBEWAHRUNG_TAGE ungültig: $TAGE" >&2; exit 1; }
[ -r "$EMPF" ] || { echo "Empfängerdatei $EMPF nicht lesbar" >&2; exit 1; }
command -v age >/dev/null || { echo "age ist nicht installiert" >&2; exit 1; }
mkdir -p "$VERZ"

zeit=$(date -u +%Y%m%dT%H%M%SZ)
name="stammdaten-$zeit.dump.age"
teil="$VERZ/.$name.teil"
trap 'rm -f "$teil"' EXIT

# Übertragung an das Ziel. Austauschbar: ein externes Ziel (z. B. rclone/scp) ersetzt später nur diese Funktion.
ablegen() { # $1 = fertige verschlüsselte Datei, $2 = Zielname
  mv "$1" "$VERZ/$2"
}

docker compose exec -T db pg_dump -Fc -U "$BEN" -d "$DB" | age -R "$EMPF" -o "$teil"
[ -s "$teil" ] || { echo "Sicherung leer" >&2; exit 1; }
ablegen "$teil" "$name"

find "$VERZ" -maxdepth 1 -name 'stammdaten-*.dump.age' -type f -mtime +"$((TAGE - 1))" -delete
echo "Sicherung abgelegt: $VERZ/$name"
