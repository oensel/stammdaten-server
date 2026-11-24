-- FR-1, AD-4, AD-13: Verbandsbaum mit Closure verband_pfade. Ebenenfolge und "Verein hat einen Kreis" hütet die Datenbank.
alter table vereine add column aufgeloest_am date;
-- Schritt 1 von 3 (Altzeilen ohne Kreis bleiben lesbar); validiert wird nach der Migration der Bestandsdaten
alter table vereine add constraint verein_braucht_kreis check (verband_id is not null) not valid;
create unique index verbaende_ein_dachverband_uq on verbaende (typ) where typ = 'dachverband' and geloescht_am is null;

create table verband_pfade (
  vorfahr_id    uuid not null references verbaende(id),
  nachfahr_id   uuid not null,          -- verbaende.id (auch sich selbst, tiefe 0) oder vereine.id
  nachfahr_art  text not null check (nachfahr_art in ('verband', 'verein')),
  tiefe         integer not null,
  primary key (vorfahr_id, nachfahr_id)
);
create index verband_pfade_nachfahr_idx on verband_pfade (nachfahr_id, tiefe);

create function verband_ebene_pruefen() returns trigger language plpgsql as $$
declare eltern_typ text; soll text;
begin
  if tg_op = 'UPDATE' and new.typ <> old.typ then
    raise exception 'Der Typ eines Verbands ist fest' using errcode = 'check_violation', constraint = 'verband_typ_fest';
  end if;
  soll := case new.typ when 'landesverband' then 'dachverband' when 'bezirk' then 'landesverband' when 'kreis' then 'bezirk' end;
  select typ into eltern_typ from verbaende where id = new.uebergeordnet_id and geloescht_am is null for share;
  if eltern_typ is distinct from soll or (soll is null and new.uebergeordnet_id is not null) then
    raise exception 'Ebenenfolge verletzt' using errcode = 'check_violation', constraint = 'ebenenfolge_verletzt';
  end if;
  return new;
end $$;
create trigger verband_ebene before insert or update of typ, uebergeordnet_id on verbaende
  for each row execute function verband_ebene_pruefen();

create function verein_ebene_pruefen() returns trigger language plpgsql as $$
begin
  if new.verband_id is not null
     and not exists (select 1 from verbaende where id = new.verband_id and typ = 'kreis' and geloescht_am is null for share) then
    raise exception 'Ein Verein hängt an einem Kreis' using errcode = 'check_violation', constraint = 'ebenenfolge_verletzt';
  end if;
  return new;
end $$;
create trigger verein_ebene before insert or update of verband_id on vereine
  for each row execute function verein_ebene_pruefen();

-- Baut die Pfade des Teilbaums unter p_wurzel neu auf. Die Ebenenfolge schließt Zyklen aus.
create function verband_pfade_aufbauen(p_wurzel uuid) returns void language plpgsql as $$
declare teil uuid[];
begin
  with recursive t as (
    select id from verbaende where id = p_wurzel
    union all select v.id from verbaende v join t on v.uebergeordnet_id = t.id)
  select array_agg(id) into teil from t;

  delete from verband_pfade where nachfahr_id = any(teil)
     or nachfahr_id in (select id from vereine where verband_id = any(teil));

  insert into verband_pfade (vorfahr_id, nachfahr_id, nachfahr_art, tiefe)
  with recursive auf as (
    select id as nachfahr, id as vorfahr, 0 as tiefe from verbaende where id = any(teil)
    union all
    select a.nachfahr, v.uebergeordnet_id, a.tiefe + 1 from auf a join verbaende v on v.id = a.vorfahr
     where v.uebergeordnet_id is not null)
  select vorfahr, nachfahr, 'verband', tiefe from auf;

  insert into verband_pfade (vorfahr_id, nachfahr_id, nachfahr_art, tiefe)
  select p.vorfahr_id, e.id, 'verein', p.tiefe + 1 from vereine e join verband_pfade p on p.nachfahr_id = e.verband_id
   where e.verband_id = any(teil);
end $$;

create function verband_pfade_verband() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(7313002);   -- gleichzeitige Umbauten nacheinander
  perform verband_pfade_aufbauen(new.id);
  return null;
end $$;
create trigger verband_pfade_einfuegen after insert on verbaende for each row execute function verband_pfade_verband();
create trigger verband_pfade_verschieben after update of uebergeordnet_id on verbaende for each row
  when (old.uebergeordnet_id is distinct from new.uebergeordnet_id) execute function verband_pfade_verband();

create function verband_pfade_verein() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(7313002);
  delete from verband_pfade where nachfahr_id = new.id;
  insert into verband_pfade (vorfahr_id, nachfahr_id, nachfahr_art, tiefe)
  select vorfahr_id, new.id, 'verein', tiefe + 1 from verband_pfade where nachfahr_id = new.verband_id;
  return null;
end $$;
create trigger verein_pfade_einfuegen after insert on vereine for each row execute function verband_pfade_verein();
create trigger verein_pfade_verschieben after update of verband_id on vereine for each row
  when (old.verband_id is distinct from new.verband_id) execute function verband_pfade_verein();

select verband_pfade_aufbauen(id) from verbaende where uebergeordnet_id is null;

-- Verbandsrollen, soweit Epic 1 sie braucht; Vergabe, Stellvertreter und weitere Rollen folgen mit Story 2.6.
create table benutzer_verbandsrollen (
  id           uuid primary key default gen_random_uuid(),
  benutzer_id  uuid not null references benutzer(id),
  verband_id   uuid not null references verbaende(id),
  rolle        text not null check (rolle in ('djb_admin', 'lv_admin')),
  erstellt_am  timestamptz not null default now(),
  beendet_am   timestamptz
);
create unique index benutzer_verbandsrollen_uq on benutzer_verbandsrollen (benutzer_id, verband_id, rolle) where beendet_am is null;
create index benutzer_verbandsrollen_verband_idx on benutzer_verbandsrollen (verband_id, rolle) where beendet_am is null;
