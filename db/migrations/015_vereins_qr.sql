-- Story 2.10: Registrierung per Vereins-QR-Code. Nur der Hash des Codes liegt in der Datenbank.
create table vereins_qr_codes (
  id             uuid primary key default gen_random_uuid(),
  verein_id      uuid not null references vereine(id),
  token_hash     char(64) not null unique,
  erstellt_von   uuid not null references benutzer(id),
  erstellt_am    timestamptz not null,
  laeuft_ab_am   timestamptz not null,
  widerrufen_am  timestamptz
);
create index vereins_qr_codes_verein_idx on vereins_qr_codes (verein_id);
