-- FR-78 / NFR-6: Personen und ihre Daten werden nie gelöscht oder anonymisiert, auch nicht nach Austritt oder Löschung.
-- datenschutz_bereinigen() räumt nur noch Nebendaten: Tokens gelöschter Benutzer nach der Papierkorb-Frist, Audit älter
-- als die Frist, abgelaufene Tokens, Führungszeugnis-Einsichten nach loeschen_ab (gesetzliche Pflicht, § 72a SGB VIII).
-- Die Spalte anonymisiert_am bleibt für den /v1-Vertrag bestehen, wird aber nicht mehr gesetzt.
delete from aufbewahrungsfristen where schluessel = 'mitglied_nach_austritt';
update aufbewahrungsfristen set beschreibung = 'Papierkorb: Sitzungen und Tokens gelöschter Benutzer (die Person bleibt erhalten)'
 where schluessel = 'geloeschte_datensaetze';

create or replace function datenschutz_bereinigen() returns table (bereich text, anzahl bigint) language plpgsql as $$
declare n bigint; m bigint;
begin
  -- 1. Papierkorb: Sitzungen und Tokens gelöschter Benutzer; Benutzer und Person bleiben unverändert
  with geloescht as (select id from benutzer where geloescht_am < now() - frist('geloeschte_datensaetze')),
       r as (delete from refresh_tokens where benutzer_id in (select id from geloescht) returning 1),
       e as (delete from einmal_tokens where benutzer_id in (select id from geloescht) returning 1)
  select (select count(*) from r) + (select count(*) from e) into n;
  bereich := 'papierkorb_tokens'; anzahl := n; return next;

  -- 2. Führungszeugnis-Einsichten: drei Monate nach Ende der Tätigkeit endgültig löschen
  delete from fuehrungszeugnis_einsichten where loeschen_ab <= current_date;
  get diagnostics n = row_count;
  bereich := 'fuehrungszeugnis_einsichten'; anzahl := n; return next;

  -- 3. Protokoll
  delete from audit_log where zeitpunkt < now() - frist('audit_log');
  get diagnostics n = row_count;
  bereich := 'audit_log'; anzahl := n; return next;

  -- 4. Abgelaufene oder widerrufene Tokens
  delete from refresh_tokens where least(widerrufen_am, laeuft_ab_am) < now() - frist('abgelaufene_tokens');
  get diagnostics n = row_count;
  delete from einmal_tokens where laeuft_ab_am < now() - frist('abgelaufene_tokens');
  get diagnostics m = row_count;
  n := n + m;
  bereich := 'abgelaufene_tokens'; anzahl := n; return next;
end $$;
