#!/usr/bin/env bash
# Restore-Probe (SYS-OPS-001): Sicherung entschlüsseln, in eine leere Datenbank einspielen, Ergebnis protokollieren.
#   scripts/wiederherstellung.sh [sicherungsdatei]   (ohne Angabe: neueste im Sicherungsverzeichnis)
#   WIEDERHERSTELLUNG_SCHLUESSEL  Datei mit privatem age-Schlüssel (Pflicht; nur für die Probe auf den Rechner holen)
#   WIEDERHERSTELLUNG_DB          Ziel-Datenbank im db-Container, wird leer neu angelegt (Standard restore_probe)
#   SICHERUNG_VERZEICHNIS         Sicherungsverzeichnis (Standard /var/backups/stammdaten)
#   RESTORE_PROTOKOLL             Protokolldatei (Standard $SICHERUNG_VERZEICHNIS/restore-probe.log)
# Exit ≠ 0, wenn der Restore scheitert, die Sicherung älter als 24 h ist oder die Dauer 4 h übersteigt (RPO/RTO).
set -euo pipefail

VERZ="${SICHERUNG_VERZEICHNIS:-/var/backups/stammdaten}"
SCHL="${WIEDERHERSTELLUNG_SCHLUESSEL:?WIEDERHERSTELLUNG_SCHLUESSEL fehlt (privater age-Schlüssel)}"
ZIEL="${WIEDERHERSTELLUNG_DB:-restore_probe}"
BEN="${SICHERUNG_DB_BENUTZER:-stammdaten}"
PROT="${RESTORE_PROTOKOLL:-$VERZ/restore-probe.log}"
RPO_SEK=$((24 * 3600)); RTO_SEK=$((4 * 3600))

datei="${1:-$(ls -1 "$VERZ"/stammdaten-*.dump.age 2>/dev/null | sort | tail -n 1 || true)}"
[ -n "$datei" ] && [ -r "$datei" ] || { echo "Keine Sicherung gefunden" >&2; exit 1; }
[[ "$ZIEL" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Ungültiger Datenbankname $ZIEL" >&2; exit 1; }
case "$ZIEL" in stammdaten|postgres|template0|template1) echo "Ziel-Datenbank $ZIEL ist verboten (würde Produktiv- oder Systemdaten löschen)" >&2; exit 1;; esac
BEHALTEN="${WIEDERHERSTELLUNG_BEHALTEN:-nein}"

# Alter aus dem Zeitstempel im Dateinamen (stammdaten-YYYYmmddTHHMMSSZ.dump.age)
ts=$(basename "$datei" | sed -E 's/^stammdaten-([0-9]{8})T([0-9]{2})([0-9]{2})([0-9]{2})Z\.dump\.age$/\1 \2:\3:\4/')
erstellt=$(date -u -d "$ts" +%s) || { echo "Zeitstempel im Dateinamen unlesbar" >&2; exit 1; }
start=$(date -u +%s); start_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)

psql_db() { docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$BEN" -At "$@"; }
protokoll() { # $1 = ergebnis, $2 = zeilen
  mkdir -p "$(dirname "$PROT")"
  local z="start=$start_iso datei=$(basename "$datei") dauer_s=$(( $(date -u +%s) - start )) alter_s=$((start - erstellt)) ergebnis=$1 zeilen=$2"
  echo "$z" >> "$PROT"; echo "$z"
}
aufraeumen() { [ "$BEHALTEN" = ja ] || psql_db -d postgres -c "drop database if exists $ZIEL" >/dev/null || true; }
fehlschlag() { protokoll "nicht_bestanden(restore)" ""; aufraeumen; exit 1; }

psql_db -d postgres -c "drop database if exists $ZIEL" -c "create database $ZIEL" || fehlschlag
age -d -i "$SCHL" "$datei" | docker compose exec -T db pg_restore --no-owner -U "$BEN" -d "$ZIEL" --exit-on-error || fehlschlag

ende=$(date -u +%s)
dauer=$((ende - start)); alter=$((start - erstellt))
zeilen=$(psql_db -d "$ZIEL" -c "select string_agg(table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text, ',' order by table_name) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'") || zeilen=""

gruende=()
[ "$alter" -le "$RPO_SEK" ] || gruende+=("alter>24h")
[ "$dauer" -le "$RTO_SEK" ] || gruende+=("dauer>4h")
[ -n "$zeilen" ] || gruende+=("leer")
if [ ${#gruende[@]} -eq 0 ]; then ergebnis=bestanden; else ergebnis="nicht_bestanden($(IFS=+; echo "${gruende[*]}"))"; fi

protokoll "$ergebnis" "$zeilen"
aufraeumen   # die Kopie enthält Personendaten; WIEDERHERSTELLUNG_BEHALTEN=ja lässt sie zur Prüfung stehen
[ "$ergebnis" = bestanden ]
