-- Story 3.9 (FR-9, FR-10, E27, E31, E73, E82): Transfer von Pass und Heimatverein. Je Person höchstens ein offener Transfer.
alter table mitglieder add constraint mitglieder_id_person_uq unique (id, person_id);
alter table mitglieder add constraint mitglieder_id_person_verein_uq unique (id, person_id, verein_id);

create table transfers (
  id                  uuid primary key default gen_random_uuid(),
  person_id           uuid not null references personen(id),
  von_verein_id       uuid not null references vereine(id),           -- Verein mit dem Pass zum Zeitpunkt des Sendens
  von_mitgliedschaft  uuid not null,                                  -- darf ruhend oder ausgetreten sein
  nach_verein_id      uuid not null references vereine(id),
  nach_mitgliedschaft uuid,                                           -- vorhandene Mitgliedschaft in B; leer = bei Annahme neu anlegen
  art                 text not null check (art in ('vereinswechsel', 'heimatwechsel')),
  status              text not null default 'gesendet' check (status in ('gesendet', 'angenommen', 'abgelehnt', 'zurueckgezogen', 'vollzogen', 'abgebrochen')),
  wirksam_ab          date not null,
  reaktivieren        boolean not null default false,                 -- B nimmt eine ruhende Mitgliedschaft wieder auf
  grund               text,
  gesendet_von        uuid not null references benutzer(id),
  gesendet_im_kontext text not null check (gesendet_im_kontext in ('abgebender_verein', 'landesverband')),
  entschieden_von     uuid references benutzer(id),
  entschieden_am      timestamptz,
  erstellt_am         timestamptz not null,
  geaendert_am        timestamptz not null default now(),
  geaendert_von       uuid,
  change_seq          bigint not null default nextval('change_seq'),
  change_xid          xid8 not null default pg_current_xact_id(),
  constraint transfer_verschieden check (von_verein_id <> nach_verein_id),
  constraint transfer_heimatwechsel_braucht_mitgliedschaft check (art <> 'heimatwechsel' or nach_mitgliedschaft is not null),
  foreign key (von_mitgliedschaft, person_id, von_verein_id) references mitglieder (id, person_id, verein_id),
  foreign key (nach_mitgliedschaft, person_id, nach_verein_id) references mitglieder (id, person_id, verein_id)
);
create unique index transfer_je_person_offen on transfers (person_id) where status in ('gesendet', 'angenommen');
create index transfers_von_idx on transfers (von_verein_id, erstellt_am);
create index transfers_nach_idx on transfers (nach_verein_id, erstellt_am);
create index transfers_faellig_idx on transfers (wirksam_ab) where status = 'angenommen';
create trigger transfers_touch before insert or update on transfers for each row execute function stammdaten_touch();
