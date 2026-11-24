-- Story 2.7 (FR-21, E98): vereinseigene Rollen aus einer Positivliste und ihre Vergabe an Mitglieder des Vereins.
-- Nur Rechte mit katalog_rechte.vereinsrolle_erlaubt, nie die Operation DELEGIEREN (eine Delegation lässt sich nicht weitergeben).
create function vereinsrolle_recht_pruefen() returns trigger language plpgsql as $$
begin
  if exists (select 1 from rollen where id = new.rolle_id and verein_id is not null)
     and (new.operation = 'DELEGIEREN' or not exists (select 1 from katalog_rechte where schluessel = new.recht and vereinsrolle_erlaubt)) then
    raise exception 'Das Recht %:% ist in vereinseigenen Rollen nicht erlaubt', new.recht, new.operation
      using errcode = 'check_violation', constraint = 'vereinsrolle_recht_nicht_erlaubt';
  end if;
  return new;
end $$;
create trigger vereinsrolle_recht_pruefen before insert or update on rollen_berechtigungen for each row execute function vereinsrolle_recht_pruefen();

create table benutzer_vereinsrollen (
  id           uuid primary key default gen_random_uuid(),
  benutzer_id  uuid not null references benutzer(id),
  verein_id    uuid not null references vereine(id),
  rolle_id     uuid not null references rollen(id),
  erstellt_am  timestamptz not null default now(),
  erstellt_von uuid references benutzer(id),
  beendet_am   timestamptz,
  beendet_von  uuid references benutzer(id)
);
create unique index benutzer_vereinsrollen_uq on benutzer_vereinsrollen (benutzer_id, verein_id, rolle_id) where beendet_am is null;
create index benutzer_vereinsrollen_rolle_idx on benutzer_vereinsrollen (rolle_id);

-- Die Rolle gehört dem Verein, und der Benutzer ist dort freigegebenes Mitglied
create function vereinsrolle_vergabe_pruefen() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from rollen where id = new.rolle_id and verein_id = new.verein_id and not ist_system) then
    raise exception 'Die Rolle gehört nicht zu diesem Verein' using errcode = 'check_violation', constraint = 'vereinsrolle_fremd';
  end if;
  if not exists (select 1 from benutzer_vereine where benutzer_id = new.benutzer_id and verein_id = new.verein_id and status = 'freigegeben' and geloescht_am is null) then
    raise exception 'Der Benutzer gehört dem Verein nicht an' using errcode = 'check_violation', constraint = 'vereinsrolle_kein_mitglied';
  end if;
  return new;
end $$;
create trigger vereinsrolle_vergabe_pruefen before insert on benutzer_vereinsrollen for each row execute function vereinsrolle_vergabe_pruefen();
