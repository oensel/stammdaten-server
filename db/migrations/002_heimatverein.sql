-- Heimatverein: Verein, in dem der Benutzer bei der Anmeldung zuerst landet (Wechsel danach per /auth/verein-wechseln)
alter table benutzer add column heimatverein_id uuid references vereine(id) on delete set null;
