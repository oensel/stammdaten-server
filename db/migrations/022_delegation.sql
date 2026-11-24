-- Story 2.8 (FR-22, E6, E102): befristete Delegation von Rechten, höchstens zwei Jahre, nur eine Ebene.
-- Ohne Quelle (delegiert_aus_*) vergibt nur der Super-Admin; nur diese Direktvergabe darf DELEGIEREN enthalten.
-- vergeben_durch_super_admin setzt der Trigger aus dem Geber, nicht die API.
create table delegationen (
  id                        uuid primary key default gen_random_uuid(),
  empfaenger_id             uuid not null references benutzer(id),
  geber_id                  uuid not null references benutzer(id),
  verein_id                 uuid references vereine(id),
  verband_id                uuid references verbaende(id),
  recht                     text not null,
  operation                 text not null,
  datenfilter_id            uuid references datenfilter(id),
  gueltig_von               date not null,
  gueltig_bis               date not null,
  delegiert_aus_quelle      text check (delegiert_aus_quelle in ('rolle', 'lizenz')),
  delegiert_aus_schluessel  text,
  vergeben_durch_super_admin boolean not null default false,
  grund                     text,
  erstellt_am               timestamptz not null default now(),
  verwaist_seit             timestamptz,
  beendet_am                timestamptz,
  beendet_von               uuid references benutzer(id),
  foreign key (recht, operation) references rechte_operationen (recht, operation),
  constraint delegation_ein_bereich check (num_nonnulls(verein_id, verband_id) = 1),
  constraint delegation_selbst check (geber_id <> empfaenger_id),
  constraint delegation_zeitraum check (gueltig_bis >= gueltig_von),
  constraint delegation_quelle check ((delegiert_aus_quelle is null) = (delegiert_aus_schluessel is null)),
  constraint keine_weiterdelegation check (operation <> 'DELEGIEREN' or delegiert_aus_quelle is null),
  constraint delegieren_nur_super_admin check (operation <> 'DELEGIEREN' or vergeben_durch_super_admin),
  constraint delegation_ohne_quelle check (delegiert_aus_quelle is not null or vergeben_durch_super_admin)
);
create index delegationen_empfaenger_idx on delegationen (empfaenger_id) where beendet_am is null;
create index delegationen_geber_idx on delegationen (geber_id) where beendet_am is null;
create index delegationen_verein_idx on delegationen (verein_id) where beendet_am is null;
create index delegationen_verband_idx on delegationen (verband_id) where beendet_am is null;

create function delegation_pruefen() returns trigger language plpgsql as $$
begin
  new.vergeben_durch_super_admin := coalesce((select ist_super_admin from benutzer where id = new.geber_id), false);
  if new.gueltig_bis > new.gueltig_von + interval '2 years' then
    raise exception 'Eine Delegation gilt höchstens zwei Jahre' using errcode = 'check_violation', constraint = 'delegation_zu_lang';
  end if;
  if (select count(*) from benutzer where id in (new.geber_id, new.empfaenger_id) and aktiv) < 2 then
    raise exception 'Benutzer unbekannt' using errcode = 'check_violation', constraint = 'delegation_benutzer_unbekannt';
  end if;
  if new.verein_id is not null and not exists (
       select 1 from benutzer_vereine where benutzer_id = new.empfaenger_id and verein_id = new.verein_id and status = 'freigegeben' and geloescht_am is null) then
    raise exception 'Der Empfänger gehört dem Verein nicht an' using errcode = 'check_violation', constraint = 'delegation_kein_mitglied';
  end if;
  return new;
end $$;
create trigger delegation_pruefen before insert on delegationen for each row execute function delegation_pruefen();
