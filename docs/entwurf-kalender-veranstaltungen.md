# Entwurf: Kalender, Veranstaltungen und Turniere

Stand: 2026-11-21 · Status: **Entwurf** · Projekt: Stammdaten-Server (Schnittstelle zu Hajime Pro)
Teil von [entwurf-rollen-rechte-lizenzen.md](entwurf-rollen-rechte-lizenzen.md); Begriffe, Rechte-Modell und Kontext
stehen dort. Lehrgänge: [entwurf-lehrgaenge.md](entwurf-lehrgaenge.md). Gebühren und Einzug:
[entwurf-finanzen.md](entwurf-finanzen.md). Abschnitte tragen die Nummer 9b; Entscheidungen beginnen bei E90.

---

## 9b. Kalender, Turniere und Veranstaltungen

### 9b.1 Überblick

Der Stammdaten-Server führt einen **zentralen Kalender** aller Termine im DJB. Er enthält:

| Terminart | Tabelle | Wer stellt ein | Freigabe nötig |
|---|---|---|---|
| Lehrgang | `lehrgaenge` (9a) | jeder angemeldete Benutzer | **ja**, je Ebene (E68, E80) |
| Dan-Prüfung | `pruefungen` (9) | Bezirks-Dan-Beauftragter, Dan-Prüfungsorganisation des Landesverbands | keine eigene Freigabe; anlegen dürfen nur diese Stellen (E105) |
| Prüfung zum 1. Kyu | `pruefungen` (9) | Kreis-Dan-Vorsitzender | keine; sichtbar auf Kreisebene |
| Kyu-Prüfung 8.–2. Kyu | – | – | **nicht im Kalender** (vereinsintern, E94) |
| Turnier | `turniere` (9b.3) | **jeder** angemeldete Benutzer | nein; Veranstalter wählt Veröffentlichung |
| Sonstige Veranstaltung | `veranstaltungen` (9b.3) | **jeder** angemeldete Benutzer | nein; Veranstalter wählt Veröffentlichung |

Die Arten bleiben **getrennte Tabellen** (E91). Der Kalender ist eine gemeinsame Sicht über alle.

---

### 9b.2 Veröffentlichung und Kalender

**Sichtbarkeit.** Bei Turnieren und sonstigen Veranstaltungen wählt der Veranstalter selbst, wer den Termin sieht, und
gibt ihn selbst frei (E90):

| `sichtbarkeit` | `sichtbar_fuer_verband_id` | Sichtbar für |
|---|---|---|
| `einladung` | leer | nur eingeladene Vereine bzw. Personen (9b.4) |
| `verband` | ein Kreis, Bezirk oder Landesverband | alle Benutzer mit einer Mitgliedschaft oder Rolle in diesem Verband bzw. Teilbaum |
| `djb` | leer | alle |

Der Sichtbarkeitsbereich muss den Veranstalter enthalten (Serverprüfung `liegt_unter(Veranstalter,
sichtbar_fuer_verband_id)`): Ein Verein im Kreis X kann „Kreis X“, „Bezirk von X“, „Land“ oder „DJB“ wählen, aber
keinen fremden Kreis. Die Kalendersichtbarkeit ist **kontextunabhängig** (11.1 gilt nur für Personendaten). Bei
Lehrgängen bleibt die Freigabe Pflicht; der Teilnehmerkreis (`offen_fuer_verband_id`) bestimmt dort zugleich die
Sichtbarkeit. Prüfungen sind nie `einladung`.

**Filter im Kalender:** DJB, Landesverband, Bezirk, Kreis (über `verband_pfade`), dazu Terminart, Zeitraum und „nur
Termine, für die ich die Voraussetzungen erfülle“. Abgesagte Termine bleiben sichtbar und sind markiert.

```sql
create view kalender as                       -- gemeinsame Sicht, je Zeile ein Termin
  select 'lehrgang'::text as art, id, titel, beginn, ende, ort, offen_fuer_verband_id as sichtbar_fuer_verband_id,
         case when offen_fuer_verband_id = (select id from verbaende where uebergeordnet_id is null)
              then 'djb' else 'verband' end as sichtbarkeit, status
    from lehrgaenge where status in ('ausgeschrieben','abgesagt','durchgefuehrt','abgeschlossen')
  union all
  select 'pruefung_' || art, id, coalesce(titel, case when art = 'dan' then 'Dan-Prüfung' else 'Prüfung zum 1. Kyu' end),
         datum::timestamptz, (datum + 1)::timestamptz, ort, sichtbar_fuer_verband_id, sichtbarkeit, status
    from pruefungen
   where (art = 'dan' or ist_1_kyu_pruefung)        -- Kyu 8.–2. erscheinen nicht (E94)
     and datum is not null and status <> 'korrigiert'
  union all
  select 'turnier', id, titel, beginn, ende, ort, sichtbar_fuer_verband_id, sichtbarkeit, status from turniere
         where status <> 'entwurf'
  union all
  select 'veranstaltung', id, titel, beginn, ende, ort, sichtbar_fuer_verband_id, sichtbarkeit, status from veranstaltungen
         where status <> 'entwurf';
-- Sichtbarkeit je Benutzer prüft der Server (Kreis bzw. Einladung); die Sicht liefert nur Kandidaten.

-- Ergänzung zu pruefungen (Kerndokument 9.2; ist_1_kyu_pruefung und titel stehen dort):
alter table pruefungen
  add column sichtbarkeit text not null default 'verband' check (sichtbarkeit in ('verband','djb')),
  add column sichtbar_fuer_verband_id uuid references verbaende,   -- Standard: Träger der Prüfung (Kreis, Bezirk, Land)
  add check (sichtbarkeit = 'djb' or sichtbar_fuer_verband_id is not null);
```

---

### 9b.3 Turniere und sonstige Veranstaltungen

```sql
create table turniere (
  id uuid primary key,
  veranstalter_verein_id  uuid references vereine,
  veranstalter_verband_id uuid references verbaende,
  titel text not null, beschreibung text, ausschreibung_dokument_id uuid references dokumente,
  beginn timestamptz not null, ende timestamptz not null, ort text,
  sichtbarkeit text not null check (sichtbarkeit in ('einladung','verband','djb')),
  sichtbar_fuer_verband_id uuid references verbaende,       -- Pflicht bei 'verband'
  meldeschluss timestamptz, max_meldungen int check (max_meldungen is null or max_meldungen > 0),
  startgeld_cent int not null default 0 check (startgeld_cent >= 0),   -- je Einzel- bzw. Mannschaftsmeldung (E92)
  hajime_turnier_ref text,                                  -- Kennung in Hajime Pro, sobald dort angelegt
  status text not null default 'entwurf'
         check (status in ('entwurf','veroeffentlicht','meldeschluss','durchgefuehrt','abgesagt')),
  angelegt_von uuid not null references benutzer,
  check (num_nonnulls(veranstalter_verein_id, veranstalter_verband_id) = 1),
  check ((sichtbarkeit = 'verband') = (sichtbar_fuer_verband_id is not null)),
  check (ende >= beginn),
  check (meldeschluss is null or meldeschluss <= beginn)
);
create table turnier_klassen (                 -- Alters- und Gewichtsklassen bzw. Wettbewerbe
  id uuid primary key,
  turnier_id uuid not null references turniere on delete cascade,
  bezeichnung text not null,                   -- z. B. „U15 männlich -46 kg“, „Mannschaft Frauen“
  einzel boolean not null default true,        -- false = Mannschaftswettbewerb
  jahrgang_von int, jahrgang_bis int, geschlecht char(1),
  min_rang smallint, max_rang smallint,        -- Graduierung (Rangskala aus 7)
  gewicht_bis numeric(5,1),
  unique (id, turnier_id)
);
create table turnier_meldungen (               -- Einzelmeldungen
  id uuid primary key,
  turnier_id uuid not null references turniere,
  klasse_id  uuid not null,
  foreign key (klasse_id, turnier_id) references turnier_klassen (id, turnier_id),   -- Klasse dieses Turniers
  person_id  uuid not null references personen,
  verein_id  uuid not null references vereine,             -- Verein, für den gestartet wird (= fuer_verein_id des Startrechts)
  zahler text not null default 'verein' check (zahler in ('verein','person')),   -- Selbstmeldung: Person (E95)
  lizenz_id  uuid references lizenzen,                     -- geprüftes Einzelstartrecht
  quelle text not null check (quelle in ('stammdaten','hajime')),   -- wo gemeldet wurde (E93)
  hajime_meldung_ref text unique,                          -- Idempotenzschlüssel für Meldungen aus Hajime
  platzierung smallint check (platzierung > 0),            -- aus Hajime Pro nach dem Turnier (E110)
  status text not null default 'gemeldet'
         check (status in ('gemeldet','warteliste','abgemeldet','gestartet','nicht_angetreten')),
  gemeldet_von uuid references benutzer, gemeldet_am timestamptz not null default now()
);
create unique index meldung_je_person on turnier_meldungen (turnier_id, person_id)
  where status <> 'abgemeldet';                    -- je Turnier eine Einzelmeldung; Neumeldung nach Abmeldung möglich
-- Serverprüfung: Klasse hat einzel = true; Startrecht gilt für verein_id und ist am Turniertag gültig

create table veranstaltungen (                -- sonstige Termine: Sitzung, Kampfrichterschulung, Vereinsfest …
  id uuid primary key,
  veranstalter_verein_id  uuid references vereine,
  veranstalter_verband_id uuid references verbaende,
  kategorie text,                             -- frei, z. B. 'sitzung', 'schulung', 'fest'
  titel text not null, beschreibung text,
  beginn timestamptz not null, ende timestamptz not null, ort text,
  sichtbarkeit text not null check (sichtbarkeit in ('einladung','verband','djb')),
  sichtbar_fuer_verband_id uuid references verbaende,
  mit_anmeldung boolean not null default true,
  anmeldeschluss timestamptz, max_teilnehmer int check (max_teilnehmer is null or max_teilnehmer > 0),
  gebuehr_cent int not null default 0 check (gebuehr_cent >= 0),   -- zahlt die Person privat (E92)
  check (mit_anmeldung or gebuehr_cent = 0),               -- ohne Anmeldung keine Gebühr
  mindestalter_jahre int, min_rang smallint,               -- einfache Voraussetzungen
  status text not null default 'entwurf'
         check (status in ('entwurf','veroeffentlicht','abgesagt','durchgefuehrt')),
  angelegt_von uuid not null references benutzer,
  check (num_nonnulls(veranstalter_verein_id, veranstalter_verband_id) = 1),
  check ((sichtbarkeit = 'verband') = (sichtbar_fuer_verband_id is not null)),
  check (ende >= beginn),
  check (anmeldeschluss is null or anmeldeschluss <= beginn)
);
create table veranstaltung_anmeldungen (
  id uuid primary key,
  veranstaltung_id uuid not null references veranstaltungen,
  person_id uuid not null references personen,
  angemeldet_von uuid not null references benutzer,
  status text not null default 'angemeldet'
         check (status in ('angemeldet','warteliste','abgemeldet','teilgenommen','nicht_erschienen')),
  angemeldet_am timestamptz not null default now(),
  unique (veranstaltung_id, person_id)
);
```

**Verwalten:** Der Ersteller des Termins und die Admins des Veranstalters (Verein bzw. Verband) pflegen ihn: Daten
ändern, absagen, Klassen anlegen, Teilnehmer- bzw. Meldeliste einsehen und exportieren, Anwesenheit erfassen,
Teilnehmer abmelden. Weitere Helfer kann der Veranstalter als **Organisatoren** eintragen (`termin_organisatoren`).
Teilnehmerlisten zeigen Name, Verein, Jahrgang, Grad – **keine Kontaktdaten** (wie bei Lehrgängen).

**Absage:** Wird ein Turnier oder eine Veranstaltung abgesagt, storniert der Server alle offenen Startgelder bzw.
Gebühren; bereits gezahlte werden erstattet. Der Status `meldeschluss` wird zum Meldeschluss automatisch gesetzt und
kann vom Veranstalter vor Turnierbeginn wieder auf `veroeffentlicht` zurückgesetzt werden (Meldeschluss verlängert).

```sql
create table termin_organisatoren (
  termin_art text not null check (termin_art in ('turnier','veranstaltung','lehrgang')),
  termin_id  uuid not null,
  benutzer_id uuid not null references benutzer,
  primary key (termin_art, termin_id, benutzer_id)
);
-- termin_id ist polymorph: ein Trigger prüft die Existenz in der Tabelle der termin_art; beim Löschen bzw. Absagen
-- eines Termins werden Organisatoren und Einladungen mit entfernt
```

---

### 9b.3a Mannschaften (Liga und Turniere)

Mannschaften sind eigene Objekte (E96). Sie gehören einem Verein (bzw. einer Startgemeinschaft), gelten je Saison und
werden für **Ligen** und **Mannschaftsturniere** gemeldet. Wer in einer Mannschaft startet, braucht ein gültiges
**Mannschaftsstartrecht** (6.4) für den Verein der Mannschaft.

```sql
create table mannschaften (
  id uuid primary key,
  verein_id uuid not null references vereine,             -- führender Verein (bei Startgemeinschaft: Meldeverein)
  name text not null,                                     -- z. B. „JC Musterstadt I“
  saison text not null,                                   -- wie lizenzen.saison
  klasse text,                                            -- z. B. „Frauen“, „U18 männlich“
  liga text,                                              -- Liga bzw. Staffel, falls Ligamannschaft
  unique (verein_id, name, saison)
);
create table mannschaft_vereine (              -- weitere Vereine einer Startgemeinschaft
  mannschaft_id uuid not null references mannschaften on delete cascade,
  verein_id     uuid not null references vereine,
  primary key (mannschaft_id, verein_id)
);                                              -- Serverprüfung: nicht der führende Verein selbst
create table mannschaft_mitglieder (
  id uuid primary key,
  mannschaft_id uuid not null references mannschaften on delete cascade,
  person_id     uuid not null references personen,
  lizenz_id     uuid references lizenzen,                 -- Mannschaftsstartrecht; Pflicht bei rolle kaempfer/ersatz
  rolle text not null default 'kaempfer' check (rolle in ('kaempfer','ersatz','betreuer','trainer')),
  von date not null, bis date,                            -- Wechsel während der Saison (E22); Wiedereintritt = neue Zeile
  check (bis is null or bis >= von),
  check (rolle in ('betreuer','trainer') or lizenz_id is not null),
  exclude using gist (mannschaft_id with =, person_id with =, daterange(von, coalesce(bis, 'infinity'), '[]') with &&)
);
-- Trigger: lizenz_id gehört zu person_id, ist Art wettkampf_mannschaft, saison = Mannschaftssaison und fuer_verein_id
-- ist der Mannschaftsverein oder ein Verein der Startgemeinschaft. Eine Person kämpft je Saison nur für Mannschaften
-- eines Vereins (Startgemeinschaft zählt als ein Verein).
create table turnier_mannschaftsmeldungen (
  id uuid primary key,
  turnier_id uuid not null references turniere,
  klasse_id  uuid not null,                               -- Klasse mit einzel = false
  foreign key (klasse_id, turnier_id) references turnier_klassen (id, turnier_id),
  mannschaft_id uuid not null references mannschaften,   -- Saison muss zum Turnierdatum passen (Serverprüfung)
  quelle text not null check (quelle in ('stammdaten','hajime')),
  hajime_meldung_ref text unique,
  status text not null default 'gemeldet'
         check (status in ('gemeldet','warteliste','abgemeldet','gestartet','nicht_angetreten')),
  gemeldet_von uuid references benutzer, gemeldet_am timestamptz not null default now(),
  unique (turnier_id, klasse_id, mannschaft_id)
);
```

Die Aufstellung am Kampftag (wer aus der Mannschaft kämpft) erfasst Hajime Pro. Ein ausgesetztes Mannschaftsstartrecht
(`lizenz_aussetzungen`) sperrt die Person für die Mannschaft im Aussetzungszeitraum. Ligen (Spielplan,
Begegnungen, Tabelle) verwaltet Hajime Pro (E113); der Stammdaten-Server liefert dafür Mannschaften, Mitglieder und
Startrechte.

**Platzierungen (E110).** Nach dem Turnier schreibt Hajime Pro je Meldung die Platzierung zurück
(`turnier_meldungen.platzierung`, z. B. 1, 2, 3, 5, 7; `null` = nicht platziert). Einzelkämpfe bleiben in Hajime Pro.
Die Platzierung ist sichtbar für die Person, Berechtigte, den meldenden Verein und den Veranstalter.

---

### 9b.4 Einladungen

Bei `sichtbarkeit = 'einladung'` sehen den Termin nur Eingeladene. Eingeladen werden **Vereine** (dann sehen ihn
deren Admins und Trainer und können Mitglieder melden) oder **Personen** (sie bzw. ihre Eltern sehen ihn und melden
sich selbst an).

```sql
create table termin_einladungen (
  id uuid primary key,
  termin_art text not null check (termin_art in ('turnier','veranstaltung')),
  termin_id  uuid not null,
  verein_id  uuid references vereine,
  person_id  uuid references personen,
  check (num_nonnulls(verein_id, person_id) = 1),
  unique nulls not distinct (termin_art, termin_id, verein_id, person_id)
);
```

Personen werden nur aus dem eigenen Mitgliederbestand des Veranstalters oder über eingeladene Vereine erreicht – eine
Personensuche gibt es weiterhin nicht (E70).

---

### 9b.5 Anmeldung und Voraussetzungen

Teilnehmen kann, wer den Termin sehen darf und die **Voraussetzungen** erfüllt:

| Terminart | Wer meldet | Voraussetzungen |
|---|---|---|
| Turnier | der **Verein** (Admin, Trainer mit Recht `turnier_meldung:ANLEGEN`) für seine Mitglieder **oder** die Person selbst (ab 14) bzw. Eltern (E95); Mannschaften meldet immer der Verein | Klasse passt (Jahrgang, Geschlecht, Grad, Gewicht); gültiges **Einzel- bzw. Mannschaftsstartrecht** für diesen Verein (6.4); gültiger Judopass – jeweils **am Turniertag** geprüft. Bei Selbstmeldung ist der Verein der des Einzelstartrechts |
| Sonstige Veranstaltung | Person selbst (ab 14), Berechtigte (4.4) oder Verein | Mindestalter, Mindestgrad, falls gesetzt |
| Lehrgang | wie 9a.4 | wie 9a.3 |

Voll → Warteliste wie bei Lehrgängen (E87). Abmeldung bis Melde- bzw. Anmeldeschluss.

**Turniermeldung über Hajime Pro (E93):** Gemeldet werden kann zentral im Stammdaten-Server **oder** direkt in Hajime
Pro. Es gibt **eine** Meldeliste im Stammdaten-Server:
- Hajime Pro holt die Meldungen über die API (`GET /v1/turniere/{id}/meldungen`, Delta über `change_seq`).
- Meldungen, die direkt in Hajime erfasst werden, schreibt Hajime zurück (`POST /v1/turniere/{id}/meldungen`,
  `quelle = 'hajime'`, mit `hajime_meldung_ref` als Idempotenzschlüssel; eine Wiederholung erzeugt keine zweite
  Meldung). Der Server prüft dieselben Voraussetzungen und lehnt Doppelmeldungen ab. Meldungen aus Hajime nimmt er nur
  für Turniere mit `hajime_turnier_ref` an.
- Ab Meldeschluss sind zentrale Änderungen an der Liste im Stammdaten-Server gesperrt. Änderungen am Turniertag
  (Nachmeldung, Wiegen, Nichtantritt) macht Hajime Pro; Nachmeldungen mit `quelle = 'hajime'` nimmt der Server auch
  nach Meldeschluss an (gleiche Prüfungen). Hajime meldet den Status (`gestartet`, `nicht_angetreten`) zurück; ein
  Statuswechsel ist nur aus `gemeldet` möglich.
- Beim Abruf durch Hajime prüft der Server Startrecht und Judopass erneut für den Turniertag und markiert Meldungen,
  die nicht mehr gültig sind.
- **Durchgeführt** wird das Turnier vollständig in Hajime Pro (Auslosung, Kampfrichtertisch, Ergebnisse,
  Siegerliste). Ergebnisse bleiben vorerst in Hajime.

---

### 9b.6 Gebühren (E92)

| Terminart | Wer zahlt | Empfänger | Weg |
|---|---|---|---|
| Turnier (Startgeld, je Einzel- bzw. Mannschaftsmeldung) | **meldender Verein**; meldet sich die Person selbst (`zahler = 'person'`), zahlt sie privat | Veranstalter (Verein oder Verband) | Forderung in `abrechnungspositionen` (`art = 'startgeld'`, E108). Veranstalter ist ein Verband: Rechnungslauf dieses Verbands (6.3a). Veranstalter ist ein Verein: Forderung über die API, Abwicklung in Dojo Master Pro |
| Sonstige Veranstaltung | **Person** privat | Veranstalter | `abrechnungspositionen` (`art = 'veranstaltung'`). Veranstalter Verband: Rechnungslauf; Veranstalter Verein: Forderung über die API (Dojo Master Pro) |
| Lehrgang | Person privat | Verband | 9a.6 |

Startgeld entsteht mit der Meldung; Abmeldung vor Meldeschluss storniert es, Nichtantritt nicht.

---

### 9b.7 Rechte

| Recht | Operationen | Wer (Seed) |
|---|---|---|
| `turnier` | ANLEGEN, ÄNDERN, LÖSCHEN | jeder angemeldete Benutzer legt an; ändern/absagen Ersteller, Organisatoren, Admins des Veranstalters |
| `veranstaltung` | ANLEGEN, ÄNDERN, LÖSCHEN | wie `turnier` |
| `turnier_meldung` | LESEN, ANLEGEN, ÄNDERN | Vereins-Admin und Rolle Trainer (10.1) für eigene Mitglieder; die Person selbst bzw. Berechtigte (feste Regel 4.4); Veranstalter liest die Meldeliste |
| `mannschaft` | LESEN, ANLEGEN, ÄNDERN, LÖSCHEN | Vereins-Admin und Trainer für Mannschaften des eigenen Vereins |
| `veranstaltung_anmeldung` | LESEN, ÄNDERN | Veranstalter/Organisatoren: Teilnehmerliste, Anwesenheit |
| Anwendung Hajime Pro | Scope `turniere:meldungen` | Lesen und Schreiben von Meldungen, Status und Platzierung |

Ersteller und Organisatoren sind eine eigene Rechtequelle (Kerndokument 10, 11.2). Die Seeds stehen in der
Berechtigungsmatrix 10.1.

---

## Testschwerpunkte (Vorschau)

- **P0** Sichtbarkeit: Termin „Kreis X“ unsichtbar für Kreis Y; „Einladung“ nur für eingeladene Vereine/Personen; Veranstalter kann keinen fremden Kreis wählen.
- **P0** Turniermeldung: ohne gültiges Startrecht für den meldenden Verein abgelehnt; Startrecht am Turniertag abgelaufen → abgelehnt; ausgesetztes Mannschaftsstartrecht abgelehnt; Klasse eines anderen Turniers oder Mannschaftsklasse → abgelehnt; zweite Klasse im selben Turnier abgelehnt; Doppelmeldung aus Stammdaten und Hajime → eine Meldung; Neumeldung nach Abmeldung möglich.
- **P0** Hajime-Abgleich: Meldung in Hajime erscheint in der zentralen Liste und umgekehrt; Wiederholung mit gleichem `hajime_meldung_ref` erzeugt keine zweite Meldung; nach Meldeschluss keine zentrale Änderung, Nachmeldung aus Hajime schon; Status vom Turniertag und Platzierung kommen zurück; Platzierung ohne Meldung abgelehnt.
- **P0** Freigabe: Lehrgang erscheint erst nach Freigabe; Dan-Prüfung nur von den berechtigten Stellen anlegbar; Turnier und Veranstaltung sofort nach Veröffentlichung durch den Veranstalter.
- **P0** Mannschaften: Mitglied ohne Mannschaftsstartrecht für den Verein abgelehnt; Lizenz einer anderen Person oder Saison abgelehnt; ausgesetztes Startrecht sperrt im Zeitraum; Wiedereintritt in derselben Saison möglich, überlappend nicht; Mannschaftsmeldung nur durch den Verein.
- **P1** Gebühren: Startgeld beim meldenden Verein bzw. bei Selbstmeldung bei der Person; Veranstaltungsgebühr bei der Person; Abmeldung vor Melde- bzw. Anmeldeschluss storniert; Absage storniert alle.
- **P0** Kalender: Kyu-Prüfung 8.–2. Kyu erscheint nie, Prüfung zum 1. Kyu auf Kreisebene; korrigierte Prüfung erscheint nicht; Lehrgang mit Teilnehmerkreis DJB für alle sichtbar.
- **P1** Kalenderfilter: DJB/Land/Bezirk/Kreis über den Verbandsbaum; „nur erfüllte Voraussetzungen“.

---

## Entscheidungen

| # | Entscheidung |
|---|---|
| E90 | Turniere und sonstige Veranstaltungen darf jeder einstellen; der Veranstalter wählt die Sichtbarkeit (Einladung, Kreis, Bezirk, Land, DJB) und gibt selbst frei. Lehrgänge brauchen weiter eine Freigabe; Dan-Prüfungen legen nur die berechtigten Stellen an |
| E91 | Lehrgänge, Prüfungen, Turniere und sonstige Veranstaltungen bleiben getrennte Tabellen; der Kalender ist eine gemeinsame Sicht |
| E92 | Startgeld bei Turnieren zahlt der meldende Verein; Gebühren sonstiger Veranstaltungen zahlt die Person |
| E93 | Der Kalender ist zentral im Stammdaten-Server; zu Turnieren kann zentral oder direkt in Hajime Pro gemeldet werden (eine gemeinsame Meldeliste); durchgeführt werden Turniere mit Hajime Pro |
| E94 | Kyu-Prüfungen 8.–2. Kyu gehören nicht in den Kalender; Prüfungen zum 1. Kyu erscheinen auf Kreisebene |
| E95 | Zu Turnieren melden der Verein oder die Person selbst bzw. ihre Eltern |
| E96 | Mannschaften werden als eigene Objekte angelegt (für Liga und Turniere), je Verein und Saison |
| E110 | Hajime Pro schreibt je Meldung nur die Platzierung zurück; Einzelkämpfe bleiben in Hajime Pro |
| E111 | Hat ein Verband das Turnier ausgerichtet, läuft das Startgeld über dessen Rechnungslauf; dafür braucht er Gläubiger-ID und Konto (6.3a) |
| E112 | Meldet sich eine Person selbst zu einem Turnier, zahlt sie das Startgeld privat |
| E113 | Ligen (Spielplan, Begegnungen, Tabelle) verwaltet Hajime Pro; Stammdaten liefert Mannschaften und Startrechte |

## Annahmen

Derzeit keine offenen Annahmen; die früheren Annahmen sind als E94–E96 und E110–E113 entschieden.
