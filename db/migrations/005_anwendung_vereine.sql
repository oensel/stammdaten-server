-- Welche Vereine eine App im Server-zu-Server-Abgleich (GET /v1/abgleich, Client-Credentials) sehen darf
create table anwendung_vereine (
  anwendung_id uuid not null references anwendungen(id) on delete cascade,
  verein_id    uuid not null references vereine(id) on delete cascade,
  erstellt_am  timestamptz not null default now(),
  primary key (anwendung_id, verein_id)
);
create index anwendung_vereine_verein_idx on anwendung_vereine (verein_id);
