-- Review-Befund 23: Der QR-Code eines aufgelösten Vereins gilt nicht weiter.
-- Das Modul zugang liest die Tabelle vereine nicht; deshalb widerruft ein Trigger die Codes bei der Auflösung.
create function vereins_qr_bei_aufloesung() returns trigger language plpgsql as $$
begin
  update vereins_qr_codes set widerrufen_am = now() where verein_id = new.id and widerrufen_am is null;
  return new;
end $$;
create trigger vereins_qr_bei_aufloesung after update of aufgeloest_am on vereine
  for each row when (new.aufgeloest_am is not null and old.aufgeloest_am is distinct from new.aufgeloest_am)
  execute function vereins_qr_bei_aufloesung();
update vereins_qr_codes set widerrufen_am = now()
 where widerrufen_am is null and verein_id in (select id from vereine where aufgeloest_am is not null);
