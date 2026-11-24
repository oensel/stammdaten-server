-- Das Schema vor 010 erlaubte jede Elternbeziehung. Rechte (Ebene) und Pfade setzen die Ebenenfolge voraus: lieber hier abbrechen.
do $$
declare fehler text;
begin
  select string_agg(text, '; ') into fehler from (
    select 'Verband ' || v.name || ' (' || v.typ || ')' as text
      from verbaende v left join verbaende e on e.id = v.uebergeordnet_id
     where v.geloescht_am is null
       and e.typ is distinct from case v.typ when 'landesverband' then 'dachverband' when 'bezirk' then 'landesverband' when 'kreis' then 'bezirk' end
    union all
    select 'Verein ' || v.name from vereine v join verbaende e on e.id = v.verband_id where v.geloescht_am is null and e.typ <> 'kreis') x;
  if fehler is not null then
    raise exception 'Ebenenfolge DJB > Landesverband > Bezirk > Kreis > Verein verletzt, bitte vor der Migration berichtigen: %', fehler;
  end if;
end $$;
