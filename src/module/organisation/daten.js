const VERBAND = 'id, name, kurzname, typ, uebergeordnet_id, change_seq';
const VEREIN = `id, name, kurzname, vereinsnummer, ort, verband_id, aufgeloest_am, change_seq`;
const eine = async (db, sql, p) => (await db.query(sql, p)).rows[0];

export const alleVerbaende = async (db) => (await db.query(`select ${VERBAND} from verbaende where geloescht_am is null order by lower(name)`)).rows;
export const alleVereine = async (db) => (await db.query(
  `select ${VEREIN} from vereine where geloescht_am is null and registrierung_status = 'freigegeben' order by lower(name)`)).rows;

export const verbandSperren = (db, id) => eine(db, `select ${VERBAND} from verbaende where id = $1 and geloescht_am is null for update`, [id]);
export const vereinSperren = (db, id) => eine(db, `select ${VEREIN} from vereine where id = $1 and geloescht_am is null for update`, [id]);

export const verbandAnlegen = (db, v) => eine(db,
  `insert into verbaende (name, kurzname, typ, uebergeordnet_id, geaendert_von) values ($1,$2,$3,$4,$5) returning ${VERBAND}`,
  [v.name, v.kurzname, v.typ, v.uebergeordnet_id, v.geaendert_von]);
export const verbandAendern = (db, v) => eine(db,
  `update verbaende set name = $2, kurzname = $3, uebergeordnet_id = $4, geaendert_von = $5 where id = $1 returning ${VERBAND}`,
  [v.id, v.name, v.kurzname, v.uebergeordnet_id, v.geaendert_von]);

export const vereinAnlegen = (db, v) => eine(db,
  `insert into vereine (name, kurzname, vereinsnummer, ort, verband_id, geaendert_von) values ($1,$2,$3,$4,$5,$6) returning ${VEREIN}`,
  [v.name, v.kurzname, v.vereinsnummer, v.ort, v.verband_id, v.geaendert_von]);
export const vereinAendern = (db, v) => eine(db,
  `update vereine set name = $2, kurzname = $3, vereinsnummer = $4, ort = $5, verband_id = $6, aufgeloest_am = $7, geaendert_von = $8
    where id = $1 returning ${VEREIN}`,
  [v.id, v.name, v.kurzname, v.vereinsnummer, v.ort, v.verband_id, v.aufgeloest_am, v.geaendert_von]);

export const landesverbandVon = (db, id) => eine(db,
  `select v.id, v.name from verband_pfade p join verbaende v on v.id = p.vorfahr_id where p.nachfahr_id = $1 and v.typ = 'landesverband'`, [id]);

export const pfadVorhanden = async (db, vorfahrId, nachfahrId) =>
  !!(await eine(db, 'select 1 from verband_pfade where vorfahr_id = $1 and nachfahr_id = $2', [vorfahrId, nachfahrId]));
