-- Nach einem Restore in einen neuen Cluster beginnen die Transaktionsnummern von vorn. Gespeicherte change_xid liegen dann über dem
-- Zähler (der Abgleich liefert sie nicht), und alte Stände der Apps können später versehentlich wieder passen.
-- abgleich_neu_beginnen() setzt alle change_xid auf die aktuelle Transaktion und erhöht die Epoche: alle Apps gleichen neu ab.
create table abgleich_epoche (
  einzig  boolean primary key default true check (einzig),
  epoche  integer not null
);
insert into abgleich_epoche (epoche) values (0);

create function abgleich_neu_beginnen() returns integer language plpgsql as $$
declare t text; n integer;
begin
  perform set_config('session_replication_role', 'replica', true);  -- ohne Trigger: change_seq und geaendert_am bleiben
  for t in select c.table_name from information_schema.columns c
             join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name and b.table_type = 'BASE TABLE'
            where c.table_schema = 'public' and c.column_name = 'change_xid' loop
    execute format('update public.%I set change_xid = pg_current_xact_id()', t);
  end loop;
  perform set_config('session_replication_role', 'origin', true);
  update abgleich_epoche set epoche = epoche + 1 returning epoche into n;
  return n;
end $$;
