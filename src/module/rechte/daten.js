export const verbandsrollen = async (db, benutzerId) => (await db.query(
  'select rolle, verband_id from benutzer_verbandsrollen where benutzer_id = $1 and beendet_am is null', [benutzerId])).rows;
