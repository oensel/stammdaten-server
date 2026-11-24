-- Story 3.2 (FR-5, FR-18): Verknüpfung Person → eigenes Konto. Quelle ist bis Story 3.5 benutzer_vereine.mitglied_id, aber nur aus dem
-- Heimatverein: Ein anderer Verein der Person darf niemandem Zugriff auf sie verschaffen. Nicht eindeutig je Konto, solange es Dubletten gibt (3.11).
alter table personen add column benutzer_id uuid references benutzer(id);
create index personen_benutzer_idx on personen (benutzer_id) where benutzer_id is not null;

update personen p set benutzer_id = bv.benutzer_id
  from benutzer_vereine bv join mitglieder m on m.id = bv.mitglied_id
 where p.id = m.person_id and p.heimatverein_id = bv.verein_id and bv.status = 'freigegeben' and bv.geloescht_am is null;

create function person_konto() returns trigger language plpgsql as $$
begin
  if tg_op <> 'INSERT' and old.mitglied_id is not null then
    update personen p set benutzer_id = null from mitglieder m
     where m.id = old.mitglied_id and p.id = m.person_id and p.heimatverein_id = old.verein_id and p.benutzer_id = old.benutzer_id
       and (tg_op = 'DELETE' or new.mitglied_id is distinct from old.mitglied_id or new.status <> 'freigegeben' or new.geloescht_am is not null);
  end if;
  if tg_op <> 'DELETE' and new.mitglied_id is not null and new.status = 'freigegeben' and new.geloescht_am is null then
    update personen p set benutzer_id = new.benutzer_id from mitglieder m
     where m.id = new.mitglied_id and p.id = m.person_id and p.heimatverein_id = new.verein_id and p.benutzer_id is distinct from new.benutzer_id;
  end if;
  return null;
end $$;
create trigger person_konto after insert or update or delete on benutzer_vereine for each row execute function person_konto();
