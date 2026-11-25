-- Story 3.6 (FR-7, E70, E100): Antrag auf Mitgliedschaft in einem weiteren Verein. Überträgt nie den Pass.
create table mitgliedschaftsantraege (
  id              uuid primary key default gen_random_uuid(),
  verein_id       uuid not null references vereine(id),
  person_id       uuid references personen(id),          -- leer nur beim schriftlichen Antrag ohne Pass-Nr. bis zur Annahme
  vorname         text not null,
  nachname        text not null,
  geburtsdatum    date not null,
  judopass_nr     text,
  angaben         jsonb,                                 -- schriftlich ohne Pass-Nr.: Daten für die neue Person, nach der Entscheidung geleert
  gestellt_von    uuid references benutzer(id),
  erfasst_von     uuid references benutzer(id),
  status          text not null default 'offen' check (status in ('offen', 'angenommen', 'abgelehnt', 'zurueckgezogen', 'verfallen')),
  grund           text,
  entschieden_von uuid references benutzer(id),
  entschieden_am  timestamptz,
  erinnert_am     timestamptz,
  erstellt_am     timestamptz not null,
  geaendert_am    timestamptz not null default now(),
  geaendert_von   uuid,
  change_seq      bigint not null default nextval('change_seq'),
  change_xid      xid8 not null default pg_current_xact_id(),
  constraint antrag_herkunft check (num_nonnulls(gestellt_von, erfasst_von) = 1),
  constraint antrag_person check (person_id is not null or (erfasst_von is not null and status <> 'angenommen'))
);
create unique index ein_offener_mitgliedschaftsantrag on mitgliedschaftsantraege (verein_id, person_id) where status = 'offen' and person_id is not null;
create index mitgliedschaftsantraege_offen_idx on mitgliedschaftsantraege (verein_id) where status = 'offen';
create index mitgliedschaftsantraege_gestellt_idx on mitgliedschaftsantraege (gestellt_von);
create trigger mitgliedschaftsantraege_touch before insert or update on mitgliedschaftsantraege for each row execute function stammdaten_touch();

-- Fehlgeschlagene Zuordnungen, ohne die geratenen Werte
create table antrag_fehlversuche (
  id          uuid primary key default gen_random_uuid(),
  verein_id   uuid not null references vereine(id),
  benutzer_id uuid not null references benutzer(id),
  zeitpunkt   timestamptz not null
);
create index antrag_fehlversuche_verein_idx on antrag_fehlversuche (verein_id, zeitpunkt);
create index antrag_fehlversuche_benutzer_idx on antrag_fehlversuche (benutzer_id, zeitpunkt);

-- Alle drei Angaben müssen passen. Bei Dubletten (bis Story 3.11) gilt die ältere Zeile. Als Funktion, weil `lizenzen` einem anderen Modul gehört.
create function person_zu_pass(p_nummer text, p_nachname text, p_geburtsdatum date) returns uuid language sql stable as $$
  select p.id from lizenzen l join mitglieder m on m.id = l.mitglied_id join personen p on p.id = m.person_id
   where l.art = 'judopass' and l.geloescht_am is null and l.nummer = btrim(p_nummer)
     and m.geloescht_am is null and m.anonymisiert_am is null
     and lower(btrim(p.nachname)) = lower(btrim(p_nachname)) and p.geburtsdatum = p_geburtsdatum
   order by p.erstellt_am, p.id limit 1
$$;
