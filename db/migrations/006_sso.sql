-- Single Sign-on (docs/sso-entscheidung.md): Angaben für den App-Umschalter und den Back-Channel-Logout
alter table anwendungen add column url text;              -- Startadresse der App (App-Umschalter), z. B. https://kyu.example.org
alter table anwendungen add column icon text;             -- optional: kurzer Name/URL eines Symbols
alter table anwendungen add column backchannel_url text;  -- POST-Ziel für das Logout-Token (serverseitig erreichbar)
