export const direktrechteBeenden = (db, { benutzerId, vereinId, von, jetzt }) => db.query(
  'update benutzer_rechte set geloescht_am = $3, geaendert_von = $4 where benutzer_id = $1 and verein_id = $2 and geloescht_am is null',
  [benutzerId, vereinId, jetzt, von]);

export const rollenMitRechten = async (db, schluessel) => (await db.query(
  `select r.schluessel, coalesce(array_agg(b.recht || ':' || b.operation) filter (where b.recht is not null), '{}') as rechte,
          coalesce(jsonb_object_agg(b.recht || ':' || b.operation, to_jsonb(f)) filter (where f.id is not null), '{}') as filter
     from rollen r left join rollen_berechtigungen b on b.rolle_id = r.id left join datenfilter f on f.id = b.datenfilter_id
    where r.verein_id is null and r.schluessel = any($1) group by r.id order by r.schluessel`, [schluessel])).rows;

/** 1 = Dachverband … 4 = Kreis */
export const ebene = async (db, verbandId) => (await db.query('select count(*)::int n from verband_pfade where nachfahr_id = $1', [verbandId])).rows[0].n;

export const vorfahren = async (db, ids) => Object.fromEntries((await db.query(
  'select nachfahr_id, array_agg(vorfahr_id) as v from verband_pfade where nachfahr_id = any($1::uuid[]) group by nachfahr_id', [ids])).rows.map((r) => [r.nachfahr_id, r.v]));

export const systemrollen = async (db) => (await db.query(
  `select r.id, r.schluessel, r.name, r.ebene, r.verband_typen,
          coalesce((select array_agg(b.recht || ':' || b.operation order by b.recht, b.operation) from rollen_berechtigungen b where b.rolle_id = r.id), '{}') as berechtigungen
     from rollen r where r.verein_id is null order by r.ebene, r.schluessel`)).rows;

export const rollentraeger = async (db, { verbandIds, rolle }) => (await db.query(
  'select distinct benutzer_id from benutzer_verbandsrollen where verband_id = any($1::uuid[]) and rolle = $2 and beendet_am is null', [verbandIds, rolle])).rows;

export const verbandsrollen = async (db, benutzerId) => (await db.query(
  'select rolle, verband_id from benutzer_verbandsrollen where benutzer_id = $1 and beendet_am is null', [benutzerId])).rows;
