-- Nutzerentscheid 2026-11-24: auch Bezirks-Dan-Beauftragte sehen nur aktive Mitglieder
update datenfilter set nur_aktive = true, name = 'Ab 1. Kyu, ohne Kontaktdaten' where schluessel = 'ab_1_kyu_ohne_kontakt';
update datenfilter set nur_aktive = true, name = 'Ab 1. Kyu' where schluessel = 'ab_1_kyu';
