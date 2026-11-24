-- Einladungen: vorgesehenes Mitglied und Einladender am Einmal-Token
alter table einmal_tokens add column mitglied_id uuid;
alter table einmal_tokens add column erstellt_von uuid references benutzer(id) on delete set null;
create index einmal_tokens_benutzer_idx on einmal_tokens (benutzer_id, zweck) where benutzt_am is null;
