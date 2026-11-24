-- AD-6: audit_log (bisher ungenutzt) in die Form der Audit-Einträge bringen. Der Zeitpunkt kommt aus ctx.jetzt.
alter table audit_log rename column tabelle to objekt_art;
alter table audit_log rename column datensatz_id to objekt_id;
alter table audit_log
  add column akteur text,           -- Benutzer-ID oder 'system:<name>'
  add column anwendung text,
  add column rolle text,
  add column stellvertreter boolean not null default false,
  add column ebene_art text check (ebene_art in ('verein', 'verband')),
  add column ebene_id uuid,
  add column grund text;
create index audit_log_ebene_idx on audit_log (ebene_id, zeitpunkt);

-- AD-12: In-App-Nachrichten und Mail-Aufträge
create table nachrichten (
  id           uuid primary key default gen_random_uuid(),
  benutzer_id  uuid not null references benutzer(id),
  art          text not null,
  titel        text not null,
  text         text not null,
  erstellt_am  timestamptz not null,
  gelesen_am   timestamptz
);
create index nachrichten_benutzer_idx on nachrichten (benutzer_id, erstellt_am);

create table mail_auftraege (
  id                   uuid primary key default gen_random_uuid(),
  an                   text not null,
  betreff              text not null,
  text                 text not null,
  status               text not null default 'offen' check (status in ('offen', 'gesendet', 'fehlgeschlagen')),
  versuche             integer not null default 0,
  naechster_versuch_am timestamptz not null,
  erstellt_am          timestamptz not null,
  gesendet_am          timestamptz
);
create index mail_auftraege_offen_idx on mail_auftraege (naechster_versuch_am) where status = 'offen';
