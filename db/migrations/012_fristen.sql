-- P15, AD-11: Fristen je Ebene. verband_id null = DJB-Standard (gilt auch, bevor der DJB angelegt ist).
create table fristen (
  id          uuid primary key default gen_random_uuid(),
  art         text not null,
  verband_id  uuid references verbaende(id),
  wert        integer not null check (wert between 1 and 1000),
  einheit     text not null check (einheit in ('tage', 'monate')),
  constraint fristen_art_verband_uq unique nulls not distinct (art, verband_id)
);

-- Nur Landesverbände überschreiben
create function frist_ebene_pruefen() returns trigger language plpgsql as $$
begin
  if new.verband_id is not null and not exists (select 1 from verbaende where id = new.verband_id and typ = 'landesverband') then
    raise exception 'Nur DJB und Landesverbände setzen Fristen' using errcode = 'check_violation', constraint = 'frist_ebene_unzulaessig';
  end if;
  return new;
end $$;
create trigger frist_ebene before insert or update on fristen for each row execute function frist_ebene_pruefen();

-- Standardwerte der Fristentabelle (PRD, vorläufig)
insert into fristen (art, wert, einheit) values
  ('mitgliedschaftsantrag_verfall',       30, 'tage'),
  ('mitgliedschaftsantrag_erinnerung',    14, 'tage'),
  ('lizenzablauf_warnung_1',              60, 'tage'),
  ('lizenzablauf_warnung_2',              14, 'tage'),
  ('fuehrungszeugnis_loeschung',          90, 'tage'),
  ('fuehrungszeugnis_erinnerung',         12, 'monate'),
  ('mandat_verfall',                      36, 'monate'),
  ('mandat_vorwarnung',                   30, 'tage'),
  ('lehrgangsfreigabe_erinnerung',         7, 'tage'),
  ('lehrgangsfreigabe_eskalation',        14, 'tage'),
  ('lehrgangsaenderung_stornierung',      14, 'tage'),
  ('vorabankuendigung',                   14, 'tage');
