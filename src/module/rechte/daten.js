export const direktrechteBeenden = (db, { benutzerId, vereinId, von, jetzt }) => db.query(
  'update benutzer_rechte set geloescht_am = $3, geaendert_von = $4 where benutzer_id = $1 and verein_id = $2 and geloescht_am is null',
  [benutzerId, vereinId, jetzt, von]);

export const systemrollen = async (db) => (await db.query(
  `select r.id, r.schluessel, r.name, r.ebene, r.verband_typen,
          coalesce((select array_agg(b.recht || ':' || b.operation order by b.recht, b.operation) from rollen_berechtigungen b where b.rolle_id = r.id), '{}') as berechtigungen
     from rollen r where r.verein_id is null order by r.ebene, r.schluessel`)).rows;

export const rollentraeger = async (db, { verbandIds, rolle }) => (await db.query(
  'select distinct benutzer_id from benutzer_verbandsrollen where verband_id = any($1::uuid[]) and rolle = $2 and beendet_am is null', [verbandIds, rolle])).rows;

export const verbandsrollen = async (db, benutzerId) => (await db.query(
  'select rolle, verband_id from benutzer_verbandsrollen where benutzer_id = $1 and beendet_am is null', [benutzerId])).rows;
