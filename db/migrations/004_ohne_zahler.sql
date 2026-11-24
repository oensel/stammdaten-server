-- Entfernt Felder, die nur im DJB-Export vorkommen und nicht zentral gebraucht werden: Zahler, SEPA-Mandate, IBANs
-- (Abrechnungs-Tool), passiv, führender Verein, Notizen. `eintritt` bleibt (nullable, nur von Dojo-Master-Pro gesetzt). Gemeinsamer Schlüssel bleibt mitglieder.djb_id.
alter table mitglieder drop column if exists zahler_id, drop column if exists passiv,
  drop column if exists fuehrender_verein, drop column if exists notizen;
drop table if exists sepa_mandate;
drop table if exists zahler;
delete from aufbewahrungsfristen where schluessel in ('zahler_ohne_bezug', 'mandat_nach_ende');
update aufbewahrungsfristen set beschreibung = 'Gelöschte Mitglieder und Benutzer (Papierkorb)' where schluessel = 'geloeschte_datensaetze';
update anwendungen set scopes = array_remove(array_remove(array_remove(scopes, 'zahler:lesen'), 'zahler:schreiben'), 'zahler:iban'),
  client_scopes = array_remove(array_remove(array_remove(client_scopes, 'zahler:lesen'), 'zahler:schreiben'), 'zahler:iban');

create or replace function datenschutz_bereinigen() returns table (bereich text, anzahl bigint) language plpgsql as $$
declare n bigint;
begin
  -- 1. Mitglieder: ausgetreten und Frist abgelaufen, oder gelöscht und Papierkorb-Frist abgelaufen
  create temp table _mitglieder on commit drop as
    select id from mitglieder
     where anonymisiert_am is null
       and ((status = 'ausgetreten' and austritt < current_date - frist('mitglied_nach_austritt'))
         or geloescht_am < now() - frist('geloeschte_datensaetze'));

  update graduierungen set urkunden_nr = null, pruefer = null, ort = null, geloescht_am = coalesce(geloescht_am, now())
   where mitglied_id in (select id from _mitglieder);
  update lizenzen set nummer = null, bezeichnung = null, aussteller = null, dokument_id = null,
                      geloescht_am = coalesce(geloescht_am, now())
   where mitglied_id in (select id from _mitglieder);
  update dokumente set inhalt = null, dateiname = '', groesse = 0, geloescht_am = coalesce(geloescht_am, now())
   where mitglied_id in (select id from _mitglieder);
  update mitglied_gruppen set geloescht_am = now()
   where mitglied_id in (select id from _mitglieder) and geloescht_am is null;
  update erziehungsberechtigte set geloescht_am = now()
   where mitglied_id in (select id from _mitglieder) and geloescht_am is null;
  update benutzer_vereine set mitglied_id = null where mitglied_id in (select id from _mitglieder);
  delete from fuehrungszeugnis_einsichten where mitglied_id in (select id from _mitglieder);
  update mitglieder set
         vorname = '', nachname = 'Anonymisiert', geburtsdatum = null, geschlecht = null, nationalitaet = null,
         strasse = null, plz = null, ort = null, email = null, telefon = null, ausbildung_bis = null,
         djb_id = null, judopass_url = null,
         geloescht_am = coalesce(geloescht_am, now()), anonymisiert_am = now()
   where id in (select id from _mitglieder);
  get diagnostics n = row_count;
  bereich := 'mitglieder'; anzahl := n; return next;

  -- 2. Benutzer: gelöscht und Papierkorb-Frist abgelaufen
  create temp table _benutzer on commit drop as
    select id from benutzer where anonymisiert_am is null and geloescht_am < now() - frist('geloeschte_datensaetze');
  delete from refresh_tokens where benutzer_id in (select id from _benutzer);
  delete from einmal_tokens where benutzer_id in (select id from _benutzer);
  delete from totp_backup_codes where benutzer_id in (select id from _benutzer);
  update erziehungsberechtigte set geloescht_am = now()
   where benutzer_id in (select id from _benutzer) and geloescht_am is null;
  update benutzer_rechte set geloescht_am = now()
   where benutzer_id in (select id from _benutzer) and geloescht_am is null;
  update benutzer_vereine set mitglied_id = null, geloescht_am = coalesce(geloescht_am, now())
   where benutzer_id in (select id from _benutzer);
  update benutzer set benutzername = 'geloescht-' || id, email = null, vorname = null, nachname = null,
                      passwort_hash = null, pin_hash = null, aktiv = false, totp_secret_verschluesselt = null,
                      totp_aktiv_am = null, anonymisiert_am = now()
   where id in (select id from _benutzer);
  get diagnostics n = row_count;
  bereich := 'benutzer'; anzahl := n; return next;

  -- 3. Führungszeugnis-Einsichten: drei Monate nach Ende der Tätigkeit endgültig löschen
  delete from fuehrungszeugnis_einsichten where loeschen_ab <= current_date;
  get diagnostics n = row_count;
  bereich := 'fuehrungszeugnis_einsichten'; anzahl := n; return next;

  -- 4. Protokoll und abgelaufene Tokens
  delete from audit_log where zeitpunkt < now() - frist('audit_log');
  get diagnostics n = row_count;
  bereich := 'audit_log'; anzahl := n; return next;

  delete from refresh_tokens where least(widerrufen_am, laeuft_ab_am) < now() - frist('abgelaufene_tokens');
  delete from einmal_tokens where laeuft_ab_am < now() - frist('abgelaufene_tokens');
end $$;

-- eintritt wird nur von Dojo-Master-Pro gesetzt: eigener Scope mitglieder:eintritt, nur dort in der Obergrenze
alter table mitglieder add column if not exists eintritt date;
alter table mitglieder alter column eintritt drop not null;
update anwendungen set scopes = scopes || '{mitglieder:eintritt}' where schluessel = 'dojo-master-pro' and not ('mitglieder:eintritt' = any(scopes));
