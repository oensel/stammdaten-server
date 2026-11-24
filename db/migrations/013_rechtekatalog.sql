-- FR-20, FR-21: Rechtekatalog und Systemrollen. Eigene Katalogtabelle statt der Ist-Tabelle `rechte`, weil /v1 jeden Eintrag
-- dort vergeben lässt. Datenfilter der Seed-Matrix (z. B. Trainer ohne Kontaktdaten) folgen mit Story 2.5; bis dahin wertet
-- darf() die Rollenberechtigungen nicht für Personendaten aus.
create table katalog_rechte (
  schluessel            text primary key,
  name                  text not null,
  vereinsrolle_erlaubt  boolean not null default false      -- Positivliste vereinseigener Rollen (E98)
);
create table rechte_operationen (
  recht      text not null references katalog_rechte(schluessel),
  operation  text not null check (operation in ('LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN', 'SUCHEN', 'DELEGIEREN')),
  primary key (recht, operation)
);
create table rollen (
  id            uuid primary key default gen_random_uuid(),
  schluessel    text not null,
  name          text not null,
  ebene         text not null check (ebene in ('global', 'verein', 'verband')),
  verband_typen text[],                                     -- nur Verbandsrollen: wo vergebbar
  verein_id     uuid references vereine(id),                -- null = globale Rolle, sonst vereinseigen
  ist_system    boolean not null default false,
  constraint rollen_schluessel_uq unique nulls not distinct (verein_id, schluessel),
  check (ebene = 'verein' or verein_id is null),
  check (not ist_system or verein_id is null),
  check ((ebene = 'verband') = (verband_typen is not null))
);
create table rollen_berechtigungen (
  rolle_id   uuid not null references rollen(id) on delete cascade,
  recht      text not null,
  operation  text not null,
  primary key (rolle_id, recht, operation),
  constraint operation_nicht_definiert foreign key (recht, operation) references rechte_operationen (recht, operation)
);

create function systemrolle_schuetzen() returns trigger language plpgsql as $$
begin
  if old.ist_system and (tg_op = 'DELETE' or not new.ist_system or new.schluessel <> old.schluessel) then
    raise exception 'Systemrollen sind nicht löschbar' using errcode = 'check_violation', constraint = 'systemrolle_geschuetzt';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger systemrolle_schutz before update or delete on rollen for each row execute function systemrolle_schuetzen();

insert into katalog_rechte (schluessel, name, vereinsrolle_erlaubt) values
  ('mitglieder', 'Mitglieder', true),
  ('personen', 'Personensuche', false),
  ('personen_zusammenfuehrung', 'Personen zusammenführen', false),
  ('graduierung', 'Graduierungen', true),
  ('pruefung', 'Prüfungen', true),
  ('pruefung_abnahme', 'Prüfungen abnehmen', false),
  ('pruefung_abschluss', 'Prüfungen abschließen', false),
  ('vereine', 'Vereine', false),
  ('verbandsbaum', 'Verbandsbaum', false),
  ('fristen', 'Fristen', false),
  ('zugehoerigkeit', 'Vereinszugehörigkeiten', false),
  ('rolle', 'Rollen', false),
  ('verbandsrolle', 'Verbandsrollen', false),
  ('mitgliedschaftsantrag', 'Mitgliedschaftsanträge', true),
  ('transfer', 'Transfer', false),
  ('lizenz', 'Lizenzen', false),
  ('lizenz_aussetzung', 'Lizenzaussetzungen', false),
  ('judopass_antrag', 'Judopass-Anträge', false),
  ('zahlungsweise', 'Zahlungsweise', false),
  ('gebuehren', 'Gebühren', false),
  ('ueberweisung', 'Überweisungen', true),
  ('beitraege', 'Beitragsdaten', true),
  ('rechnungslauf', 'Rechnungslauf', false),
  ('forderungen', 'Forderungen', false),
  ('mandate', 'Mandate', false),
  ('lehrgang', 'Lehrgänge', false),
  ('lehrgang_freigabe', 'Lehrgangsfreigabe', false),
  ('lehrgang_teilnahme', 'Lehrgangsteilnahmen', true),
  ('lehrgangstyp', 'Lehrgangstypen', false),
  ('turnier', 'Turniere', false),
  ('veranstaltung', 'Veranstaltungen', false),
  ('turnier_meldung', 'Turniermeldungen', true),
  ('mannschaft', 'Mannschaften', true),
  ('veranstaltung_anmeldung', 'Veranstaltungsanmeldungen', true);

insert into rechte_operationen (recht, operation) values
  ('mitglieder', 'LESEN'), ('mitglieder', 'ANLEGEN'), ('mitglieder', 'AENDERN'), ('mitglieder', 'LOESCHEN'), ('mitglieder', 'DELEGIEREN'),
  ('personen', 'SUCHEN'),
  ('personen_zusammenfuehrung', 'AENDERN'),
  ('graduierung', 'LESEN'), ('graduierung', 'DELEGIEREN'),
  ('pruefung', 'LESEN'), ('pruefung', 'ANLEGEN'), ('pruefung', 'AENDERN'), ('pruefung', 'LOESCHEN'), ('pruefung', 'DELEGIEREN'),
  ('pruefung_abnahme', 'AENDERN'),
  ('pruefung_abschluss', 'AENDERN'),
  ('vereine', 'LESEN'), ('vereine', 'ANLEGEN'), ('vereine', 'AENDERN'), ('vereine', 'LOESCHEN'),
  ('verbandsbaum', 'LESEN'), ('verbandsbaum', 'AENDERN'),
  ('fristen', 'LESEN'), ('fristen', 'AENDERN'),
  ('zugehoerigkeit', 'LESEN'), ('zugehoerigkeit', 'AENDERN'),
  ('rolle', 'LESEN'), ('rolle', 'ANLEGEN'), ('rolle', 'AENDERN'), ('rolle', 'LOESCHEN'),
  ('verbandsrolle', 'LESEN'), ('verbandsrolle', 'ANLEGEN'), ('verbandsrolle', 'LOESCHEN'),
  ('mitgliedschaftsantrag', 'LESEN'), ('mitgliedschaftsantrag', 'ANLEGEN'), ('mitgliedschaftsantrag', 'AENDERN'), ('mitgliedschaftsantrag', 'DELEGIEREN'),
  ('transfer', 'LESEN'), ('transfer', 'ANLEGEN'), ('transfer', 'AENDERN'),
  ('lizenz', 'LESEN'), ('lizenz', 'ANLEGEN'), ('lizenz', 'AENDERN'),
  ('lizenz_aussetzung', 'ANLEGEN'), ('lizenz_aussetzung', 'AENDERN'),
  ('judopass_antrag', 'LESEN'), ('judopass_antrag', 'ANLEGEN'), ('judopass_antrag', 'AENDERN'),
  ('zahlungsweise', 'LESEN'), ('zahlungsweise', 'AENDERN'),
  ('gebuehren', 'LESEN'), ('gebuehren', 'AENDERN'),
  ('ueberweisung', 'LESEN'), ('ueberweisung', 'ANLEGEN'), ('ueberweisung', 'AENDERN'), ('ueberweisung', 'DELEGIEREN'),
  ('beitraege', 'LESEN'), ('beitraege', 'AENDERN'), ('beitraege', 'DELEGIEREN'),
  ('rechnungslauf', 'LESEN'), ('rechnungslauf', 'ANLEGEN'), ('rechnungslauf', 'AENDERN'),
  ('forderungen', 'LESEN'), ('forderungen', 'AENDERN'),
  ('mandate', 'LESEN'),
  ('lehrgang', 'LESEN'), ('lehrgang', 'ANLEGEN'), ('lehrgang', 'AENDERN'), ('lehrgang', 'LOESCHEN'),
  ('lehrgang_freigabe', 'AENDERN'),
  ('lehrgang_teilnahme', 'LESEN'), ('lehrgang_teilnahme', 'AENDERN'), ('lehrgang_teilnahme', 'DELEGIEREN'),
  ('lehrgangstyp', 'LESEN'), ('lehrgangstyp', 'ANLEGEN'), ('lehrgangstyp', 'AENDERN'), ('lehrgangstyp', 'LOESCHEN'),
  ('turnier', 'LESEN'), ('turnier', 'ANLEGEN'), ('turnier', 'AENDERN'), ('turnier', 'LOESCHEN'),
  ('veranstaltung', 'LESEN'), ('veranstaltung', 'ANLEGEN'), ('veranstaltung', 'AENDERN'), ('veranstaltung', 'LOESCHEN'),
  ('turnier_meldung', 'LESEN'), ('turnier_meldung', 'ANLEGEN'), ('turnier_meldung', 'AENDERN'), ('turnier_meldung', 'DELEGIEREN'),
  ('mannschaft', 'LESEN'), ('mannschaft', 'ANLEGEN'), ('mannschaft', 'AENDERN'), ('mannschaft', 'LOESCHEN'), ('mannschaft', 'DELEGIEREN'),
  ('veranstaltung_anmeldung', 'LESEN'), ('veranstaltung_anmeldung', 'AENDERN'), ('veranstaltung_anmeldung', 'DELEGIEREN');

insert into rollen (schluessel, name, ebene, verband_typen, ist_system) values
  ('super_admin', 'Super-Admin', 'global', null::text[], true),
  ('admin', 'Admin', 'verein', null::text[], true),
  ('trainer', 'Trainer', 'verein', null::text[], true),
  ('kassierer', 'Kassierer', 'verein', null::text[], true),
  ('kassenpruefer', 'Kassenprüfer', 'verein', null::text[], true),
  ('mitglied', 'Mitglied', 'verein', null::text[], true),
  ('veranstalter_admin_verein', 'Veranstalter-Admin (Verein)', 'verein', null::text[], true),
  ('veranstalter_admin_verband', 'Veranstalter-Admin (Verband)', 'verband', '{dachverband,landesverband,bezirk,kreis}', true),
  ('kreis_dan_vorsitzender', 'Kreis-Dan-Vorsitzender', 'verband', '{kreis}', true),
  ('bezirks_dan_beauftragter', 'Bezirks-Dan-Beauftragter', 'verband', '{bezirk}', true),
  ('landesvertreter', 'Landesvertreter', 'verband', '{landesverband}', true),
  ('lehrgangsfreigabe', 'Lehrgangsfreigabe', 'verband', '{landesverband,dachverband}', true),
  ('dan_pruefungsorganisation', 'Dan-Prüfungsorganisation', 'verband', '{landesverband}', true),
  ('verbandskassierer', 'Verbandskassierer', 'verband', '{dachverband,landesverband,bezirk,kreis}', true),
  ('lv_admin', 'Landesverbands-Admin', 'verband', '{landesverband}', true),
  ('djb_admin', 'DJB-Admin', 'verband', '{dachverband}', true);

insert into rollen_berechtigungen (rolle_id, recht, operation)
select r.id, b.recht, b.operation from (values
  ('admin', 'mitglieder', 'LESEN'), ('admin', 'mitglieder', 'ANLEGEN'), ('admin', 'mitglieder', 'AENDERN'), ('admin', 'mitglieder', 'LOESCHEN'), ('admin', 'mitglieder', 'DELEGIEREN'), ('admin', 'graduierung', 'LESEN'), ('admin', 'graduierung', 'DELEGIEREN'), ('admin', 'pruefung', 'LESEN'), ('admin', 'pruefung', 'ANLEGEN'), ('admin', 'pruefung', 'AENDERN'), ('admin', 'pruefung', 'LOESCHEN'), ('admin', 'pruefung', 'DELEGIEREN'), ('admin', 'vereine', 'LESEN'), ('admin', 'vereine', 'AENDERN'), ('admin', 'zugehoerigkeit', 'LESEN'), ('admin', 'zugehoerigkeit', 'AENDERN'), ('admin', 'rolle', 'LESEN'), ('admin', 'rolle', 'ANLEGEN'), ('admin', 'rolle', 'AENDERN'), ('admin', 'rolle', 'LOESCHEN'), ('admin', 'mitgliedschaftsantrag', 'LESEN'), ('admin', 'mitgliedschaftsantrag', 'AENDERN'), ('admin', 'mitgliedschaftsantrag', 'DELEGIEREN'), ('admin', 'transfer', 'LESEN'), ('admin', 'transfer', 'ANLEGEN'), ('admin', 'transfer', 'AENDERN'), ('admin', 'lizenz', 'LESEN'), ('admin', 'judopass_antrag', 'LESEN'), ('admin', 'judopass_antrag', 'ANLEGEN'), ('admin', 'judopass_antrag', 'AENDERN'), ('admin', 'zahlungsweise', 'LESEN'), ('admin', 'zahlungsweise', 'AENDERN'), ('admin', 'gebuehren', 'LESEN'), ('admin', 'gebuehren', 'AENDERN'), ('admin', 'ueberweisung', 'DELEGIEREN'), ('admin', 'beitraege', 'DELEGIEREN'), ('admin', 'lehrgang', 'LESEN'), ('admin', 'lehrgang_teilnahme', 'LESEN'), ('admin', 'lehrgang_teilnahme', 'AENDERN'), ('admin', 'lehrgang_teilnahme', 'DELEGIEREN'), ('admin', 'turnier_meldung', 'LESEN'), ('admin', 'turnier_meldung', 'ANLEGEN'), ('admin', 'turnier_meldung', 'AENDERN'), ('admin', 'turnier_meldung', 'DELEGIEREN'), ('admin', 'mannschaft', 'LESEN'), ('admin', 'mannschaft', 'ANLEGEN'), ('admin', 'mannschaft', 'AENDERN'), ('admin', 'mannschaft', 'LOESCHEN'), ('admin', 'mannschaft', 'DELEGIEREN'), ('admin', 'veranstaltung_anmeldung', 'LESEN'), ('admin', 'veranstaltung_anmeldung', 'AENDERN'), ('admin', 'veranstaltung_anmeldung', 'DELEGIEREN'),
  ('trainer', 'mitglieder', 'LESEN'), ('trainer', 'graduierung', 'LESEN'), ('trainer', 'pruefung', 'LESEN'), ('trainer', 'pruefung', 'ANLEGEN'), ('trainer', 'pruefung', 'AENDERN'), ('trainer', 'pruefung', 'LOESCHEN'), ('trainer', 'turnier_meldung', 'LESEN'), ('trainer', 'turnier_meldung', 'ANLEGEN'), ('trainer', 'turnier_meldung', 'AENDERN'), ('trainer', 'mannschaft', 'LESEN'), ('trainer', 'mannschaft', 'ANLEGEN'), ('trainer', 'mannschaft', 'AENDERN'), ('trainer', 'mannschaft', 'LOESCHEN'), ('trainer', 'lehrgang_teilnahme', 'LESEN'),
  ('kassierer', 'ueberweisung', 'LESEN'), ('kassierer', 'ueberweisung', 'ANLEGEN'), ('kassierer', 'ueberweisung', 'AENDERN'), ('kassierer', 'beitraege', 'LESEN'), ('kassierer', 'beitraege', 'AENDERN'),
  ('kassenpruefer', 'ueberweisung', 'LESEN'), ('kassenpruefer', 'beitraege', 'LESEN'),
  ('veranstalter_admin_verein', 'turnier', 'AENDERN'), ('veranstalter_admin_verein', 'turnier', 'LOESCHEN'), ('veranstalter_admin_verein', 'veranstaltung', 'AENDERN'), ('veranstalter_admin_verein', 'veranstaltung', 'LOESCHEN'), ('veranstalter_admin_verein', 'turnier_meldung', 'LESEN'), ('veranstalter_admin_verein', 'veranstaltung_anmeldung', 'LESEN'), ('veranstalter_admin_verein', 'veranstaltung_anmeldung', 'AENDERN'),
  ('veranstalter_admin_verband', 'turnier', 'AENDERN'), ('veranstalter_admin_verband', 'turnier', 'LOESCHEN'), ('veranstalter_admin_verband', 'veranstaltung', 'AENDERN'), ('veranstalter_admin_verband', 'veranstaltung', 'LOESCHEN'), ('veranstalter_admin_verband', 'turnier_meldung', 'LESEN'), ('veranstalter_admin_verband', 'veranstaltung_anmeldung', 'LESEN'), ('veranstalter_admin_verband', 'veranstaltung_anmeldung', 'AENDERN'),
  ('kreis_dan_vorsitzender', 'mitglieder', 'LESEN'), ('kreis_dan_vorsitzender', 'graduierung', 'LESEN'), ('kreis_dan_vorsitzender', 'lehrgang', 'LESEN'), ('kreis_dan_vorsitzender', 'lehrgang_freigabe', 'AENDERN'), ('kreis_dan_vorsitzender', 'lehrgang_teilnahme', 'LESEN'), ('kreis_dan_vorsitzender', 'pruefung', 'LESEN'), ('kreis_dan_vorsitzender', 'pruefung', 'ANLEGEN'), ('kreis_dan_vorsitzender', 'pruefung', 'AENDERN'), ('kreis_dan_vorsitzender', 'pruefung', 'LOESCHEN'), ('kreis_dan_vorsitzender', 'pruefung_abnahme', 'AENDERN'), ('kreis_dan_vorsitzender', 'pruefung_abschluss', 'AENDERN'),
  ('bezirks_dan_beauftragter', 'mitglieder', 'LESEN'), ('bezirks_dan_beauftragter', 'graduierung', 'LESEN'), ('bezirks_dan_beauftragter', 'pruefung', 'LESEN'), ('bezirks_dan_beauftragter', 'pruefung', 'ANLEGEN'), ('bezirks_dan_beauftragter', 'pruefung', 'AENDERN'), ('bezirks_dan_beauftragter', 'pruefung', 'LOESCHEN'), ('bezirks_dan_beauftragter', 'lehrgang_freigabe', 'AENDERN'), ('bezirks_dan_beauftragter', 'lehrgang_teilnahme', 'LESEN'), ('bezirks_dan_beauftragter', 'lehrgang_teilnahme', 'AENDERN'),
  ('landesvertreter', 'vereine', 'LESEN'), ('landesvertreter', 'vereine', 'ANLEGEN'), ('landesvertreter', 'vereine', 'AENDERN'), ('landesvertreter', 'vereine', 'LOESCHEN'), ('landesvertreter', 'mitglieder', 'LESEN'), ('landesvertreter', 'mitglieder', 'AENDERN'), ('landesvertreter', 'mitglieder', 'LOESCHEN'), ('landesvertreter', 'personen', 'SUCHEN'), ('landesvertreter', 'personen_zusammenfuehrung', 'AENDERN'), ('landesvertreter', 'judopass_antrag', 'LESEN'), ('landesvertreter', 'judopass_antrag', 'AENDERN'), ('landesvertreter', 'transfer', 'LESEN'), ('landesvertreter', 'transfer', 'ANLEGEN'), ('landesvertreter', 'transfer', 'AENDERN'), ('landesvertreter', 'lehrgang', 'LESEN'), ('landesvertreter', 'lehrgang_teilnahme', 'LESEN'), ('landesvertreter', 'lehrgang_teilnahme', 'AENDERN'),
  ('lehrgangsfreigabe', 'lehrgang', 'LESEN'), ('lehrgangsfreigabe', 'lehrgang_freigabe', 'AENDERN'),
  ('dan_pruefungsorganisation', 'pruefung', 'LESEN'), ('dan_pruefungsorganisation', 'pruefung', 'ANLEGEN'), ('dan_pruefungsorganisation', 'pruefung', 'AENDERN'), ('dan_pruefungsorganisation', 'pruefung', 'LOESCHEN'),
  ('verbandskassierer', 'rechnungslauf', 'LESEN'), ('verbandskassierer', 'rechnungslauf', 'ANLEGEN'), ('verbandskassierer', 'rechnungslauf', 'AENDERN'), ('verbandskassierer', 'forderungen', 'LESEN'), ('verbandskassierer', 'forderungen', 'AENDERN'), ('verbandskassierer', 'mandate', 'LESEN'),
  ('lv_admin', 'verbandsrolle', 'LESEN'), ('lv_admin', 'verbandsrolle', 'ANLEGEN'), ('lv_admin', 'verbandsrolle', 'LOESCHEN'), ('lv_admin', 'fristen', 'LESEN'), ('lv_admin', 'fristen', 'AENDERN'), ('lv_admin', 'gebuehren', 'LESEN'), ('lv_admin', 'gebuehren', 'AENDERN'), ('lv_admin', 'lehrgangstyp', 'LESEN'), ('lv_admin', 'lehrgangstyp', 'ANLEGEN'), ('lv_admin', 'lehrgangstyp', 'AENDERN'), ('lv_admin', 'lehrgangstyp', 'LOESCHEN'), ('lv_admin', 'lizenz', 'ANLEGEN'), ('lv_admin', 'lizenz', 'AENDERN'), ('lv_admin', 'lizenz_aussetzung', 'ANLEGEN'), ('lv_admin', 'lizenz_aussetzung', 'AENDERN'),
  ('djb_admin', 'verbandsbaum', 'LESEN'), ('djb_admin', 'verbandsbaum', 'AENDERN'), ('djb_admin', 'verbandsrolle', 'LESEN'), ('djb_admin', 'verbandsrolle', 'ANLEGEN'), ('djb_admin', 'verbandsrolle', 'LOESCHEN'), ('djb_admin', 'fristen', 'LESEN'), ('djb_admin', 'fristen', 'AENDERN'), ('djb_admin', 'gebuehren', 'LESEN'), ('djb_admin', 'gebuehren', 'AENDERN'), ('djb_admin', 'lehrgangstyp', 'LESEN'), ('djb_admin', 'lehrgangstyp', 'ANLEGEN'), ('djb_admin', 'lehrgangstyp', 'AENDERN'), ('djb_admin', 'lehrgangstyp', 'LOESCHEN'), ('djb_admin', 'lizenz', 'ANLEGEN'), ('djb_admin', 'lizenz', 'AENDERN'), ('djb_admin', 'lizenz_aussetzung', 'ANLEGEN'), ('djb_admin', 'lizenz_aussetzung', 'AENDERN')
) as b (rolle, recht, operation) join rollen r on r.schluessel = b.rolle and r.verein_id is null;
