-- Story 2.6 (FR-21, P13, P18): Verbandsrollen aller Ebenen und Stellvertreter.
-- Eine Stellvertretung ist eine eigene Zeile derselben Rolle im selben Verband, die auf die Zeile des Amtsinhabers zeigt.
alter table benutzer_verbandsrollen drop constraint benutzer_verbandsrollen_rolle_check;
alter table benutzer_verbandsrollen
  add column stellvertreter_von uuid references benutzer_verbandsrollen(id),
  add column erstellt_von       uuid references benutzer(id),
  add column beendet_von        uuid references benutzer(id),
  add column grund              text,
  add constraint stellvertreter_nicht_selbst check (stellvertreter_von is distinct from id);
create index benutzer_verbandsrollen_amt_idx on benutzer_verbandsrollen (stellvertreter_von) where beendet_am is null and stellvertreter_von is not null;

create function verbandsrolle_pruefen() returns trigger language plpgsql as $$
declare
  v_typ text;
  amt   benutzer_verbandsrollen%rowtype;
begin
  if not exists (select 1 from benutzer where id = new.benutzer_id and aktiv) then
    raise exception 'Benutzer unbekannt' using errcode = 'check_violation', constraint = 'verbandsrolle_benutzer_unbekannt';
  end if;
  select typ into v_typ from verbaende where id = new.verband_id and geloescht_am is null;
  if v_typ is null then
    raise exception 'Verband unbekannt' using errcode = 'check_violation', constraint = 'verbandsrolle_verband_unbekannt';
  end if;
  if not exists (select 1 from rollen r where r.schluessel = new.rolle and r.verein_id is null and r.ebene = 'verband' and v_typ = any (r.verband_typen)) then
    raise exception 'Rolle % ist in einem Verband vom Typ % nicht vergebbar', new.rolle, v_typ using errcode = 'check_violation', constraint = 'verbandsrolle_ebene_unzulaessig';
  end if;
  if new.stellvertreter_von is not null then
    -- Sperre auf das Amt: zwei gleichzeitige Ernennungen zählen sich sonst gegenseitig nicht
    select * into amt from benutzer_verbandsrollen where id = new.stellvertreter_von for update;
    if not found or amt.beendet_am is not null or amt.stellvertreter_von is not null or amt.verband_id <> new.verband_id or amt.rolle <> new.rolle then
      raise exception 'Stellvertretung nur für ein aktives Amt derselben Rolle im selben Verband' using errcode = 'check_violation', constraint = 'stellvertretung_ungueltig';
    end if;
    if amt.benutzer_id = new.benutzer_id then
      raise exception 'Der Amtsinhaber kann nicht sein eigener Stellvertreter sein' using errcode = 'check_violation', constraint = 'stellvertreter_ist_amtsinhaber';
    end if;
    if (select count(*) from benutzer_verbandsrollen where stellvertreter_von = new.stellvertreter_von and beendet_am is null) >= 2 then
      raise exception 'Ein Amt hat höchstens zwei Stellvertreter' using errcode = 'check_violation', constraint = 'stellvertreter_hoechstens_zwei';
    end if;
  end if;
  return new;
end $$;
create trigger verbandsrolle_pruefen before insert on benutzer_verbandsrollen for each row execute function verbandsrolle_pruefen();

-- Das Amt endet: die Stellvertretungen enden mit
create function verbandsrolle_beendet() returns trigger language plpgsql as $$
begin
  update benutzer_verbandsrollen set beendet_am = new.beendet_am, beendet_von = new.beendet_von, grund = coalesce(grund, 'Amt beendet')
   where stellvertreter_von = new.id and beendet_am is null;
  return new;
end $$;
create trigger verbandsrolle_beendet after update of beendet_am on benutzer_verbandsrollen for each row
  when (old.beendet_am is null and new.beendet_am is not null and new.stellvertreter_von is null) execute function verbandsrolle_beendet();
