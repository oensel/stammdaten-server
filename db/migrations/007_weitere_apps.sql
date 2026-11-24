-- Weitere Apps des Verbunds registrieren (SSO, App-Umschalter): Dan-Manager-Pro neu, Adressen für Hajime/Dojo/Dan.
-- backchannel_url bleibt leer, bis die jeweilige App den Endpunkt POST /api/auth/backchannel-logout hat (docs/sso-entscheidung.md, 4.3).
-- Die Adressen sind Entwicklungswerte (lokal); in Produktion je Instanz setzen (update anwendungen set url = …).
insert into anwendungen (schluessel, name, scopes, client_scopes, lizenz_arten) values
  ('dan-manager-pro', 'Dan-Manager-Pro',
     '{mitglieder:selbst,mitglieder:lesen,mitglieder:person,graduierungen:lesen,graduierungen:schreiben,lizenzen:judopass,lizenzen:lesen,vereine:lesen,benutzer:verwalten,rechte:verwalten}',
     '{vereine:lesen,mitglieder:lesen,mitglieder:person,graduierungen:lesen,graduierungen:schreiben,lizenzen:judopass,lizenzen:lesen}',
     '{judopass,graduierungslizenz,pruefer_lizenz}')
on conflict (schluessel) do nothing;

update anwendungen set url = coalesce(url, 'http://localhost:8765') where schluessel = 'dan-manager-pro';
update anwendungen set url = coalesce(url, 'http://localhost:3000') where schluessel = 'hajime-pro';
update anwendungen set url = coalesce(url, 'http://localhost:3001') where schluessel = 'dojo-master-pro';

alter table graduierungen drop constraint if exists graduierungen_quelle_check;
alter table graduierungen add constraint graduierungen_quelle_check
  check (quelle in ('manuell', 'import', 'dojo-master-pro', 'kyu-manager-pro', 'dan-manager-pro'));
