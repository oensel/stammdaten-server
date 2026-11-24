-- Story 3.3 (FR-17, FR-18): Zugriffe auf eine Person. Berechtigt ist ein Benutzer (nicht wie im Entwurf 4.4 eine Person): Eltern ohne
-- eigene Mitgliedschaft haben keinen Personendatensatz.
create table personen_zugriffe (
  id                 uuid primary key default gen_random_uuid(),
  person_id          uuid not null references personen(id),
  benutzer_id        uuid not null references benutzer(id),
  art                text not null check (art in ('erziehungsberechtigt', 'bevollmaechtigt')),
  umfang             text not null check (umfang in ('lesen', 'aendern')),
  erteilt_von        uuid references benutzer(id),
  erteilt_am         timestamptz not null,
  freigeschaltet_bis date,                          -- ab 18 wirkt der Zugriff nur bis zu diesem Tag (E103)
  widerrufen_am      timestamptz,
  widerrufen_von     uuid references benutzer(id)
);
create unique index personen_zugriff_aktiv_uq on personen_zugriffe (person_id, benutzer_id) where widerrufen_am is null;
create index personen_zugriffe_benutzer_idx on personen_zugriffe (benutzer_id) where widerrufen_am is null;

-- Bestand: nur vom Heimatverein eingetragene Eltern, nur bei bekanntem Geburtsdatum (E103)
insert into personen_zugriffe (person_id, benutzer_id, art, umfang, erteilt_am)
select distinct on (p.id, e.benutzer_id) p.id, e.benutzer_id, 'erziehungsberechtigt', 'aendern', e.erstellt_am
  from erziehungsberechtigte e join mitglieder m on m.id = e.mitglied_id join personen p on p.id = m.person_id and p.heimatverein_id = e.verein_id
 where e.geloescht_am is null and p.geburtsdatum is not null and p.benutzer_id is distinct from e.benutzer_id;

create function zugriff_pruefen() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from benutzer where id = new.benutzer_id and aktiv and geloescht_am is null) then
    raise exception 'Benutzer unbekannt' using errcode = 'check_violation', constraint = 'zugriff_benutzer_unbekannt';
  end if;
  if exists (select 1 from personen where id = new.person_id and geburtsdatum is null) then
    raise exception 'Ohne Geburtsdatum gibt es keinen Zugriff' using errcode = 'check_violation', constraint = 'zugriff_ohne_geburtsdatum';
  end if;
  if exists (select 1 from personen where id = new.person_id and benutzer_id = new.benutzer_id) then
    raise exception 'Die Person selbst braucht keinen Zugriff' using errcode = 'check_violation', constraint = 'zugriff_selbst';
  end if;
  if exists (select 1 from personen where benutzer_id = new.benutzer_id and geburtsdatum > new.erteilt_am::date - interval '18 years') then
    raise exception 'Berechtigte müssen volljährig sein' using errcode = 'check_violation', constraint = 'zugriff_berechtigter_minderjaehrig';
  end if;
  return new;
end $$;
create trigger zugriff_pruefen before insert on personen_zugriffe for each row execute function zugriff_pruefen();

-- Der Widerruf wirkt auch in den /v1-Claims (mitglied_ids)
create function zugriff_an_v1() returns trigger language plpgsql as $$
begin
  if new.widerrufen_am is not null and old.widerrufen_am is null then
    update erziehungsberechtigte e set geloescht_am = new.widerrufen_am from mitglieder m
     where m.id = e.mitglied_id and m.person_id = new.person_id and e.benutzer_id = new.benutzer_id and e.geloescht_am is null;
  end if;
  return null;
end $$;
create trigger zugriff_an_v1 after update on personen_zugriffe for each row execute function zugriff_an_v1();

-- Beendet der Heimatverein den Bezug auf dem Altweg (Entzug der Zugehörigkeit), endet auch der Zugriff
create function v1_an_zugriff() returns trigger language plpgsql as $$
begin
  if new.geloescht_am is not null and old.geloescht_am is null then
    update personen_zugriffe z set widerrufen_am = new.geloescht_am from mitglieder m join personen p on p.id = m.person_id
     where m.id = new.mitglied_id and p.heimatverein_id = new.verein_id and z.person_id = p.id and z.benutzer_id = new.benutzer_id and z.widerrufen_am is null;
  end if;
  return null;
end $$;
create trigger v1_an_zugriff after update on erziehungsberechtigte for each row execute function v1_an_zugriff();
