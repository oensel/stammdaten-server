export const rollentraeger = async (db, { verbandIds, rolle }) => (await db.query(
  'select distinct benutzer_id from benutzer_verbandsrollen where verband_id = any($1::uuid[]) and rolle = $2 and beendet_am is null', [verbandIds, rolle])).rows;

export const verbandsrollen = async (db, benutzerId) => (await db.query(
  'select rolle, verband_id from benutzer_verbandsrollen where benutzer_id = $1 and beendet_am is null', [benutzerId])).rows;
