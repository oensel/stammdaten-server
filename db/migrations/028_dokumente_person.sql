-- Story 3.4 (FR-75): Dokumente gehören der Person. verein_id/mitglied_id bleiben für /v1 als Herkunft (wo hochgeladen) stehen.
alter table dokumente add column person_id uuid references personen(id);
-- ohne Trigger: change_xid bleibt (Dokumente sind nicht Teil des Abgleichs, der Stand soll trotzdem nicht springen)
alter table dokumente disable trigger user;
update dokumente d set person_id = m.person_id from mitglieder m where m.id = d.mitglied_id;
alter table dokumente enable trigger user;
create index dokumente_person_idx on dokumente (person_id) where geloescht_am is null;

alter table dokumente drop constraint dokumente_art_check;
alter table dokumente add constraint dokumente_art_check check (art in ('passfoto', 'erste_hilfe', 'sonstiges', 'scan', 'bescheinigung', 'vormundschaftsnachweis'));

create function dokument_person() returns trigger language plpgsql as $$
begin
  if new.person_id is null and new.mitglied_id is not null then
    select person_id into new.person_id from mitglieder where id = new.mitglied_id;
  end if;
  return new;
end $$;
create trigger dokument_person before insert on dokumente for each row execute function dokument_person();

-- Höchstens ein Passfoto je Person; ältere doppelte (Altbestand) werden nur ausgeblendet, nicht gelöscht
alter table dokumente disable trigger user;
update dokumente d set geloescht_am = now()
 where art = 'passfoto' and geloescht_am is null and person_id is not null
   and exists (select 1 from dokumente n where n.art = 'passfoto' and n.geloescht_am is null and n.person_id = d.person_id and (n.geaendert_am, n.id) > (d.geaendert_am, d.id));
alter table dokumente enable trigger user;
create unique index dokumente_passfoto_uq on dokumente (person_id) where art = 'passfoto' and geloescht_am is null;
