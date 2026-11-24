-- FR-15: die Sitzung merkt ihren Kontext (Verein oder Verband)
alter table refresh_tokens add column verband_id uuid references verbaende(id);
alter table refresh_tokens add constraint refresh_tokens_ein_kontext check (num_nonnulls(verein_id, verband_id) <= 1);
