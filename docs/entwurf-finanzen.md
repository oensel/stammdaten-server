# Entwurf: Gebühren, Abrechnung, Rechnungslauf, Bankkonten und SEPA-Mandate

Stand: 2026-11-21 · Status: **Entwurf** · Projekt: Stammdaten-Server
Teil von [entwurf-rollen-rechte-lizenzen.md](entwurf-rollen-rechte-lizenzen.md); Begriffe, Rechte-Modell und Kontext stehen dort. Die Jahressichtmarke selbst (6.2), Wettkampflizenzen (6.4) und die Auslöser der Prüfungsgebühren (9) stehen im Kerndokument.
Abschnitts- und Entscheidungsnummern sind wie im Kerndokument beibehalten.

---

## 6. Finanzen (Fortsetzung von Kerndokument 6)

### 6.3 Monatliche Abrechnung: Pässe, Prüfungsgebühren, Jahressichtmarken

Der Landesverband rechnet mit jedem Verein **einmal im Monat** ab. Gebühren mit einem Verein als Zahler gehen
vorerst nur an den Landesverband (`gebuehren_empfaenger`); einzige Ausnahme ist das **Startgeld** an den Veranstalter
eines Turniers (9b.6). Eine Abrechnung enthält alle Positionen des Vormonats:

| Position | Entsteht bei | Betrag |
|---|---|---|
| **Neuer Judopass** | Genehmigung eines Erteilungsantrags (6.1) – zusätzlich entsteht die Jahressichtmarke für das laufende Jahr, auch im Dezember; im Januar folgt die nächste | Gebühr „Judopass“ |
| **Jahressichtmarke** | einmal je Pass und Jahr: Neuanlage oder Verlängerung zu Jahresbeginn (6.2) | Gebühr „Jahressichtmarke“ |
| **Modulgebühr** | Abschluss einer Prüfung (9.3), je abgelegtem Modul eines Teilnehmers – **jede Teilnahme, auch wenn nicht bestanden** (nicht bei `nicht_erschienen`) | Modulpreis des Zielgrades |
| **Graduierungsgebühr** | Entstehen einer Graduierung (alle Pflichtmodule bestanden, 8.1) – beim Prüfungsabschluss oder durch den Tageslauf nach Ablauf der Wartezeit | Preis des Grades |

**Wer eine Gebühr erhebt, legt ihren Preis fest.** Der Verein pflegt seine Gebühren (z. B. Kyu-Prüfung), der
Landesverband seine (Judopass, Jahressichtmarke, Dan-Prüfung), jeweils gültig ab einem Stichtag (Preisänderungen ohne
rückwirkend). Maßgeblich ist der Preis des Empfängers am Leistungsdatum. Rechte: `gebuehren:LESEN/ÄNDERN`
im Vereins- bzw. Verbandskontext, nur für die eigenen Gebühren.

**Prüfungsgebühren = Modulpreise + Graduierungspreis.** Der Empfänger legt einen **Modulpreis je Zielgrad** fest
(E109; gilt für jedes Modul dieses Grades), mit einem **Standardpreis** für alle Grade derselben Art als Rückfall.
Einzelne Module können einen abweichenden Preis haben. Gesucht wird in dieser Reihenfolge: Modul, Zielgrad, Standard.
Dazu gibt es einen Preis für die Graduierung selbst. Der Gesamtpreis eines Grades ist damit gleich, egal ob alle Module an einem Tag
oder verteilt auf mehrere Prüfungen abgelegt werden. **Wiederholungen** eines nicht bestandenen Moduls werden
erneut berechnet. Über die Preise steuert der Empfänger, wann gezahlt wird:

| Beispiel | Module | Graduierung | Wirkung |
|---|---|---|---|
| Dan | Kata 50 €, Nage-Waza 25 €, … | 0 € | Bezahlt wird je Modul, sobald es abgelegt ist |
| Kyu | Kata 0 €, Nage-Waza 0 €, … | 40 € | Bezahlt wird erst, wenn der Gürtel vergeben wird |

Positionen mit 0 € werden nicht erzeugt. Fehlt am Leistungsdatum ein Preis, wird die Position **zurückgestellt**
(`status = 'zurueckgestellt'`, `betrag_cent` leer) und dem Empfänger gemeldet; der Abschluss der Prüfung scheitert daran
nicht. Trägt der Empfänger später einen Preis nach, gilt für zurückgestellte Positionen der zuerst gültige Preis nach
dem Leistungsdatum; danach gehen sie in den nächsten Lauf.

```sql
create table gebuehren (                     -- Katalog je Empfänger (Verein oder Verband)
  id uuid primary key,
  verein_id  uuid references vereine,                        -- Empfänger und Preisgeber: Verein …
  verband_id uuid references verbaende,                      -- … oder Verband
  check (num_nonnulls(verein_id, verband_id) = 1),
  art text not null check (art in ('judopass','jahressichtmarke','modul','graduierung')),
  modul_id   uuid references module,                         -- optional bei 'modul': abweichender Preis eines Moduls
  ziel_art   text check (ziel_art in ('kyu','dan')),         -- Pflicht bei 'modul' und 'graduierung'
  ziel_stufe smallint,                                       -- leer bei 'modul' = Standardpreis aller Grade dieser Art
  check (art not in ('modul','graduierung') or ziel_art is not null),
  check (art in ('modul','graduierung') or (ziel_art is null and ziel_stufe is null)),
  check (art <> 'graduierung' or ziel_stufe is not null),
  check (modul_id is null or art = 'modul'),
  preis_cent int not null check (preis_cent >= 0),
  gueltig_ab date not null,
  festgelegt_von uuid references benutzer
);
create unique index gebuehren_eindeutig on gebuehren
  (coalesce(verein_id, verband_id), art, modul_id, ziel_art, ziel_stufe, gueltig_ab) nulls not distinct;
-- Allgemeine Forderungstabelle (E108): alle Gebühren – Pass, Marke, Prüfung, Lehrgang, Veranstaltung, Startgeld
create table abrechnungspositionen (
  id uuid primary key,
  -- Zahler: ein Verein (Monatsabrechnung, Startgeld) oder die Person privat (Prüfung, Lehrgang, Veranstaltung)
  zahler_verein_id  uuid references vereine,          -- Heimatverein bzw. Verein des Prüflings
  zahler_person_id  uuid references personen,
  -- Empfänger laut gebuehren_empfaenger
  empfaenger_verein_id  uuid references vereine,
  empfaenger_verband_id uuid references verbaende,
  check (num_nonnulls(zahler_verein_id, zahler_person_id) = 1),
  check (num_nonnulls(empfaenger_verein_id, empfaenger_verband_id) = 1),
  art text not null check (art in ('judopass','jahressichtmarke','modul','graduierung',
                                    'lehrgang','veranstaltung','startgeld')),
  bezug_tabelle text not null, bezug_id uuid not null, -- Antrag, Marken-Einsatz, Teilnehmer-Modul, Graduierung, Anmeldung, Meldung
  person_id  uuid references personen,                 -- Teilnehmer bzw. Prüfling
  zahlungspflichtiger_person_id uuid references personen,   -- Kontoinhaber, wenn ein Elternteil zahlt (6.5)
  leistungsdatum date not null,
  gebuehr_id uuid references gebuehren,                -- leer bei Lehrgang/Veranstaltung/Startgeld (Preis am Termin)
  betrag_cent int,                                     -- leer nur bei status 'zurueckgestellt'
  gutschrift_fuer_id uuid references abrechnungspositionen,        -- Gutschrift: negativer Betrag, verweist auf Original
  abrechnung_id uuid references abrechnungen,         -- Zahler Verein: Monatsabrechnung; leer = noch nicht abgerechnet
  -- Zahler Person (Dan-Prüfung an den Landesverband): Rechnung an die Person
  zahlungsweise text check (zahlungsweise in ('lastschrift','ueberweisung')),
  mandat_id uuid references sepa_mandate,             -- Pflicht bei Lastschrift; Gläubiger = Empfänger
  rechnungslauf_id uuid references rechnungslaeufe,     -- aktueller Lauf; Historie in forderung_laeufe
  status text not null default 'offen'
         check (status in ('zurueckgestellt','offen','abgerechnet','eingezogen','bezahlt','zurueckgebucht','erlassen','storniert')),
  check ((status = 'zurueckgestellt') = (betrag_cent is null)),
  check (zahler_person_id is null or zahlungsweise is not null),
  check (zahlungsweise is distinct from 'lastschrift' or mandat_id is not null),
  storniert_am timestamptz
);
create unique index position_einmal on abrechnungspositionen
  (bezug_tabelle, bezug_id, art, coalesce(gutschrift_fuer_id, '00000000-0000-0000-0000-000000000000'))
  where storniert_am is null;     -- nichts doppelt; nach Storno bzw. Korrektur ist eine neue Position möglich
-- Serverprüfung: bei Lastschrift muss das Mandat zum Empfänger als Gläubiger gehören (Trigger)
create table forderung_laeufe (                -- Historie: in welchen Läufen eine Forderung war
  position_id uuid references abrechnungspositionen, rechnungslauf_id uuid references rechnungslaeufe,
  ergebnis text check (ergebnis in ('eingezogen','zurueckgebucht','storniert')),
  primary key (position_id, rechnungslauf_id)
);
create table abrechnungen (
  id uuid primary key,
  verein_id  uuid not null references vereine, verband_id uuid not null references verbaende,
  monat date not null,                                 -- erster Tag des abgerechneten Monats
  betrag_cent int not null,                            -- Summe der Positionen + vortrag_cent
  vortrag_cent int not null default 0,                 -- negativer Saldo (Guthaben) des Vormonats
  zahlungsweise text not null check (zahlungsweise in ('lastschrift','ueberweisung')),
  status text not null default 'erstellt'
         check (status in ('erstellt','versendet','eingezogen','bezahlt','zurueckgebucht','storniert')),
  faellig_am date, sepa_datei_id uuid,
  rechnungslauf_id uuid references rechnungslaeufe,   -- in welchem Lauf eingezogen bzw. angemahnt
  unique (verein_id, verband_id, monat)
);
create table verein_zahlungsweise (           -- je Verein gegenüber seinem Landesverband, mit Historie
  id         uuid primary key,
  verein_id  uuid not null references vereine,
  verband_id uuid not null references verbaende,
  art        text not null check (art in ('ueberweisung','lastschrift')),
  mandat_id  uuid references sepa_mandate,            -- Gläubiger = Landesverband, Inhaber = Verein (6.5)
  gueltig_ab date not null,                            -- immer ein Monatserster
  geaendert_von uuid references benutzer, grund text,
  unique (verein_id, verband_id, gueltig_ab),
  check (art = 'ueberweisung' or mandat_id is not null),
  check (extract(day from gueltig_ab) = 1)
);
```

**Zahlungsempfänger je Gebührenart.** Wer eine Gebühr bekommt und wer sie zahlt, ist je Gebührenart festgelegt
(DJB-weit, mit Stichtag). Der Empfänger stellt die Gebühr in Rechnung.

```sql
create table gebuehren_empfaenger (
  id uuid primary key,
  art text not null check (art in ('judopass','jahressichtmarke','modul','graduierung')),
  ziel_art text check (ziel_art in ('kyu','dan')),     -- bei modul/graduierung: getrennt für Kyu und Dan
  empfaenger_ebene text not null
    check (empfaenger_ebene in ('verein','kreis','bezirk','landesverband','djb')),
  zahler text not null check (zahler in ('verein','person')),
  check (zahler = 'person' or empfaenger_ebene = 'landesverband'),
  gueltig_ab date not null,
  festgelegt_von uuid references benutzer,
  unique nulls not distinct (art, ziel_art, gueltig_ab)
);
```

Startgeld (Zahler Verein, Empfänger Veranstalter, auch ein Verein) läuft nicht über `gebuehren_empfaenger`, sondern
entsteht direkt aus der Turniermeldung (9b.6); für die Gebührenarten dieser Tabelle bleibt „Verein zahlt nur an den
Landesverband“.

Beispiel-Konfiguration:

| Gebührenart | Empfänger | Zahler | Abgerechnet über |
|---|---|---|---|
| Judopass, Jahressichtmarke | Landesverband | Verein | Monatsabrechnung des Landesverbands |
| Prüfung Kyu (Module, Graduierung, ggf. Gürtel) | **Heimatverein** des Prüflings, auch wenn ein anderer Verein prüft (E85) | Person (bzw. Eltern) | **Der Verein stellt sie in Rechnung**: der Server liefert die Forderungen, der Verein rechnet sie in Dojo Master Pro ab (z. B. mit dem Beitrag, Vereinsmandat 6.5) |
| Prüfung Dan (Module, Graduierung) | Landesverband | Person (Prüfling) | **Der Landesverband stellt sie in Rechnung**: Rechnungslauf (6.3a), Lastschrift mit Mandat der Person an den Landesverband (6.5) oder Überweisung |

Die Empfänger-Ebene wird zum konkreten Empfänger aufgelöst: „Verein“ = Heimatverein der Person **am Leistungsdatum**
(bei Zahler Verein: der zahlende Verein); „Kreis/Bezirk/Landesverband“ = der Verband dieser Ebene oberhalb des so
ermittelten Vereins (jeder Verein hängt an einem Kreis, E101); „DJB“ = Wurzel.
Ist der Empfänger ein Verband, landet die Position im Rechnungslauf dieses Verbands (6.3a); Monatsabrechnungen (6.3)
fasst jeder Empfänger-Verband für seine Vereine zusammen. Ist der Empfänger ein Verein, stellt der Server die
Forderungen über die API für Dojo Master Pro bereit (Scope `forderungen:verein`); der Einzug läuft dort.

**Lastschrift ist Pflichtangebot:** Jeder Landesverband muss Lastschrift anbieten (Gläubiger-ID und Konto sind
Pflicht, 6.3a).

**Wechsel der Zahlungsweise:** Ein Verein kann jederzeit von Überweisung auf Lastschrift wechseln und zurück
(Recht `zahlungsweise:ÄNDERN` für den Vereins-Admin). Der Wechsel gilt **ab dem nächsten Monatsersten**; die laufende
bzw. schon erstellte Abrechnung behält ihre Zahlungsweise. Für Lastschrift muss ein SEPA-Mandat erfasst sein. Beim
Wechsel auf Überweisung bleibt das Mandat bestehen; der Verein kann es auf Wunsch widerrufen. Maßgeblich für eine Abrechnung ist der Eintrag mit dem
spätesten `gueltig_ab` ≤ Abrechnungsmonat; gibt es keinen, gilt Überweisung. Ist das Mandat beim Lauf widerrufen oder
verfallen, wird die Abrechnung als Überweisung erstellt. Der Landesverband wird über jeden Wechsel informiert.

**Ablauf des Monatslaufs** (z. B. am 1. des Folgemonats, idempotent):
1. Alle offenen, nicht stornierten Positionen sammeln, deren Zahler ein Verein ist, deren Empfänger ein Verband ist
   und deren Leistungsdatum vor dem Ersten des laufenden Monats liegt, auch nachträglich entstandene ältere.
   Gruppiert wird je Verein und Empfänger-Verband. Positionen mit einer Person als Zahler laufen über den
   Rechnungslauf (6.3a).
2. Eine Abrechnung je Verein erzeugen (Positionen erhalten `abrechnung_id`); Summe = Summe der Positionen plus
   `vortrag_cent` aus der Vormonatsabrechnung, falls diese negativ war.
3. Abrechnung als Beleg (PDF/CSV) für Verein und Landesverband bereitstellen.
4. Bei **Lastschrift**: SEPA-Datei (pain.008) für den Landesverband erzeugen. Bei **Überweisung**: Fälligkeit setzen.
5. **Rücklastschrift**: Abrechnung `zurueckgebucht`, danach `versendet` als Überweisung mit neuer Fälligkeit. Der
   Server legt einen Eintrag in `verein_zahlungsweise` mit Überweisung ab dem nächsten Monatsersten an
   (`geaendert_von` leer = System, Grund „Rücklastschrift“). Trägt der Verein für denselben Monatsersten selbst einen
   Wechsel der Zahlungsweise ein, hat der Systemeintrag Vorrang (protokolliert). Das Mandat bleibt bestehen, damit der
   Verein ohne neues Mandat zurückwechseln kann.

**Statusübergänge einer Abrechnung:** `erstellt` → `versendet` → `eingezogen` bzw. `bezahlt`; `eingezogen` →
`zurueckgebucht` → `versendet` (Überweisung) → `bezahlt`; `erstellt` → `storniert` (nur vor dem Versand). Ein
erneuter Lauf im selben Monat erzeugt für einen Verein nur dann eine Abrechnung, wenn keine nicht stornierte existiert.

Stornos nach dem Abrechnen (z. B. Prüfung fehlerhaft abgeschlossen) erscheinen als Gutschrift-Position in der
nächsten Abrechnung, die alte Abrechnung bleibt unverändert. Ist eine Monatssumme **negativ**, wird nichts eingezogen;
das Guthaben geht als `vortrag_cent` in die Abrechnung des Folgemonats oder wird auf Wunsch überwiesen.

Die Buchhaltung (Zahlungseingänge, Mahnwesen) bleibt beim Landesverband. Der Stammdaten-Server liefert Positionen,
Abrechnungen und SEPA-Datei.

### 6.3a Rechnungslauf eines Verbands

**Jeder Verband** – Kreis, Bezirk, Landesverband, DJB – kann Gläubiger sein und Lastschriften einziehen. Er startet
dafür (typisch einmal im Monat) einen **Rechnungslauf** (Recht `rechnungslauf:ANLEGEN` im Verbandskontext, z. B. Rolle
„Verbandskassierer“). Der Lauf sammelt **alle offenen Forderungen, deren Gläubiger dieser Verband ist**:

- beim Landesverband: die Monatsabrechnungen der Vereine (6.3), bei Lastschrift-Vereinen zum Einzug, sonst als
  Zahlungserinnerung (`abrechnungen.rechnungslauf_id`);
- beim Landesverband: die offenen Positionen mit einer **Person als Zahler** (Dan-Prüfungen), Lastschrift oder
  Rechnung zur Überweisung (`abrechnungspositionen.rechnungslauf_id`);
- bei jedem Verband: die privaten Gebühren seiner Lehrgänge und Veranstaltungen (9a.6, 9b.6) und das Startgeld seiner
  Turniere.

Ergebnis ist **eine SEPA-Datei (pain.008)** je Lauf und Lastschriftart (CORE für private Zahler, B2B/CORE für Vereine)
sowie eine Liste der Überweisungs-Forderungen. Die Datei reicht der Verband per FinTS ein (unten) oder lädt sie
selbst in sein Online-Banking hoch.

**FinTS (E114).** Ein Verband kann sein Konto per FinTS anbinden. Der Server ruft dann die Umsätze ab (CAMT bzw. MT940),
ordnet Zahlungseingänge über die Forderungsreferenz im Verwendungszweck den offenen Abrechnungen und Positionen zu,
erkennt Rücklastschriften und kann die SEPA-Datei des Rechnungslaufs einreichen. Die PIN wird nicht gespeichert; jede
Einreichung und jeder Abruf, der eine TAN braucht, gibt ein Benutzer mit `fints:ANLEGEN` (Verbandskassierer) frei.
Nicht zuordenbare Umsätze landen in einer Klärliste. Vereine gleichen ihre Konten weiter in Dojo Master Pro ab.

```sql
create table fints_zugaenge (
  id uuid primary key, konto_id uuid not null unique references bankkonten,
  blz text not null, server_url text not null, benutzerkennung text not null,  -- keine PIN
  tan_verfahren text, letzter_abruf_am timestamptz
);
create table kontoumsaetze (
  id uuid primary key, konto_id uuid not null references bankkonten,
  buchungstag date not null, betrag_cent bigint not null, verwendungszweck text, gegenkonto_iban text,
  bank_referenz text not null,                         -- eindeutig je Konto, macht den Abruf wiederholbar
  abrechnung_id uuid references abrechnungen, position_id uuid references abrechnungspositionen,
  status text not null default 'offen' check (status in ('offen','zugeordnet','ruecklastschrift','ignoriert')),
  unique (konto_id, bank_referenz)
);
```

Voraussetzung für Lastschriften eines Verbands: **Gläubiger-ID** und **eigenes Konto** sind hinterlegt.

```sql
alter table verbaende
  add column glaeubiger_id text,                      -- SEPA-Gläubiger-Identifikationsnummer
  add column konto_id uuid references bankkonten;     -- Empfängerkonto (Inhaber = dieser Verband)
alter table vereine
  add column glaeubiger_id text,                      -- für Vereinsmandate (Mitgliedsbeiträge, E59)
  add column konto_id uuid references bankkonten;
```

```sql
create table rechnungslaeufe (
  id uuid primary key,
  glaeubiger_verband_id uuid not null references verbaende,   -- Kreis, Bezirk, Landesverband oder DJB
  stichtag date not null, faellig_am date not null,
  gestartet_von uuid not null references benutzer, gestartet_am timestamptz not null default now(),
  anzahl int, summe_cent bigint,
  status text not null default 'erstellt' check (status in ('erstellt','heruntergeladen','eingereicht','storniert'))
);
```

- Jede Forderung landet in **höchstens einem** nicht stornierten Lauf (Zuordnung nur, wenn `rechnungslauf_id` leer ist,
  mit Zeilensperre; je Gläubiger läuft höchstens ein Lauf gleichzeitig, Sperre auf den Gläubiger). Stornieren lässt
  sich ein Lauf nur im Status `erstellt` oder `heruntergeladen`; dabei werden seine Forderungen in derselben
  Transaktion freigegeben. Ein eingereichter Lauf ist endgültig.
- Vor dem Einreichen prüft der Server die Mandate erneut (Widerruf, Verfall); betroffene Forderungen nimmt er aus dem
  Lauf, stellt sie auf Überweisung und erzwingt eine neue Datei. `letzte_nutzung` des Mandats wird beim Einreichen gesetzt.
- Lastschrift wird nur angeboten, wenn der Gläubiger Gläubiger-ID und Konto hat; die Vorabankündigung muss fristgerecht
  vor `faellig_am` zugestellt sein, sonst lehnt der Server den Lauf ab. Kontoinhaber ohne E-Mail stehen auf
  einer Fehlerliste (Brief oder Umstellung auf Überweisung).
- Nach dem Einreichen markiert der Verband Rücklastschriften einzeln (`zurueckgebucht`). Der Server schreibt den Lauf in
  `forderung_laeufe`, leert `rechnungslauf_id` und setzt die Forderung wieder auf `offen`; sie geht in den nächsten
  Lauf oder wird auf Überweisung umgestellt.
- Vorabankündigung (Pre-Notification) an Verein bzw. Zahler **versendet der Server selbst** per E-Mail mit dem Lauf
  (Frist laut SEPA); der Verbandskassierer braucht dafür keine Kontaktdaten.


### 6.5 Bankkonten und SEPA-Mandate

Ein Konto kann **mehrere Mandate** haben – je Gläubiger eines. Beispiel: Eine Mutter zahlt vom selben Konto den
Vereinsbeitrag (Mandat an den **Verein**) und die Lehrgangsgebühren ihrer Kinder (Mandat an den **Landesverband**).
Konto und Mandat sind deshalb getrennte Tabellen. Dasselbe Modell gilt für Vereine als Zahler gegenüber ihrem
Landesverband (Monatsabrechnung, 6.3).

```sql
create table bankkonten (
  id uuid primary key,
  inhaber_person_id uuid references personen,      -- Kontoinhaber ist eine Person (z. B. Elternteil) …
  inhaber_verein_id uuid references vereine,       -- … oder ein Verein (Monatsabrechnung, Vereinskonto)
  inhaber_verband_id uuid references verbaende,    -- … oder ein Verband (Empfängerkonto)
  inhaber_name text not null,                      -- wie bei der Bank geführt
  iban text not null,                              -- verschlüsselt (enc:…, AES-256-GCM)
  iban_hash text not null,                         -- HMAC der IBAN: Dubletten erkennen, ohne zu entschlüsseln
  bic text,
  erfasst_von uuid references benutzer,
  check (num_nonnulls(inhaber_person_id, inhaber_verein_id, inhaber_verband_id) = 1)
);
create unique index bankkonten_uq on bankkonten (coalesce(inhaber_person_id, inhaber_verein_id, inhaber_verband_id), iban_hash)
  where geloescht_am is null;

create table sepa_mandate (
  id uuid primary key,
  konto_id uuid not null references bankkonten,
  glaeubiger_verband_id uuid references verbaende,  -- Kreis, Bezirk, Landesverband, DJB (Lehrgänge, Monatsabrechnung)
  glaeubiger_verein_id  uuid references vereine,    -- Verein (Mitgliedsbeiträge, eingezogen von Dojo Master Pro)
  mandatsreferenz text not null,                    -- eindeutig je Gläubiger
  art text not null check (art in ('CORE','B2B')),  -- Privatperson: CORE; Verein: B2B oder CORE
  wiederkehrend boolean not null default true,
  unterschrieben_am date not null,
  form text not null check (form in ('papier','online')),
  dokument_id uuid references dokumente,            -- Scan des Papiermandats bzw. erzeugtes Mandats-PDF
  zustimmung_benutzer_id uuid references benutzer,  -- online: Kontoinhaber selbst; bei Vereins-/Verbandskonten ein
                                                    -- Benutzer mit zahlungsweise:ÄNDERN bzw. Kassierer dieser Organisation
  zustimmung_am timestamptz,                        -- online: Zeitpunkt der Zustimmung
  mandatstext_version text,                         -- online: welcher Mandatstext angezeigt wurde
  bestaetigung_versendet_am timestamptz,            -- online: Bestätigung an den Kontoinhaber
  status text not null default 'aktiv' check (status in ('aktiv','widerrufen','verfallen')),
  widerrufen_am date,
  letzte_nutzung date,                              -- SEPA: 36 Monate ungenutzt → verfallen
  check (num_nonnulls(glaeubiger_verband_id, glaeubiger_verein_id) = 1),
  check (form = 'papier' or (zustimmung_benutzer_id is not null and zustimmung_am is not null and mandatstext_version is not null)),
  unique (glaeubiger_verband_id, mandatsreferenz),
  unique (glaeubiger_verein_id, mandatsreferenz)
);
create unique index sepa_mandat_je_glaeubiger on sepa_mandate
  (konto_id, coalesce(glaeubiger_verband_id, glaeubiger_verein_id)) where status = 'aktiv';
```

Regeln:
- **Je Konto und Gläubiger höchstens ein aktives Mandat.** Mehrere Mandate für dasselbe Konto bei verschiedenen
  Gläubigern sind der Normalfall.
- Ein Mandat deckt **alle Forderungen dieses Gläubigers** an den Kontoinhaber ab – z. B. die Lehrgänge aller drei Kinder.
- Wer ein Mandat für eine Person erteilen darf: die Person selbst (volljährig) oder ein Berechtigter nach 4.4 (Eltern),
  jeweils nur für ein Konto, dessen Inhaber er selbst ist.
- Ein Mandat wird nur für den Gläubiger verwendet, für den es erteilt ist (Prüfung bei jeder Forderung und im Rechnungslauf).
- **Online-Mandat** (erlaubt): Der Kontoinhaber erteilt das Mandat angemeldet im Browser oder in der App, z. B. bei der
  Lehrgangsanmeldung. Er sieht den vollständigen Mandatstext (Gläubiger, Gläubiger-ID, Mandatsreferenz, Konto) und
  stimmt ausdrücklich zu (eigenes Häkchen, nicht vorausgewählt). Gespeichert werden Benutzer, Zeitpunkt und Version des
  Mandatstexts; der Server erzeugt ein Mandats-PDF und schickt es als Bestätigung an den Kontoinhaber. Nur ein
  **volljähriger Kontoinhaber** kann zustimmen – ein Kind ab 14 kann sich anmelden, das Mandat erteilen aber die Eltern.
  Papiermandate (Scan) bleiben daneben möglich.
- **Verfall:** Ein täglicher Lauf setzt Mandate, die 36 Monate nicht genutzt wurden (`coalesce(letzte_nutzung,
  unterschrieben_am)`), auf `verfallen`. Dojo Master Pro meldet die Nutzung von Vereinsmandaten über die API zurück;
  vor dem Verfall wird der Gläubiger gewarnt.
- **Zahlungspflichtiger:** Zahlt ein Elternteil für ein Kind, steht an der Forderung neben der Person auch der
  Zahlungspflichtige (`zahlungspflichtiger_person_id`, Kontoinhaber). Ein Mandat darf nur genutzt werden, wenn sein
  Kontoinhaber der Zahler selbst ist oder einen aktiven Zugriff nach 4.4 auf den Zahler hat. Ruht oder endet dieser
  Zugriff (z. B. Kind wird 18), stellt der Server offene Forderungen auf Überweisung um und benachrichtigt beide.
- **Widerruf** jederzeit durch den Kontoinhaber. Er wirkt auf alle Forderungen, die noch keinem eingereichten Lauf
  angehören: Sie werden aus nicht eingereichten Läufen gelöst und auf Überweisung gestellt.
- Ein Konto mit aktivem Mandat kann nicht gelöscht werden; erst Mandat widerrufen.
- IBAN nie im Klartext in Logs, Exporten (außer SEPA-Datei) oder API-Antworten; angezeigt wird nur `DE•• •••• •••• 1234`.
- **Sichtbarkeit von Konten und Mandaten:**

  | Wer | sieht |
  |---|---|
  | Kontoinhaber | eigene Konten und alle Mandate darauf |
  | Berechtigte (4.4) | nur Konten, deren Inhaber sie selbst sind – nicht die Konten des Kindes |
  | Kassierer des Gläubigers (Vereinskassierer bzw. Verbandskassierer) | nur Mandate mit dem eigenen Verein/Verband als Gläubiger und das zugehörige Konto |
  | alle anderen (auch Vereins-Admin, Landesvertreter, Super-Admin im Normalbetrieb) | nichts |

  Ein Zugriff des Super-Admins auf Bankdaten ist nur als protokollierter Notfallzugriff vorgesehen.

**Vereinsmandate liegen zentral hier.** Auch die Mandate für Mitgliedsbeiträge (Gläubiger = Verein) werden im
Stammdaten-Server geführt. Dojo Master Pro liest Konto und Mandat über die API (eigener Scope `zahlungen:mandate`,
nur für den Verein als Gläubiger) und zieht die Beiträge weiter selbst ein (SEPA/FinTS bleiben dort). Wer für welches
Mitglied zahlt (Zuordnung Beitrag ↔ Mandat), bleibt Fachlogik von Dojo Master Pro. So wird ein Konto nur einmal
erfasst, auch wenn Verein und Verbände davon einziehen. Damit ist `datenbankentwurf.md` 2.3 für Konten und Mandate
aufgehoben.

`verein_zahlungsweise` (6.3) verweist für Lastschrift-Vereine auf ein `sepa_mandate` mit Gläubiger Landesverband,
statt eigene Mandatsfelder zu führen.

### 6.8 Migration der Finanzdaten

1. `gebuehren`: bisher DJB-weite Preise als Startwerte je Landesverband übernehmen; Modulpreise als Standardpreis je Art.
2. Bankkonten und SEPA-Mandate aus Dojo Master Pro übernehmen (Mandatsreferenzen bleiben gleich); Gläubiger-ID und
   Konto der Vereine aus Dojo Master Pro in `vereine` übernehmen.
3. Zahlungsweise jedes Vereins gegenüber seinem Landesverband als erster Eintrag in `verein_zahlungsweise`.
4. Anlagereihenfolge: Bankkonten, Mandate, dann `verein_zahlungsweise`, `gebuehren`, `abrechnungen`, `abrechnungspositionen`.

---

## Testschwerpunkte (Vorschau)

- **P0** Rechnungslauf: jede offene Forderung in genau einem Lauf; stornierter Lauf gibt Forderungen frei; SEPA-Datei validiert gegen pain.008; private CORE- und Vereins-Lastschriften getrennt; IBAN nur verschlüsselt gespeichert, nie in Logs.
- **P0** Mandate: höchstens ein aktives Mandat je Konto und Gläubiger, mehrere Gläubiger je Konto möglich; Forderung eines Gläubigers mit Mandat eines anderen abgelehnt (auch im Rechnungslauf); widerrufenes oder verfallenes Mandat → kein Einzug; nach 36 Monaten ohne Nutzung verfallen; Eltern dürfen nur für eigenes Konto Mandate erteilen; IBAN nie im Klartext in Log oder API.
- **P0** Gläubiger: Kreis ohne Gläubiger-ID oder Konto kann keinen Lauf starten; Kreis-Lauf enthält nur Forderungen mit Kreis als Gläubiger, nie Vereins- oder Landesverbandsforderungen; Dojo Master Pro sieht nur Mandate mit dem eigenen Verein als Gläubiger.
- **P0** Online-Mandat: ohne ausdrückliche Zustimmung kein Mandat; Benutzer ≠ Kontoinhaber oder minderjährig → abgelehnt; Zeitpunkt, Benutzer und Textversion gespeichert; Bestätigung versendet.
- **P0** Sichtbarkeit Bankdaten: Vereins-Admin, Landesvertreter und fremder Kassierer sehen kein Konto/Mandat; Kassierer sieht nur Mandate des eigenen Gläubigers; Eltern sehen nicht das Konto des Kindes.
- **P0** Gebühren und Empfänger: Kyu-Prüfung erzeugt Forderung Person → Heimatverein am Leistungsdatum (nicht in der Landesverbands-Abrechnung, auch nach späterem Transfer); Dan-Prüfung erzeugt Forderung Person → Landesverband im Rechnungslauf (Lastschrift oder Überweisung); Änderung der Zuordnung wirkt nur ab Stichtag; jede Position hat genau einen Zahler und einen Empfänger; Verein und Landesverband ändern nur eigene Preise.
- **P0** Modulpreise: Preis je Zielgrad greift für jedes Modul; Standardpreis als Rückfall; Modulpreis überschreibt beide; ohne Preis → `zurueckgestellt`, nach Nachtrag abgerechnet; Summe der Modul- und Graduierungspreise eines Grades gleich, ob an einem Tag oder verteilt; 0-€-Positionen entstehen nicht; nicht bestandenes Modul wird berechnet, `nicht_erschienen` nicht.
- **P0** Korrektur: nach Storno und Neuerfassung entsteht die Position erneut (kein Eindeutigkeitsfehler).
- **P0** Rücklastschrift: Forderung geht in den nächsten Lauf (Historie in `forderung_laeufe`); Abrechnung wird als Überweisung erneut versendet; negativer Saldo erscheint als Vortrag im Folgemonat.
- **P0** Widerruf und Verfall: Widerruf nach Lauferstellung, vor Einreichen → Forderung aus der Datei, auf Überweisung; Elternmandat nach dem 18. Geburtstag des Kindes nicht mehr genutzt.
- **P1** Zahlungsweise: Wechsel wirkt erst ab nächstem Monat; Lastschrift ohne Mandat abgelehnt; laufende Abrechnung behält ihre Zahlungsweise; ohne Eintrag gilt Überweisung.
- **P1** Jahressichtmarke: Marke erscheint in der Monatsabrechnung ihres Entstehungsmonats; nach Landesverbandswechsel rechnet der neue Landesverband ab; Storno erzeugt Gutschrift.

---

## Entscheidungen

| # | Entscheidung |
|---|---|
| E39 | Die Jahressichtmarke ist digital, je Pass und Jahr |
| E41 | Monatliche Abrechnung je Verein mit neuen Pässen, Prüfungsgebühren und Jahressichtmarken |
| E42 | Prüfungsgebühren: Modulpreis plus Preis je Graduierung, festgelegt vom Empfänger; Gesamtpreis eines Grades unabhängig von der Verteilung der Module |
| E43 | Ein Verein kann zwischen Überweisung und Lastschrift wechseln (wirksam ab nächstem Monat) |
| E45 | Jede Modulteilnahme wird berechnet, auch bei Nichtbestehen; Wiederholungen kosten erneut |
| E55 | Jeder Gläubiger-Verband startet einen Rechnungslauf, der alle offenen Lastschriften sammelt (SEPA-Datei) |
| E58 | Der Lastschrifteinzug durch den Verband braucht ein SEPA-Mandat der Person; ein Konto kann mehrere Mandate haben (z. B. Verband und Verein) |
| E59 | Auch die Vereinsmandate (Mitgliedsbeiträge) liegen zentral im Stammdaten-Server; Dojo Master Pro nutzt sie über die API |
| E60 | Auch Kreis und Bezirk können Gläubiger sein und Lastschriften einziehen (eigener Rechnungslauf, Gläubiger-ID, Konto) |
| E61 | SEPA-Mandate dürfen online erteilt werden (Zustimmung wird protokolliert, Bestätigung an den Kontoinhaber) |
| E62 | Konten und Mandate sehen nur Kontoinhaber, Eltern für eigene Konten und der Kassierer des jeweiligen Gläubigers für dessen Mandate |
| E64 | Jahressichtmarken werden einmal jährlich je Pass berechnet: bei Neuanlage oder bei der Verlängerung zu Jahresbeginn; keine Vorkasse |
| E65 | Jeder Landesverband muss Lastschrift anbieten |
| E66 | Zahlungsempfänger und Zahler sind je Gebührenart einstellbar (z. B. Judopass → Landesverband, Kyu-Prüfung → Verein, Dan-Prüfung → Landesverband, gezahlt vom Prüfling); Standard ist der Landesverband; vorerst zahlen Vereine nur an den Landesverband |
| E69 | Wer eine Gebühr erhebt, legt den Preis fest und stellt sie in Rechnung: Kyu-Prüfung der Verein, Dan-Prüfung, Judopass und Jahressichtmarke der Landesverband (Dan an die Person per Überweisung oder Lastschrift) |
| E77 | Neuer Judopass: Judopass-Gebühr plus Jahressichtmarke für das laufende Jahr, auch im Dezember; im Januar die nächste Marke |
| E85 | Die Kyu-Prüfungsgebühr stellt immer der Heimatverein in Rechnung, auch wenn ein anderer Verein prüft |
| E108 | Alle Forderungen (Pass, Marke, Prüfung, Lehrgang, Veranstaltung, Startgeld) liegen in einer Forderungstabelle (`abrechnungspositionen`) mit Zahler-Person bzw. Zahler-Verein; Startgeld darf ein Verein auch an einen ausrichtenden Verein zahlen |
| E109 | Modulpreise legt der Empfänger je Zielgrad fest, mit einem Standardpreis je Art als Rückfall; einzelne Module können abweichen |
| E114 | Verbände können ihr Konto per FinTS im Stammdaten-Server anbinden: Umsätze abrufen, Zahlungen zuordnen, SEPA-Dateien einreichen; Vereine bleiben bei Dojo Master Pro |
| E115 | Der Wechsel der Zahlungsweise eines Vereins gilt ab dem nächsten Monatsersten |
| E116 | Gläubiger einer Lehrgangsgebühr ist der ausrichtende Verband; bei Vereins-Lehrgängen der Verband des Lehrgangstyps |
| E117 | Der Einzug der Mitgliedsbeiträge (SEPA-Datei, FinTS) bleibt in Dojo Master Pro; zentral liegen Konten, Mandate und Vereinsforderungen |
| E118 | Online-Mandate erteilt nur ein volljähriger Kontoinhaber; für Konten Minderjähriger erteilen es die Berechtigten |

## Annahmen

13. Die Zuordnung Gebührenart → Empfänger legt der DJB einheitlich fest; die Preise legt der Empfänger fest (E69).

Die Annahmen 14 und 21–23 sind als E115–E118 entschieden.
