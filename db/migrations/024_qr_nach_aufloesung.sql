-- Nachbesserung zu 023: Nach der Auflösung entsteht auch kein neuer QR-Code (bisher wurden nur vorhandene widerrufen).
create function vereins_qr_verein_aktiv() returns trigger language plpgsql as $$
begin
  if exists (select 1 from vereine where id = new.verein_id and aufgeloest_am is not null) then
    raise exception 'Der Verein ist aufgelöst' using errcode = 'check_violation', constraint = 'qr_verein_aufgeloest';
  end if;
  return new;
end $$;
create trigger vereins_qr_verein_aktiv before insert on vereins_qr_codes for each row execute function vereins_qr_verein_aktiv();
