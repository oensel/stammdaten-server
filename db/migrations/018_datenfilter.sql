-- FR-23: wiederverwendbare Datenfilter an Berechtigungen. Alle gesetzten Teile müssen erfüllt sein; null = unbeschränkt.
create table datenfilter (
  id                     uuid primary key default gen_random_uuid(),
  schluessel             text not null unique,
  name                   text not null,
  nur_aktive             boolean not null default true,
  subjekt_min_rang       smallint check (subjekt_min_rang between 1 and 19),   -- 9. Kyu = 1 … 1. Kyu = 9, 1. Dan = 10 … 10. Dan = 19
  subjekt_max_rang       smallint check (subjekt_max_rang between 1 and 19),
  subjekt_lizenz         text,                                                 -- Schlüssel der Lizenzart; auch abgelaufen
  wert_art               text check (wert_art in ('kyu', 'dan')),
  wert_min_rang          smallint check (wert_min_rang between 1 and 19),
  wert_max_rang          smallint check (wert_max_rang between 1 and 19),
  wert_bis_eigener_grad  boolean not null default false,
  felder                 text[],                                               -- Feldgruppen oder einzelne Felder
  check (subjekt_min_rang <= subjekt_max_rang),
  check (wert_min_rang <= wert_max_rang)
);
alter table rollen_berechtigungen add column datenfilter_id uuid references datenfilter(id);

insert into datenfilter (schluessel, name, nur_aktive, subjekt_min_rang, subjekt_lizenz, wert_art, wert_min_rang, wert_max_rang, felder) values
  ('ohne_kontakt',          'Ohne Kontaktdaten',                         true,  null, null,       null,  null, null, '{stamm}'),
  ('ab_2_kyu_ohne_kontakt', 'Ab 2. Kyu, ohne Kontaktdaten',              true,  8,    null,       null,  null, null, '{stamm}'),
  ('ab_1_kyu_ohne_kontakt', 'Ab 1. Kyu, auch Inaktive, ohne Kontakt',    false, 9,    null,       null,  null, null, '{stamm}'),
  ('ab_2_kyu',              'Ab 2. Kyu',                                 true,  8,    null,       null,  null, null, null),
  ('ab_1_kyu',              'Ab 1. Kyu, auch Inaktive',                  false, 9,    null,       null,  null, null, null),
  ('alle_ohne_kontakt',     'Auch Inaktive, ohne Kontaktdaten',          false, null, null,       null,  null, null, '{stamm}'),
  ('judopassfelder',        'Judopass-Felder bei Personen mit Judopass', false, null, 'judopass', null,  null, null, '{vorname,nachname,geburtsdatum,nationalitaet}'),
  ('pruefung_8_bis_2_kyu',  'Prüfungen 8. bis 2. Kyu',                   false, null, null,       'kyu', 2,    8,    null),
  ('pruefung_1_kyu',        'Prüfungen zum 1. Kyu',                      false, null, null,       'kyu', 9,    9,    null),
  ('pruefung_dan',          'Dan-Prüfungen',                             false, null, null,       'dan', null, null, null);

update rollen_berechtigungen b set datenfilter_id = f.id
  from rollen r, datenfilter f, (values
    ('trainer',                   'mitglieder',  'LESEN',   'ohne_kontakt'),
    ('trainer',                   'pruefung',    null,      'pruefung_8_bis_2_kyu'),
    ('kreis_dan_vorsitzender',    'mitglieder',  'LESEN',   'ab_2_kyu_ohne_kontakt'),
    ('kreis_dan_vorsitzender',    'graduierung', 'LESEN',   'ab_2_kyu'),
    ('kreis_dan_vorsitzender',    'pruefung',    null,      'pruefung_1_kyu'),
    ('kreis_dan_vorsitzender',    'pruefung_abnahme',   null, 'pruefung_1_kyu'),
    ('kreis_dan_vorsitzender',    'pruefung_abschluss', null, 'pruefung_1_kyu'),
    ('bezirks_dan_beauftragter',  'mitglieder',  'LESEN',   'ab_1_kyu_ohne_kontakt'),
    ('bezirks_dan_beauftragter',  'graduierung', 'LESEN',   'ab_1_kyu'),
    ('landesvertreter',           'mitglieder',  'LESEN',   'alle_ohne_kontakt'),
    ('landesvertreter',           'mitglieder',  'AENDERN', 'judopassfelder'),
    ('dan_pruefungsorganisation', 'pruefung',    null,      'pruefung_dan')
  ) as z (rolle, recht, operation, filter)
 where r.schluessel = z.rolle and r.verein_id is null and b.rolle_id = r.id and b.recht = z.recht
   and (z.operation is null or b.operation = z.operation) and f.schluessel = z.filter;
