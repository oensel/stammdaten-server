-- Review PR 31 bis 35. Die sichere Adresse wird bei der ersten Fremdvergabe eingefroren; alle Vergebenden bleiben gemerkt, bis bestätigt ist.
alter table benutzer add column sichere_email text, add column fremd_vergeben_durch uuid[] not null default '{}';
alter table benutzer disable trigger user;
update benutzer set sichere_email = case when email_bestaetigt_am < fremd_vergeben_am then email end,
       fremd_vergeben_durch = array_remove(array[fremd_vergeben_von], null)
 where fremd_vergeben_am is not null;
alter table benutzer enable trigger user;

create or replace function konto_fremd_vergeben() returns trigger language plpgsql as $$
begin
  if new.muss_passwort_aendern and new.passwort_hash is not null and (tg_op = 'INSERT' or new.passwort_hash is distinct from old.passwort_hash) then
    if tg_op = 'UPDATE' then
      if old.fremd_vergeben_am is null then
        new.sichere_email := case when old.email_bestaetigt_am is not null then old.email end;
      end if;
    end if;
    new.fremd_vergeben_am := clock_timestamp();
    new.fremd_vergeben_von := new.geaendert_von;
    if new.geaendert_von is not null then new.fremd_vergeben_durch := array_append(new.fremd_vergeben_durch, new.geaendert_von); end if;
  end if;
  return new;
end $$;

-- Wer ein Konto mit einer Person verknüpft (Einladung), kann sie sich selbst zuordnen: auch das braucht die Bestätigung. Ausnahme: die
-- bestätigte Adresse des Kontos ist die der Person, und weder der Verknüpfende noch ein von ihm Berechtigter hat sie dort gesetzt.
create or replace function person_konto() returns trigger language plpgsql as $$
declare
  p personen%rowtype;
begin
  if tg_op <> 'INSERT' and old.mitglied_id is not null then
    update personen x set benutzer_id = null from mitglieder m
     where m.id = old.mitglied_id and x.id = m.person_id and x.heimatverein_id = old.verein_id and x.benutzer_id = old.benutzer_id
       and (tg_op = 'DELETE' or new.mitglied_id is distinct from old.mitglied_id or new.status <> 'freigegeben' or new.geloescht_am is not null);
  end if;
  if tg_op <> 'DELETE' and new.mitglied_id is not null and new.status = 'freigegeben' and new.geloescht_am is null then
    update personen x set benutzer_id = new.benutzer_id from mitglieder m
     where m.id = new.mitglied_id and x.id = m.person_id and x.heimatverein_id = new.verein_id and x.benutzer_id is distinct from new.benutzer_id
    returning x.* into p;
    if found and new.geaendert_von is not null then
      update benutzer b set fremd_vergeben_am = clock_timestamp(), fremd_vergeben_von = new.geaendert_von, sichere_email = null,
             fremd_vergeben_durch = array_append(b.fremd_vergeben_durch, new.geaendert_von)
       where b.id = new.benutzer_id
         and not (b.email_bestaetigt_am is not null and p.email is not null and lower(b.email) = lower(p.email)
                  and p.email_gesetzt_von is distinct from new.geaendert_von
                  and not exists (select 1 from personen_zugriffe z where z.person_id = p.id and z.benutzer_id = p.email_gesetzt_von
                                     and z.erteilt_von = new.geaendert_von));
    end if;
  end if;
  return null;
end $$;

-- Beendete Anträge behalten keine Pass-Nr.
update mitgliedschaftsantraege set judopass_nr = null where status <> 'offen' and judopass_nr is not null;
