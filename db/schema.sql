-- =====================================================================================================================
-- Stammdaten-Server – Datenbankentwurf (PostgreSQL ≥ 15)
-- Vereine, Mitglieder, Benutzer, Rollen und Berechtigungen für
-- Dojo-Master-Pro, Hajime-Pro und Kyu-Manager-Pro.
--
-- Konventionen
--   * Primärschlüssel: uuid (offline erzeugbar, passt zu Kyu-Manager-Pro und zu den String-IDs von Hajime-Pro)
--   * Sync-Spalten auf allen Stammdatentabellen: erstellt_am, geaendert_am, geaendert_von, geloescht_am (Soft Delete),
--     change_seq (Versionsnummer der Zeile, global steigend → ETag/If-Match gegen gleichzeitige Änderungen),
--     change_xid (Transaktion der letzten Änderung → Abgleich-Cursor, siehe Abschnitt 8)
--   * Mandantenfähig: jede vereinsbezogene Zeile trägt verein_id. Verweise zwischen vereinsbezogenen Tabellen laufen
--     über (verein_id, id), damit die Datenbank vereinsübergreifende Verknüpfungen ablehnt.
--     „on delete set null (spalte)“ setzt nur die Verweisspalte zurück, nicht verein_id (PostgreSQL ≥ 15).
--   * Personenbezogene Bankdaten nur verschlüsselt (AES-256-GCM, Präfix "enc1:") + HMAC-Hash für die Suche
--   * Datenschutz: gelöschte bzw. ausgetretene Personen werden nach Ablauf der Fristen in aufbewahrungsfristen
--     anonymisiert (datenschutz_bereinigen()). Die leere Zeile bleibt als Löschhinweis für den Abgleich stehen.
--   * Wertelisten als CHECK-Constraints statt ENUM-Typen (leichter zu migrieren)
-- =====================================================================================================================

create sequence change_seq;

-- Setzt change_seq und change_xid bei jedem Insert/Update neu und pflegt geaendert_am.
create function stammdaten_touch() returns trigger language plpgsql as $$
begin
  new.change_seq := nextval('change_seq');
  new.change_xid := pg_current_xact_id();
  if tg_op = 'UPDATE' then new.geaendert_am := now(); end if;
  return new;
end $$;


-- =====================================================================================================================
-- 1. Verbände und Vereine
-- =====================================================================================================================

-- Dachverband → Landesverband → Bezirk/Kreis (z. B. DJB → NWJV). Im DJB-Export: Spalten „Landesverband“ / „Verein“.
create table verbaende (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  kurzname          text,
  typ               text not null check (typ in ('dachverband', 'landesverband', 'bezirk', 'kreis')),
  uebergeordnet_id  uuid references verbaende(id),
  erstellt_am       timestamptz not null default now(),
  geaendert_am      timestamptz not null default now(),
  geaendert_von     uuid,
  geloescht_am      timestamptz,
  change_seq        bigint not null default nextval('change_seq')
);
create unique index verbaende_name_uq on verbaende (lower(name)) where geloescht_am is null;

-- Ein Verein ist entweder Mandant (nutzt die Apps, hat eigene Mitglieder) oder nur Referenz
-- (z. B. Gastverein, der sich in Hajime-Pro zu einem Turnier anmeldet).
create table vereine (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  kurzname               text,
  vereinsnummer          text,                       -- Verbands-/Vereinsnummer
  verband_id             uuid references verbaende(id),
  bundesland             text,                       -- Hajime-Pro: Vereinsübersicht, Turniere
  strasse                text,
  plz                    text,
  ort                    text,
  land                   char(2) not null default 'DE',
  email                  text,
  telefon                text,
  website                text,
  ist_mandant            boolean not null default false,
  registrierung_status   text not null default 'freigegeben'
                         check (registrierung_status in ('angefragt', 'freigegeben', 'abgelehnt')),
  -- SEPA-Gläubigerdaten (Dojo-Master-Pro)
  glaeubiger_id          text,
  konto_inhaber          text,
  iban_verschluesselt    text,
  iban_maske             text,                       -- z. B. DE89 **** **** **** **30 00
  bic                    text,
  -- Gemeinnützigkeit (Zuwendungsbestätigungen, Dojo-Master-Pro)
  finanzamt              text,
  steuernummer           text,
  freistellung_art       text check (freistellung_art in ('freistellung', 'anlage', 'feststellung')),
  freistellung_datum     date,
  freistellung_zeitraum  text,
  gemeinnuetzige_zwecke  text,
  logo                   bytea,
  logo_typ               text,
  erstellt_am            timestamptz not null default now(),
  geaendert_am           timestamptz not null default now(),
  geaendert_von          uuid,
  geloescht_am           timestamptz,
  change_seq             bigint not null default nextval('change_seq')
);
create unique index vereine_name_uq on vereine (lower(name)) where geloescht_am is null;

-- Trainingsgruppen (Dojo-Master-Pro „gruppen“, Kyu-Manager-Pro „groups“)
create table gruppen (
  id               uuid primary key default gen_random_uuid(),
  verein_id        uuid not null references vereine(id),
  name             text not null,
  trainingszeiten  text,
  sortierung       integer not null default 0,
  erstellt_am      timestamptz not null default now(),
  geaendert_am     timestamptz not null default now(),
  geaendert_von    uuid,
  geloescht_am     timestamptz,
  change_seq       bigint not null default nextval('change_seq'),
  unique (verein_id, id)                           -- Ziel für vereinsgebundene Verweise
);
create unique index gruppen_name_uq on gruppen (verein_id, lower(name)) where geloescht_am is null;


-- =====================================================================================================================
-- 2. Zahler, SEPA-Mandate, IBANs: bewusst NICHT hier. Sie gehören dem Abrechnungs-Tool (Dojo-Master-Pro); gemeinsamer
--    Schlüssel zum Zuordnen ist mitglieder.djb_id bzw. mitglieder.id.
-- =====================================================================================================================


-- =====================================================================================================================
-- 3. Mitglieder, Graduierungen, Lizenzen
-- =====================================================================================================================

-- Eine Zeile je Vereinsmitgliedschaft. Doppelmitgliedschaften (Spalte „führender Verein“ im DJB-Export)
-- lassen sich über die Judopass-Nummer vereinsübergreifend zuordnen.
create table mitglieder (
  id                 uuid primary key default gen_random_uuid(),
  verein_id          uuid not null references vereine(id),
  mitgliedsnr        integer not null,
  vorname            text not null,
  nachname           text not null,
  geburtsdatum       date,
  geschlecht         char(1) check (geschlecht in ('m', 'w', 'd')),
  nationalitaet      text,
  strasse            text,
  plz                text,
  ort                text,
  land               char(2) not null default 'DE',
  email              text,
  telefon            text,
  eintritt           date,                         -- Anmeldedatum; setzt nur Dojo-Master-Pro (Scope mitglieder:eintritt), nie der Import
  kuendigung_am      date,                         -- Eingang der Kündigung
  austritt           date,
  status             text not null default 'aktiv' check (status in ('aktiv', 'ruhend', 'ausgetreten')),
  -- Merkmale für die Tarifermittlung (Beitragsklassen selbst bleiben in Dojo-Master-Pro)
  ehrenmitglied      boolean not null default false,
  ausbildung_bis     date,                         -- Azubi/Studium (ermäßigter Tarif bis)
  djb_id             text,                         -- ID aus dem DJB-Portal-Export
  judopass_url       text,
  erstellt_am        timestamptz not null default now(),
  geaendert_am       timestamptz not null default now(),
  geaendert_von      uuid,
  geloescht_am       timestamptz,
  anonymisiert_am    timestamptz,
  change_seq         bigint not null default nextval('change_seq'),
  unique (verein_id, mitgliedsnr),
  unique (verein_id, id)
);
create index mitglieder_name_idx on mitglieder (verein_id, lower(nachname), lower(vorname));
create index mitglieder_austritt_idx on mitglieder (austritt) where anonymisiert_am is null;

-- Gruppenzugehörigkeit. Austragen = geloescht_am setzen (Soft Delete), erneutes Eintragen = geloescht_am leeren,
-- damit Apps das Austragen beim Abgleich mitbekommen.
create table mitglied_gruppen (
  verein_id     uuid not null references vereine(id),
  mitglied_id   uuid not null,
  gruppe_id     uuid not null,
  erstellt_am   timestamptz not null default now(),
  geaendert_am  timestamptz not null default now(),
  geaendert_von uuid,
  geloescht_am  timestamptz,
  change_seq    bigint not null default nextval('change_seq'),
  primary key (mitglied_id, gruppe_id),
  foreign key (verein_id, mitglied_id) references mitglieder (verein_id, id) on delete cascade,
  foreign key (verein_id, gruppe_id) references gruppen (verein_id, id) on delete cascade
);
create index mitglied_gruppen_gruppe_idx on mitglied_gruppen (gruppe_id);

-- Graduierungshistorie (9. Kyu … 1. Kyu, 1. … 10. Dan). Der aktuelle Grad ergibt sich aus der View unten.
-- Modulprüfungen (Kyu-Manager-Pro) und Prüfungsabrechnung (Dojo-Master-Pro) bleiben in den Apps.
create table graduierungen (
  id            uuid primary key default gen_random_uuid(),
  verein_id     uuid not null references vereine(id),
  mitglied_id   uuid not null,
  art           text not null check (art in ('kyu', 'dan')),
  stufe         smallint not null,
  datum         date,
  urkunden_nr   text,                              -- „KYU-13230“, „DAN-10475“
  pruefer       text,
  ort           text,
  quelle        text not null default 'manuell'
                check (quelle in ('manuell', 'import', 'dojo-master-pro', 'kyu-manager-pro', 'dan-manager-pro')),
  erstellt_am   timestamptz not null default now(),
  geaendert_am  timestamptz not null default now(),
  geaendert_von uuid,
  geloescht_am  timestamptz,
  change_seq    bigint not null default nextval('change_seq'),
  check ((art = 'kyu' and stufe between 1 and 9) or (art = 'dan' and stufe between 1 and 10)),
  unique (mitglied_id, art, stufe),
  foreign key (verein_id, mitglied_id) references mitglieder (verein_id, id) on delete cascade
);

-- Ausweise, Lizenzen und Nachweise mit Gültigkeit (DJB-Export: Judopass, Wettkampflizenz, Graduierungslizenz,
-- eFZ-Prüfer, Ehrenkodex, Erste Hilfe …). Das erweiterte Führungszeugnis steht NICHT hier, sondern in
-- fuehrungszeugnis_einsichten (gesetzlich eingeschränkte Speicherung).
create table lizenzen (
  id              uuid primary key default gen_random_uuid(),
  verein_id       uuid not null references vereine(id),
  mitglied_id     uuid not null,
  art             text not null check (art in (
                    'judopass', 'wettkampflizenz', 'graduierungslizenz', 'pruefer_lizenz', 'trainerlizenz',
                    'efz_pruefer', 'ehrenkodex', 'erste_hilfe', 'sonstige')),
  bezeichnung     text,                            -- z. B. „Graduierungslizenz – NW“, „Trainer C Breitensport“
  nummer          text,
  ausgestellt_am  date,
  gueltig_bis     date,
  aussteller      text,                            -- Verband / Stelle
  dokument_id     uuid,                            -- FK unten
  erstellt_am     timestamptz not null default now(),
  geaendert_am    timestamptz not null default now(),
  geaendert_von   uuid,
  geloescht_am    timestamptz,
  change_seq      bigint not null default nextval('change_seq'),
  foreign key (verein_id, mitglied_id) references mitglieder (verein_id, id) on delete cascade
);
create unique index lizenzen_nummer_uq on lizenzen (verein_id, art, nummer)
  where nummer is not null and geloescht_am is null;
create index lizenzen_mitglied_idx on lizenzen (mitglied_id, art);
create index lizenzen_ablauf_idx on lizenzen (verein_id, gueltig_bis);

-- Dateien zu Mitgliedern (Passfoto, Scan des Erste-Hilfe-Nachweises). Keine Führungszeugnisse (§ 72a SGB VIII)!
-- inhalt ist nur nach dem Löschen bzw. Anonymisieren leer.
create table dokumente (
  id            uuid primary key default gen_random_uuid(),
  verein_id     uuid not null references vereine(id),
  mitglied_id   uuid,
  art           text not null check (art in ('passfoto', 'erste_hilfe', 'sonstiges')),
  dateiname     text not null,
  mime_typ      text not null,
  groesse       integer not null,
  inhalt        bytea,
  erstellt_am   timestamptz not null default now(),
  geaendert_am  timestamptz not null default now(),
  geaendert_von uuid,
  geloescht_am  timestamptz,
  change_seq    bigint not null default nextval('change_seq'),
  unique (verein_id, id),
  foreign key (verein_id, mitglied_id) references mitglieder (verein_id, id) on delete cascade,
  check (inhalt is not null or geloescht_am is not null)
);
create index dokumente_mitglied_idx on dokumente (mitglied_id);

alter table lizenzen add constraint lizenzen_dokument_fk
  foreign key (verein_id, dokument_id) references dokumente (verein_id, id) on delete set null (dokument_id);

-- Einsicht in das erweiterte Führungszeugnis (§ 72a Abs. 5 SGB VIII). Gespeichert werden dürfen nur:
-- dass eingesehen wurde, das Datum des Zeugnisses und ob eine einschlägige Verurteilung vorliegt.
-- Keine Kopie, keine Zeugnisnummer. Löschen: sofort, wenn die Person die Tätigkeit nicht aufnimmt, sonst spätestens
-- drei Monate nach Ende der Tätigkeit (datenschutz_bereinigen() löscht ab loeschen_ab endgültig).
-- Wird nicht per Delta-Abgleich an Apps verteilt, sondern nur live abgefragt (Scope mitglieder:efz).
create table fuehrungszeugnis_einsichten (
  id                       uuid primary key default gen_random_uuid(),
  verein_id                uuid not null references vereine(id),
  mitglied_id              uuid not null,
  zeugnis_datum            date not null,         -- Ausstellungsdatum des Zeugnisses
  eingesehen_am            date not null,
  eingesehen_von           uuid,                  -- benutzer.id (FK unten)
  einschlaegig_verurteilt  boolean not null,      -- Straftat nach § 72a Abs. 1 SGB VIII eingetragen
  taetigkeit_beendet_am    date,
  loeschen_ab              date generated always as ((taetigkeit_beendet_am + interval '3 months')::date) stored,
  erstellt_am              timestamptz not null default now(),
  foreign key (verein_id, mitglied_id) references mitglieder (verein_id, id) on delete cascade
);
create index fuehrungszeugnis_mitglied_idx on fuehrungszeugnis_einsichten (verein_id, mitglied_id);
create index fuehrungszeugnis_loeschen_idx on fuehrungszeugnis_einsichten (loeschen_ab);


-- =====================================================================================================================
-- 4. Anwendungen und Rechte
--
-- Rollen (fest, je Verein genau eine):  admin | mitglied      → benutzer_vereine.rolle
--                         global:       Super-Admin           → benutzer.ist_super_admin
-- Rechte (Funktionen, beliebig viele):  trainer, pruefer, kassierer, … → benutzer_rechte
-- Rollen und Rechte gelten app-übergreifend; welche API-Scopes daraus folgen, legt der Server im Code fest.
-- =====================================================================================================================

-- Registrierte Anwendungen (OAuth-Clients). client_secret_hash nur für Server-zu-Server-Zugriffe.
-- Die Obergrenze (scopes, lizenz_arten) gilt für Benutzer-Tokens und für den Server-zu-Server-Abgleich; wirksame Scopes
-- sind immer die Schnittmenge aus Benutzer-Scopes und dieser Obergrenze (siehe api-entwurf.md, Abschnitt 3).
create table anwendungen (
  id                  uuid primary key default gen_random_uuid(),
  schluessel          text not null unique,        -- 'dojo-master-pro', 'hajime-pro', 'kyu-manager-pro'
  name                text not null,
  client_secret_hash  text,
  scopes              text[] not null default '{}', -- Obergrenze: höchstens diese API-Scopes bekommen Benutzer-Tokens dieser App
  client_scopes       text[] not null default '{}', -- Scopes im Abgleich ohne Benutzer (Client-Credentials), Teilmenge von scopes
  lizenz_arten        text[],                      -- null = alle Lizenzarten; sonst werden nur diese Arten ausgeliefert
  redirect_uris       text[] not null default '{}',
  aktiv               boolean not null default true,
  erstellt_am         timestamptz not null default now(),
  check (client_scopes <@ scopes)
);

-- Rechte = Funktionen im Verein (Trainer, Prüfer, Kassierer …).
create table rechte (
  id            uuid primary key default gen_random_uuid(),
  schluessel    text not null unique,
  name          text not null,
  beschreibung  text,
  sortierung    integer not null default 100
);


-- =====================================================================================================================
-- 5. Benutzer und Zuordnungen
-- =====================================================================================================================

-- Ein Konto für alle Apps (Single Sign-on). Benutzer sind unabhängig von Mitgliedern, lassen sich je Verein
-- aber mit einem Mitglied verknüpfen (benutzer_vereine.mitglied_id).
create table benutzer (
  id                          uuid primary key default gen_random_uuid(),
  benutzername                text not null,
  email                       text,
  vorname                     text,
  nachname                    text,
  passwort_hash               text,                -- argon2id/scrypt; null = nur Einladung/Reset möglich
  pin_hash                    text,                -- Schnellanmeldung an Vereins-Tablets (Kyu-Manager-Pro)
  aktiv                       boolean not null default true,
  muss_passwort_aendern       boolean not null default false,
  email_bestaetigt_am         timestamptz,
  ist_super_admin             boolean not null default false,
  fehlversuche                smallint not null default 0,
  pin_fehlversuche            smallint not null default 0,
  gesperrt_bis                timestamptz,
  letzte_anmeldung_am         timestamptz,
  passwort_geaendert_am       timestamptz,
  totp_secret_verschluesselt  text,
  totp_aktiv_am               timestamptz,
  totp_letzter_schritt        bigint,
  erstellt_am                 timestamptz not null default now(),
  geaendert_am                timestamptz not null default now(),
  geaendert_von               uuid,
  geloescht_am                timestamptz,
  anonymisiert_am             timestamptz,
  change_seq                  bigint not null default nextval('change_seq')
);
create unique index benutzer_benutzername_uq on benutzer (lower(benutzername));
create unique index benutzer_email_uq on benutzer (lower(email)) where email is not null;

-- Zugehörigkeit eines Benutzers zu einem Verein mit seiner Rolle dort (Freigabe-Workflow aus Hajime-Pro).
create table benutzer_vereine (
  id               uuid primary key default gen_random_uuid(),
  benutzer_id      uuid not null references benutzer(id) on delete cascade,
  verein_id        uuid not null references vereine(id),
  rolle            text not null default 'mitglied' check (rolle in ('admin', 'mitglied')),
  mitglied_id      uuid,                           -- Mitglied desselben Vereins (FK unten)
  status           text not null default 'angefragt'
                   check (status in ('angefragt', 'freigegeben', 'abgelehnt', 'gesperrt')),
  angefragt_ueber  text,                           -- 'verwaltung', 'helfer-app', 'einladung', 'selbstregistrierung'
  entschieden_von  uuid references benutzer(id),
  entschieden_am   timestamptz,
  erstellt_am      timestamptz not null default now(),
  geaendert_am     timestamptz not null default now(),
  geaendert_von    uuid,
  geloescht_am     timestamptz,
  change_seq       bigint not null default nextval('change_seq'),
  unique (benutzer_id, verein_id),
  foreign key (verein_id, mitglied_id) references mitglieder (verein_id, id) on delete set null (mitglied_id)
);
create unique index benutzer_vereine_mitglied_uq on benutzer_vereine (mitglied_id) where mitglied_id is not null;
create index benutzer_vereine_verein_idx on benutzer_vereine (verein_id, status);

-- Direkt vergebene Rechte je Benutzer und Verein (nur innerhalb einer bestehenden Vereinszugehörigkeit).
-- attribute: rechtspezifische Zusatzangaben, z. B. für 'trainer' in Kyu-Manager-Pro
--   {"graduierungsberechtigt": true, "kyu_von": 8, "kyu_bis": 4}
create table benutzer_rechte (
  id            uuid primary key default gen_random_uuid(),
  benutzer_id   uuid not null,
  verein_id     uuid not null,
  recht_id      uuid not null references rechte(id),
  gueltig_von   date,
  gueltig_bis   date,
  attribute     jsonb not null default '{}',
  vergeben_von  uuid references benutzer(id),
  erstellt_am   timestamptz not null default now(),
  geaendert_am  timestamptz not null default now(),
  geaendert_von uuid,
  geloescht_am  timestamptz,
  change_seq    bigint not null default nextval('change_seq'),
  foreign key (benutzer_id, verein_id) references benutzer_vereine (benutzer_id, verein_id) on delete cascade,
  unique (benutzer_id, verein_id, recht_id),
  check (gueltig_bis is null or gueltig_von is null or gueltig_bis >= gueltig_von)
);

-- Eltern-Zugang (Kyu-Manager-Pro): ein Konto sieht mehrere Kinder. Setzt eine Vereinszugehörigkeit des Eltern-Kontos
-- im Verein des Kindes voraus (wirksam nur, wenn diese freigegeben ist). Entfernen = geloescht_am setzen.
create table erziehungsberechtigte (
  benutzer_id   uuid not null,
  verein_id     uuid not null,
  mitglied_id   uuid not null,
  beziehung     text,                              -- 'mutter', 'vater', 'vormund' …
  erstellt_am   timestamptz not null default now(),
  geaendert_am  timestamptz not null default now(),
  geaendert_von uuid,
  geloescht_am  timestamptz,
  change_seq    bigint not null default nextval('change_seq'),
  primary key (benutzer_id, mitglied_id),
  foreign key (benutzer_id, verein_id) references benutzer_vereine (benutzer_id, verein_id) on delete cascade,
  foreign key (verein_id, mitglied_id) references mitglieder (verein_id, id) on delete cascade
);
create index erziehungsberechtigte_mitglied_idx on erziehungsberechtigte (mitglied_id);

alter table fuehrungszeugnis_einsichten add constraint fuehrungszeugnis_eingesehen_von_fk
  foreign key (eingesehen_von) references benutzer(id) on delete set null;


-- =====================================================================================================================
-- 6. Anmeldung: Geräte, Tokens, zweiter Faktor, Signaturschlüssel
-- =====================================================================================================================

create table geraete (
  id                uuid primary key default gen_random_uuid(),
  verein_id         uuid not null references vereine(id),
  anwendung_id      uuid not null references anwendungen(id),
  benutzer_id       uuid references benutzer(id),  -- null = Vereinsgerät (Tablet in der Halle)
  name              text not null,
  typ               text not null check (typ in ('tablet', 'phone', 'pc')),
  letzter_sync_am   timestamptz,
  gesperrt          boolean not null default false,
  erstellt_am       timestamptz not null default now()
);

-- Refresh-Tokens mit Rotation (ersetzt_durch) und Widerruf; nur der Hash wird gespeichert.
create table refresh_tokens (
  id             uuid primary key default gen_random_uuid(),
  benutzer_id    uuid not null references benutzer(id) on delete cascade,
  anwendung_id   uuid not null references anwendungen(id),
  verein_id      uuid references vereine(id),      -- aktiver Vereinskontext beim Ausstellen
  geraet_id      uuid references geraete(id),
  familie_id     uuid not null default gen_random_uuid(), -- alle durch Rotation entstandenen Tokens einer Anmeldung
  art            text not null default 'normal' check (art in ('normal', 'geraet')),
                                                   -- 'geraet' = langlebig (Offline-PIN am Tablet), an geraet_id gebunden
  token_hash     char(64) not null unique,
  erstellt_am    timestamptz not null default now(),
  laeuft_ab_am   timestamptz not null,
  widerrufen_am  timestamptz,
  ersetzt_durch  uuid references refresh_tokens(id) on delete set null,
  check (art = 'normal' or geraet_id is not null)
);
create index refresh_tokens_familie_idx on refresh_tokens (familie_id);
create index refresh_tokens_benutzer_idx on refresh_tokens (benutzer_id) where widerrufen_am is null;

-- Einmal-Links: E-Mail bestätigen, Passwort zurücksetzen, Einladung in einen Verein.
create table einmal_tokens (
  id            uuid primary key default gen_random_uuid(),
  benutzer_id   uuid not null references benutzer(id) on delete cascade,
  zweck         text not null check (zweck in ('email_bestaetigung', 'passwort_reset', 'einladung')),
  verein_id     uuid references vereine(id),
  rolle         text check (rolle in ('admin', 'mitglied')),  -- bei Einladung: vorgesehene Rolle
  rechte        text[] not null default '{}',      -- bei Einladung: vorgesehene Rechte (rechte.schluessel)
  token_hash    char(64) not null unique,
  laeuft_ab_am  timestamptz not null,
  benutzt_am    timestamptz,
  erstellt_am   timestamptz not null default now()
);

create table totp_backup_codes (
  id           uuid primary key default gen_random_uuid(),
  benutzer_id  uuid not null references benutzer(id) on delete cascade,
  code_hash    char(64) not null unique,
  benutzt_am   timestamptz,
  erstellt_am  timestamptz not null default now()
);

-- Schlüssel zum Signieren der Access-Tokens (JWKS-Endpunkt, Rotation über kid).
create table signaturschluessel (
  kid                          text primary key,
  algorithmus                  text not null default 'EdDSA' check (algorithmus in ('EdDSA', 'ES256', 'RS256')),
  public_key_jwk               jsonb not null,
  private_key_verschluesselt   text not null,
  aktiv_ab                     timestamptz not null default now(),
  signiert_bis                 timestamptz,        -- danach nur noch zur Prüfung veröffentlicht
  entfernt_am                  timestamptz
);


-- =====================================================================================================================
-- 7. Protokoll und Änderungs-Benachrichtigungen
-- =====================================================================================================================

-- Wer hat wann was geändert bzw. sensibel gelesen (aktion 'iban_gelesen'). IBANs nur maskiert in alt/neu.
create table audit_log (
  id            bigserial primary key,
  zeitpunkt     timestamptz not null default now(),
  verein_id     uuid,
  benutzer_id   uuid,
  anwendung_id  uuid,
  tabelle       text not null,
  datensatz_id  uuid,
  aktion        text not null,                     -- 'anlegen', 'aendern', 'loeschen', 'iban_gelesen', 'anmeldung' …
  alt           jsonb,
  neu           jsonb,
  ip            inet
);
create index audit_log_verein_idx on audit_log (verein_id, zeitpunkt);
create index audit_log_datensatz_idx on audit_log (tabelle, datensatz_id);

-- Optional: Webhooks, damit Apps Änderungen sofort erfahren (sonst Delta-Abfrage über change_xid).
create table webhook_abos (
  id                   uuid primary key default gen_random_uuid(),
  anwendung_id         uuid not null references anwendungen(id) on delete cascade,
  verein_id            uuid references vereine(id), -- null = alle Vereine, die die Anwendung sehen darf
  url                  text not null,
  ereignisse           text[] not null,             -- 'mitglied.geaendert', …
  secret_verschluesselt text not null,              -- HMAC-Signatur der Zustellung
  aktiv                boolean not null default true,
  letzter_fehler       text,
  erstellt_am          timestamptz not null default now()
);


-- =====================================================================================================================
-- 8. Abgleich (Trigger, change_xid) und Views
--
-- Warum nicht einfach „change_seq > X“? Die Nummer wird beim Schreiben vergeben, sichtbar wird die Zeile aber erst beim
-- Commit. Ein langsamer Vorgang mit Nummer 100 kann nach einem schnellen mit 101 committen; wer dazwischen abfragt,
-- merkt sich 101 und verliert 100. Deshalb läuft der Cursor über die Transaktions-ID (xid8, 64 Bit, kein Überlauf):
-- alles unterhalb von pg_snapshot_xmin() ist garantiert abgeschlossen.
--
--   Abfrage (GET /mitglieder?seit=<stand>, erster Abgleich mit stand = 0):
--     select pg_snapshot_xmin(pg_current_snapshot()) as bis;                -- wird der neue <stand> der App
--     select * from mitglieder
--      where verein_id = $1 and change_xid >= $seit::xid8 and change_xid < $bis::xid8
--      order by change_xid;
--
--   Zeilen können doppelt kommen (z. B. nach erneuter Änderung), nie aber fehlen; Apps übernehmen per Upsert.
--   Zeilen mit geloescht_am bzw. anonymisiert_am sind Löschhinweise: die App entfernt den Datensatz lokal.
-- =====================================================================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'verbaende', 'vereine', 'gruppen', 'mitglieder', 'mitglied_gruppen', 'graduierungen',
    'lizenzen', 'dokumente', 'benutzer', 'benutzer_vereine', 'benutzer_rechte', 'erziehungsberechtigte']
  loop
    execute format('alter table %I add column change_xid xid8 not null default pg_current_xact_id()', t);
    if exists (select 1 from information_schema.columns
                where table_schema = current_schema() and table_name = t and column_name = 'verein_id') then
      execute format('create index %I on %I (verein_id, change_xid)', t || '_sync_idx', t);
    else
      execute format('create index %I on %I (change_xid)', t || '_sync_idx', t);
    end if;
    execute format('create trigger %I before insert or update on %I for each row execute function stammdaten_touch()',
                   t || '_touch', t);
  end loop;
end $$;

-- Aktueller (höchster) Grad je Mitglied: Dan vor Kyu, beim Kyu die kleinste Zahl.
create view mitglied_aktueller_grad as
select distinct on (g.mitglied_id)
       g.mitglied_id, g.art, g.stufe, g.datum,
       case when g.art = 'dan' then g.stufe || '. Dan' else g.stufe || '. Kyu' end as bezeichnung
from graduierungen g
where g.geloescht_am is null
order by g.mitglied_id, (g.art = 'dan') desc, case when g.art = 'dan' then g.stufe else -g.stufe end desc;

-- Aktueller Judopass je Mitglied (Hajime-Pro: judopass_id + lizenz_ablauf, Kyu-Manager-Pro: pass_nr).
create view mitglied_judopass as
select distinct on (l.mitglied_id) l.mitglied_id, l.nummer, l.gueltig_bis
from lizenzen l
where l.art = 'judopass' and l.geloescht_am is null
order by l.mitglied_id, l.gueltig_bis desc nulls last;

-- Wirksame Rechte: nur freigegebene Vereinszugehörigkeiten und laufende Gültigkeit.
create view benutzer_wirksame_rechte as
select br.benutzer_id, br.verein_id, r.schluessel as recht, br.attribute
from benutzer_rechte br
join benutzer_vereine bv on bv.benutzer_id = br.benutzer_id and bv.verein_id = br.verein_id
join rechte r on r.id = br.recht_id
where br.geloescht_am is null and bv.status = 'freigegeben' and bv.geloescht_am is null
  and (br.gueltig_von is null or br.gueltig_von <= current_date)
  and (br.gueltig_bis is null or br.gueltig_bis >= current_date);


-- =====================================================================================================================
-- 9. Datenschutz: Aufbewahrungsfristen und Anonymisierung
--
-- datenschutz_bereinigen() läuft täglich. Seit Migration 008 (FR-78) bleiben Personendaten erhalten; bereinigt werden nur
-- Nebendaten (Tokens, Audit, Führungszeugnis-Einsichten). Die Fristen sind Vorschläge und mit dem
-- Datenschutzbeauftragten bzw. Steuerberater des Vereins abzustimmen.
-- =====================================================================================================================

create table aufbewahrungsfristen (
  schluessel    text primary key,
  frist         interval not null,
  beschreibung  text not null
);

insert into aufbewahrungsfristen (schluessel, frist, beschreibung) values
  ('mitglied_nach_austritt', '3 years',   'Ausgetretene Mitglieder ab Austrittsdatum (Verjährung von Beitragsforderungen, § 195 BGB)'),
  ('geloeschte_datensaetze', '30 days',   'Gelöschte Mitglieder und Benutzer (Papierkorb)'),
  ('audit_log',              '2 years',   'Protokolleinträge mit alt/neu-Werten'),
  ('abgelaufene_tokens',     '30 days',   'Abgelaufene oder widerrufene Refresh- und Einmal-Tokens');

create function frist(p_schluessel text) returns interval language sql stable as
  $$ select frist from aufbewahrungsfristen where schluessel = p_schluessel $$;

create function datenschutz_bereinigen() returns table (bereich text, anzahl bigint) language plpgsql as $$
declare n bigint;
begin
  -- 1. Mitglieder: ausgetreten und Frist abgelaufen, oder gelöscht und Papierkorb-Frist abgelaufen
  create temp table _mitglieder on commit drop as
    select id from mitglieder
     where anonymisiert_am is null
       and ((status = 'ausgetreten' and austritt < current_date - frist('mitglied_nach_austritt'))
         or geloescht_am < now() - frist('geloeschte_datensaetze'));

  update graduierungen set urkunden_nr = null, pruefer = null, ort = null, geloescht_am = coalesce(geloescht_am, now())
   where mitglied_id in (select id from _mitglieder);
  update lizenzen set nummer = null, bezeichnung = null, aussteller = null, dokument_id = null,
                      geloescht_am = coalesce(geloescht_am, now())
   where mitglied_id in (select id from _mitglieder);
  update dokumente set inhalt = null, dateiname = '', groesse = 0, geloescht_am = coalesce(geloescht_am, now())
   where mitglied_id in (select id from _mitglieder);
  update mitglied_gruppen set geloescht_am = now()
   where mitglied_id in (select id from _mitglieder) and geloescht_am is null;
  update erziehungsberechtigte set geloescht_am = now()
   where mitglied_id in (select id from _mitglieder) and geloescht_am is null;
  update benutzer_vereine set mitglied_id = null where mitglied_id in (select id from _mitglieder);
  delete from fuehrungszeugnis_einsichten where mitglied_id in (select id from _mitglieder);
  update mitglieder set
         vorname = '', nachname = 'Anonymisiert', geburtsdatum = null, geschlecht = null, nationalitaet = null,
         strasse = null, plz = null, ort = null, email = null, telefon = null, ausbildung_bis = null,
         djb_id = null, judopass_url = null,
         geloescht_am = coalesce(geloescht_am, now()), anonymisiert_am = now()
   where id in (select id from _mitglieder);
  get diagnostics n = row_count;
  bereich := 'mitglieder'; anzahl := n; return next;

  -- 2. Benutzer: gelöscht und Papierkorb-Frist abgelaufen
  create temp table _benutzer on commit drop as
    select id from benutzer where anonymisiert_am is null and geloescht_am < now() - frist('geloeschte_datensaetze');
  delete from refresh_tokens where benutzer_id in (select id from _benutzer);
  delete from einmal_tokens where benutzer_id in (select id from _benutzer);
  delete from totp_backup_codes where benutzer_id in (select id from _benutzer);
  update erziehungsberechtigte set geloescht_am = now()
   where benutzer_id in (select id from _benutzer) and geloescht_am is null;
  update benutzer_rechte set geloescht_am = now()
   where benutzer_id in (select id from _benutzer) and geloescht_am is null;
  update benutzer_vereine set mitglied_id = null, geloescht_am = coalesce(geloescht_am, now())
   where benutzer_id in (select id from _benutzer);
  update benutzer set benutzername = 'geloescht-' || id, email = null, vorname = null, nachname = null,
                      passwort_hash = null, pin_hash = null, aktiv = false, totp_secret_verschluesselt = null,
                      totp_aktiv_am = null, anonymisiert_am = now()
   where id in (select id from _benutzer);
  get diagnostics n = row_count;
  bereich := 'benutzer'; anzahl := n; return next;

  -- 3. Führungszeugnis-Einsichten: drei Monate nach Ende der Tätigkeit endgültig löschen
  delete from fuehrungszeugnis_einsichten where loeschen_ab <= current_date;
  get diagnostics n = row_count;
  bereich := 'fuehrungszeugnis_einsichten'; anzahl := n; return next;

  -- 4. Protokoll und abgelaufene Tokens
  delete from audit_log where zeitpunkt < now() - frist('audit_log');
  get diagnostics n = row_count;
  bereich := 'audit_log'; anzahl := n; return next;

  delete from refresh_tokens where least(widerrufen_am, laeuft_ab_am) < now() - frist('abgelaufene_tokens');
  delete from einmal_tokens where laeuft_ab_am < now() - frist('abgelaufene_tokens');
end $$;


-- =====================================================================================================================
-- 10. Grunddaten: Anwendungen und Rechte
-- =====================================================================================================================

-- scopes = Obergrenze für Benutzer-Tokens (Hajime-Pro und Kyu-Manager-Pro bekommen nie Kontakt- oder Bankdaten);
-- client_scopes = was die App im Server-zu-Server-Abgleich ohne Benutzer bekommt (Teilmenge von scopes);
-- lizenz_arten = nur diese Lizenzarten werden ausgeliefert (null = alle).
insert into anwendungen (schluessel, name, scopes, client_scopes, lizenz_arten) values
  ('dojo-master-pro', 'Dojo-Master-Pro',
     '{mitglieder:selbst,mitglieder:lesen,mitglieder:person,mitglieder:mitgliedschaft,mitglieder:kontakt,mitglieder:tarif,mitglieder:verwaltung,mitglieder:ausgetretene,mitglieder:schreiben,graduierungen:lesen,graduierungen:schreiben,lizenzen:judopass,lizenzen:lesen,lizenzen:schreiben,mitglieder:efz,vereine:lesen,vereine:kontakt,vereine:finanzen,vereine:schreiben,gruppen:lesen,gruppen:schreiben,benutzer:verwalten,rechte:verwalten}',
     '{vereine:lesen,gruppen:lesen,mitglieder:lesen,mitglieder:person,mitglieder:mitgliedschaft,mitglieder:kontakt,mitglieder:tarif,mitglieder:ausgetretene,graduierungen:lesen,lizenzen:judopass,lizenzen:lesen}',
     null),
  ('hajime-pro',      'Hajime-Pro',
     '{mitglieder:selbst,mitglieder:lesen,mitglieder:person,lizenzen:judopass,lizenzen:lesen,vereine:lesen,benutzer:verwalten,rechte:verwalten}',
     '{vereine:lesen,mitglieder:lesen,mitglieder:person,lizenzen:judopass,lizenzen:lesen}',
     '{judopass,wettkampflizenz}'),
  ('kyu-manager-pro', 'Kyu-Manager-Pro',
     '{mitglieder:selbst,mitglieder:lesen,mitglieder:person,graduierungen:lesen,graduierungen:schreiben,lizenzen:judopass,lizenzen:lesen,vereine:lesen,gruppen:lesen,gruppen:schreiben,benutzer:verwalten,benutzer:schueler,rechte:verwalten}',
     '{vereine:lesen,gruppen:lesen,mitglieder:lesen,mitglieder:person,graduierungen:lesen,graduierungen:schreiben,lizenzen:judopass,lizenzen:lesen}',
     '{judopass,graduierungslizenz,pruefer_lizenz}');

insert into rechte (schluessel, name, beschreibung, sortierung) values
  ('trainer',       'Trainer',       'Gruppen und Mitglieder betreuen, Anwesenheit, Beobachtungen',            10),
  ('pruefer',       'Prüfer',        'Prüfungen abnehmen und Graduierungen eintragen',                         20),
  ('kassierer',     'Kassierer',     'Beiträge und Buchhaltung (im Abrechnungs-Tool)',      30),
  ('kassenpruefer', 'Kassenprüfer',  'Kasse und Buchhaltung nur lesend einsehen',                              40);
