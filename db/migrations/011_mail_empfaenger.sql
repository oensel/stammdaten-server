-- Mail-Aufträge merken den Benutzer; die Adresse löst der Worker erst beim Versand auf (Module kennen fremde Tabellen nicht).
alter table mail_auftraege add column benutzer_id uuid references benutzer(id);
alter table mail_auftraege alter column an drop not null;
alter table mail_auftraege add constraint mail_auftraege_empfaenger check (benutzer_id is not null or an is not null);
