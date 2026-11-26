-- Millisekunden: der Zeitpunkt läuft über JavaScript in den Link zurück.
-- Nutzerentscheid 2026-11-26: Verknüpft eine Einladung ein Konto mit einer Person, ist bis zur Bestätigung nur diese Person
-- unbestätigt, nicht das ganze Konto (Elternrechte bleiben). Der Link geht an eine Adresse, die kein Verknüpfender gesetzt hat.
alter table personen add column konto_unbestaetigt_seit timestamptz(3), add column konto_vergeben_durch uuid[] not null default '{}';
alter table konto_bestaetigungen alter column fremd_vergeben_am drop not null,
  add column person_id uuid references personen(id), add column person_seit timestamptz(3),
  add column adresse text,                          -- an genau diese Adresse gesendet: wird nach der Bestätigung die des Kontos
  add column ueber_eltern boolean not null default false;
-- Eltern haben das Passwort bei der Bestätigung gesetzt; jede eigene Änderung löscht das
alter table benutzer add column passwort_von_eltern boolean not null default false;

create or replace function person_konto() returns trigger language plpgsql as $$
declare
  p personen%rowtype;
begin
  if tg_op <> 'INSERT' and old.mitglied_id is not null then
    update personen x set benutzer_id = null, konto_unbestaetigt_seit = null, konto_vergeben_durch = '{}' from mitglieder m
     where m.id = old.mitglied_id and x.id = m.person_id and x.heimatverein_id = old.verein_id and x.benutzer_id = old.benutzer_id
       and (tg_op = 'DELETE' or new.mitglied_id is distinct from old.mitglied_id or new.status <> 'freigegeben' or new.geloescht_am is not null);
  end if;
  if tg_op <> 'DELETE' and new.mitglied_id is not null and new.status = 'freigegeben' and new.geloescht_am is null then
    update personen x set benutzer_id = new.benutzer_id, konto_unbestaetigt_seit = null, konto_vergeben_durch = '{}' from mitglieder m
     where m.id = new.mitglied_id and x.id = m.person_id and x.heimatverein_id = new.verein_id and x.benutzer_id is distinct from new.benutzer_id
    returning x.* into p;
    if found and new.geaendert_von is not null then
      update personen x set konto_unbestaetigt_seit = clock_timestamp(), konto_vergeben_durch = array[new.geaendert_von]
        from benutzer b
       where x.id = p.id and b.id = new.benutzer_id
         and not (b.email_bestaetigt_am is not null and p.email is not null and lower(b.email) = lower(p.email)
                  and p.email_gesetzt_von is distinct from new.geaendert_von
                  and not exists (select 1 from personen_zugriffe z where z.person_id = p.id and z.benutzer_id = p.email_gesetzt_von
                                     and z.erteilt_von = new.geaendert_von));
    end if;
  end if;
  return null;
end $$;

-- Löst die Markierung der Person, wenn der Link zu genau dieser Verknüpfung gehört (aufgerufen vom Modul zugang)
create function person_bestaetigung_einloesen(p_person uuid, p_seit timestamptz) returns boolean language sql as $$
  with u as (update personen set konto_unbestaetigt_seit = null, konto_vergeben_durch = '{}'
              where id = p_person and konto_unbestaetigt_seit = p_seit returning 1)
  select exists (select 1 from u)
$$;
