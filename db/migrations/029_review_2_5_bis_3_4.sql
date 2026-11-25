-- Review 2.5 bis 3.4: Sitzungen merken den zweiten Faktor; aus dem Bestand übernommene Zugriffe gelten nur, wo auch der Altbezug galt.
alter table refresh_tokens add column mfa boolean not null default false;

update personen_zugriffe z set widerrufen_am = now()
 where z.erteilt_von is null and z.widerrufen_am is null and (
   not exists (select 1 from benutzer b where b.id = z.benutzer_id and b.aktiv and b.geloescht_am is null)
   or not exists (select 1 from benutzer_vereine bv join personen p on p.id = z.person_id and p.heimatverein_id = bv.verein_id
                   where bv.benutzer_id = z.benutzer_id and bv.status = 'freigegeben' and bv.geloescht_am is null)
   or exists (select 1 from personen e where e.benutzer_id = z.benutzer_id and e.geburtsdatum > current_date - interval '18 years'));
