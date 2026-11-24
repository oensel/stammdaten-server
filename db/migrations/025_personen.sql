-- Story 3.1 (FR-4): Personen getrennt von Mitgliedschaften. `mitglieder` bleibt die Tabelle der Mitgliedschaften (gleiche IDs, change_xid,
-- /v1 unverändert); führend für Personenfelder ist `personen`. Die alten Personenspalten in `mitglieder` sind ein Spiegel für /v1.
-- Bestand: eine Person je Mitgliedszeile, ohne Zusammenführung (Dubletten: Story 3.11).
create table personen (
  id               uuid primary key default gen_random_uuid(),
  vorname          text not null,
  nachname         text not null,
  geburtsdatum     date,
  geschlecht       char(1) check (geschlecht in ('m', 'w', 'd')),
  nationalitaet    text,
  strasse          text,
  plz              text,
  ort              text,
  land             char(2) not null default 'DE',
  email            text,
  telefon          text,
  heimatverein_id  uuid not null references vereine(id),
  judopass_hinweis text,                             -- Angabe bei der Anlage, ungeprüft
  erstellt_am      timestamptz not null default now(),
  geaendert_am     timestamptz not null default now(),
  geaendert_von    uuid,
  change_seq       bigint not null default nextval('change_seq'),
  change_xid       xid8 not null default pg_current_xact_id()
);
create index personen_heimatverein_idx on personen (heimatverein_id);

-- Vorgabewert statt UPDATE: lässt change_xid der Mitglieder stehen, die Apps gleichen nicht neu ab
alter table mitglieder add column person_id uuid not null default gen_random_uuid();
alter table mitglieder alter column person_id drop default;
insert into personen (id, vorname, nachname, geburtsdatum, geschlecht, nationalitaet, strasse, plz, ort, land, email, telefon,
                      heimatverein_id, erstellt_am, geaendert_am, geaendert_von)
select person_id, vorname, nachname, geburtsdatum, geschlecht, nationalitaet, strasse, plz, ort, land, email, telefon,
       verein_id, erstellt_am, geaendert_am, geaendert_von from mitglieder;
alter table mitglieder add constraint mitglieder_person_fkey foreign key (person_id) references personen(id);
alter table mitglieder add constraint mitglieder_person_verein_uq unique (person_id, verein_id);
-- Der Heimatverein hat immer eine Mitgliedschaft der Person (jeder Status); aufgeschoben, weil beide zusammen entstehen
alter table personen add constraint person_braucht_mitgliedschaft
  foreign key (id, heimatverein_id) references mitglieder (person_id, verein_id) deferrable initially deferred;

create trigger personen_touch before insert or update on personen for each row execute function stammdaten_touch();

-- Ohne person_id (/v1-Import) entsteht die Person mit. Bei gesetzter person_id gelten die Werte der Person;
-- nur der Heimatverein ändert sie über den Altweg.
create function mitglied_person() returns trigger language plpgsql as $$
declare p personen;
begin
  if new.person_id is null then
    insert into personen (vorname, nachname, geburtsdatum, geschlecht, nationalitaet, strasse, plz, ort, land, email, telefon, heimatverein_id, geaendert_von)
    values (new.vorname, new.nachname, new.geburtsdatum, new.geschlecht, new.nationalitaet, new.strasse, new.plz, new.ort, new.land, new.email,
            new.telefon, new.verein_id, new.geaendert_von) returning id into new.person_id;
    return new;
  end if;
  select * into p from personen where id = new.person_id;
  if found and (tg_op = 'INSERT' or new.person_id <> old.person_id or p.heimatverein_id <> new.verein_id) then
    new.vorname := p.vorname; new.nachname := p.nachname; new.geburtsdatum := p.geburtsdatum; new.geschlecht := p.geschlecht;
    new.nationalitaet := p.nationalitaet; new.strasse := p.strasse; new.plz := p.plz; new.ort := p.ort; new.land := p.land;
    new.email := p.email; new.telefon := p.telefon;
  end if;
  return new;
end $$;
create trigger mitglied_person before insert or update on mitglieder for each row execute function mitglied_person();

create function mitglied_an_person() returns trigger language plpgsql as $$
begin
  update personen p set vorname = new.vorname, nachname = new.nachname, geburtsdatum = new.geburtsdatum, geschlecht = new.geschlecht,
         nationalitaet = new.nationalitaet, strasse = new.strasse, plz = new.plz, ort = new.ort, land = new.land, email = new.email,
         telefon = new.telefon, geaendert_von = new.geaendert_von
   where p.id = new.person_id and p.heimatverein_id = new.verein_id
     and (p.vorname, p.nachname, p.geburtsdatum, p.geschlecht, p.nationalitaet, p.strasse, p.plz, p.ort, p.land, p.email, p.telefon)
         is distinct from
         (new.vorname, new.nachname, new.geburtsdatum, new.geschlecht, new.nationalitaet, new.strasse, new.plz, new.ort, new.land, new.email, new.telefon);
  return null;
end $$;
create trigger mitglied_an_person after update on mitglieder for each row execute function mitglied_an_person();

create function person_an_mitglieder() returns trigger language plpgsql as $$
begin
  update mitglieder m set vorname = new.vorname, nachname = new.nachname, geburtsdatum = new.geburtsdatum, geschlecht = new.geschlecht,
         nationalitaet = new.nationalitaet, strasse = new.strasse, plz = new.plz, ort = new.ort, land = new.land, email = new.email,
         telefon = new.telefon, geaendert_von = new.geaendert_von
   where m.person_id = new.id
     and (m.vorname, m.nachname, m.geburtsdatum, m.geschlecht, m.nationalitaet, m.strasse, m.plz, m.ort, m.land, m.email, m.telefon)
         is distinct from
         (new.vorname, new.nachname, new.geburtsdatum, new.geschlecht, new.nationalitaet, new.strasse, new.plz, new.ort, new.land, new.email, new.telefon);
  return null;
end $$;
create trigger person_an_mitglieder after update on personen for each row execute function person_an_mitglieder();

-- Aufgaben eines Verbands; Liste und Erledigen: Story 3.10
create table aufgaben (
  id           uuid primary key default gen_random_uuid(),
  art          text not null check (art in ('person_zusammenfuehren')),
  verband_id   uuid references verbaende(id),          -- leer, wenn der Verein (Altbestand) keinem Landesverband zugeordnet ist
  person_id    uuid not null references personen(id),
  status       text not null default 'offen' check (status in ('offen', 'erledigt')),
  erstellt_am  timestamptz not null,
  erstellt_von uuid references benutzer(id)
);
create index aufgaben_offen_idx on aufgaben (verband_id) where status = 'offen';
