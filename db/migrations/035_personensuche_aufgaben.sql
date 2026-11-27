-- Story 3.10 (FR-6, E70): Personensuche des Landesverbands und Aufgabenliste.
-- Protokoll jeder Suche; gespeichert werden nur die benutzten Kriterien, nie die gesuchten Werte (auch keine Judopass-ID).
create table personensuchen (
  id          uuid primary key default gen_random_uuid(),
  benutzer_id uuid not null references benutzer(id),
  verband_id  uuid not null references verbaende(id),
  zeitpunkt   timestamptz not null,
  kriterien   text[] not null,
  treffer     int not null
);
create index personensuchen_verband_idx on personensuchen (verband_id, zeitpunkt);

alter table aufgaben add column erledigt_am timestamptz, add column erledigt_von uuid references benutzer(id),
  add constraint aufgabe_erledigt check ((status = 'erledigt') = (erledigt_am is not null));

-- Die Judopass-ID findet Personen in jedem Gebiet: Lizenz-Nummer (Modul lizenzen) oder die ungeprüfte Angabe bei der Anlage
create function personen_zu_judopass(p_nummer text) returns setof uuid language sql stable as $$
  select p.id from lizenzen l join mitglieder m on m.id = l.mitglied_id join personen p on p.id = m.person_id
   where l.art = 'judopass' and l.geloescht_am is null and l.nummer = btrim(p_nummer) and m.geloescht_am is null and m.anonymisiert_am is null
  union
  select id from personen where judopass_hinweis = btrim(p_nummer)
$$;
