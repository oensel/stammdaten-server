-- Story 3.5 (FR-19, FR-76) und Nutzerentscheid 2026-11-25: Kennt jemand anderes das Passwort eines Kontos (Startpasswort), gelten
-- dessen Personenrechte erst nach Bestätigung per Link an eine Adresse, die dieser andere nicht gesetzt hat.
alter table benutzer add column fremd_vergeben_am timestamptz, add column fremd_vergeben_von uuid;
create function konto_fremd_vergeben() returns trigger language plpgsql as $$
begin
  if new.muss_passwort_aendern and new.passwort_hash is not null and (tg_op = 'INSERT' or new.passwort_hash is distinct from old.passwort_hash) then
    new.fremd_vergeben_am := clock_timestamp();
    new.fremd_vergeben_von := new.geaendert_von;
  end if;
  return new;
end $$;
create trigger konto_fremd_vergeben before insert or update on benutzer for each row execute function konto_fremd_vergeben();
-- Bestand: noch nie geändertes Startpasswort oder vom Verein angelegter Zugang
alter table benutzer disable trigger user;
update benutzer b set fremd_vergeben_am = now(), fremd_vergeben_von = b.geaendert_von
 where b.muss_passwort_aendern and b.passwort_hash is not null;
update benutzer b set fremd_vergeben_am = now(), fremd_vergeben_von = bv.entschieden_von
  from benutzer_vereine bv where bv.benutzer_id = b.id and bv.angefragt_ueber = 'verwaltung' and bv.geloescht_am is null and b.fremd_vergeben_am is null;
alter table benutzer enable trigger user;

create table konto_bestaetigungen (
  id                uuid primary key default gen_random_uuid(),
  benutzer_id       uuid not null references benutzer(id) on delete cascade,
  fremd_vergeben_am timestamptz not null,   -- eine neue Fremdvergabe entwertet offene Links
  token_hash        char(64) not null unique,
  erstellt_am       timestamptz not null,
  laeuft_ab_am      timestamptz not null,
  benutzt_am        timestamptz
);
create index konto_bestaetigungen_benutzer_idx on konto_bestaetigungen (benutzer_id, erstellt_am);

-- Wer die Adresse der Person zuletzt gesetzt hat; Bestand unbekannt
alter table personen add column email_gesetzt_von uuid, add column zugriffe_abgefragt_am date;
create function person_email_gesetzt() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.email is distinct from old.email then new.email_gesetzt_von := new.geaendert_von; end if;
  return new;
end $$;
create trigger person_email_gesetzt before insert or update on personen for each row execute function person_email_gesetzt();

alter table dokumente add column bestaetigt_am timestamptz, add column bestaetigt_von uuid references benutzer(id);
alter table personen_zugriffe add column ruht_seit timestamptz, add column nachweis_id uuid references dokumente(id);
alter table personen_zugriffe drop constraint personen_zugriffe_art_check;
alter table personen_zugriffe add constraint personen_zugriffe_art_check check (art in ('erziehungsberechtigt', 'bevollmaechtigt', 'vormund'));
alter table personen_zugriffe add constraint vormund_braucht_nachweis check (art <> 'vormund' or nachweis_id is not null);
create function vormund_nachweis() returns trigger language plpgsql as $$
begin
  if new.nachweis_id is not null and not exists (select 1 from dokumente where id = new.nachweis_id and person_id = new.person_id
       and art = 'vormundschaftsnachweis' and bestaetigt_am is not null and geloescht_am is null) then
    raise exception 'Nachweis fehlt' using errcode = 'check_violation', constraint = 'vormund_braucht_nachweis';
  end if;
  return new;
end $$;
create trigger vormund_nachweis before insert on personen_zugriffe for each row execute function vormund_nachweis();

-- Widerruf und Ruhen wirken auch in den /v1-Claims; das Ruhen widerruft den Zugriff nicht
create or replace function zugriff_an_v1() returns trigger language plpgsql as $$
begin
  if (new.widerrufen_am is not null and old.widerrufen_am is null) or (new.ruht_seit is not null and old.ruht_seit is null) then
    update erziehungsberechtigte e set geloescht_am = coalesce(new.widerrufen_am, new.ruht_seit) from mitglieder m
     where m.id = e.mitglied_id and m.person_id = new.person_id and e.benutzer_id = new.benutzer_id and e.geloescht_am is null;
  end if;
  return null;
end $$;
create or replace function v1_an_zugriff() returns trigger language plpgsql as $$
begin
  if new.geloescht_am is not null and old.geloescht_am is null then
    update personen_zugriffe z set widerrufen_am = new.geloescht_am from mitglieder m join personen p on p.id = m.person_id
     where m.id = new.mitglied_id and p.heimatverein_id = new.verein_id and z.person_id = p.id and z.benutzer_id = new.benutzer_id
       and z.widerrufen_am is null and z.ruht_seit is null;
  end if;
  return null;
end $$;
