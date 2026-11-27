const VERBAND = 'id, name, kurzname, typ, uebergeordnet_id, change_seq';
const VEREIN = `id, name, kurzname, vereinsnummer, ort, verband_id, aufgeloest_am, change_seq`;
const eine = async (db, sql, p) => (await db.query(sql, p)).rows[0];

export const alleVerbaende = async (db) => (await db.query(`select ${VERBAND} from verbaende where geloescht_am is null order by lower(name)`)).rows;
export const alleVereine = async (db) => (await db.query(
  `select ${VEREIN} from vereine where geloescht_am is null and registrierung_status = 'freigegeben' order by lower(name)`)).rows;

// no key update: verträgt sich mit den Fremdschlüsselprüfungen der verband_pfade-Trigger (sonst Deadlock)
export const verbandSperren = (db, id) => eine(db, `select ${VERBAND} from verbaende where id = $1 and geloescht_am is null for no key update`, [id]);
export const vereinSperren = (db, id) => eine(db, `select ${VEREIN} from vereine where id = $1 and geloescht_am is null for no key update`, [id]);

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

export const verbandLesen = (db, id) => eine(db, `select ${VERBAND} from verbaende where id = $1 and geloescht_am is null`, [id]);

/** Wirksame Fristen eines Verbands oder Vereins: unterste Ebene im Pfad gewinnt, sonst der DJB-Standard. `art` null = alle. */
export const fristenAufloesen = async (db, { art, verbandId }) => (await db.query(
  `select distinct on (f.art) f.art, f.wert, f.einheit, f.verband_id as quelle_verband_id
     from fristen f left join verband_pfade p on p.vorfahr_id = f.verband_id and p.nachfahr_id = $2
    where ($1::text is null or f.art = $1) and (f.verband_id is null or p.nachfahr_id is not null)
    order by f.art, p.tiefe asc nulls last`, [art, verbandId])).rows;

/** Sperrt den Standard der Fristart: Änderungen einer Art laufen nacheinander (auch das erste Überschreiben). */
export const fristArtSperren = (db, art) => eine(db, 'select einheit from fristen where art = $1 and verband_id is null for update', [art]);
export const fristLesen = (db, art, verbandId) => eine(db, 'select wert, einheit from fristen where art = $1 and verband_id is not distinct from $2', [art, verbandId]);
export const fristSetzen = (db, { art, verbandId, wert, einheit }) => eine(db,
  `insert into fristen (art, verband_id, wert, einheit) values ($1,$2,$3,$4)
   on conflict on constraint fristen_art_verband_uq do update set wert = excluded.wert returning id, wert, einheit`, [art, verbandId, wert, einheit]);

export const vereinLesen = (db, id) => eine(db, `select ${VEREIN} from vereine where id = $1 and geloescht_am is null`, [id]);
export const vereineImBereich = async (db, { alle, vereine, verbaende }) => (await db.query(
  `select ${VEREIN} from vereine
    where geloescht_am is null and ($1 or id = any($2::uuid[])
       or exists (select 1 from verband_pfade p where p.nachfahr_id = vereine.id and p.vorfahr_id = any($3::uuid[])))
    order by lower(name), id`, [alle, vereine, verbaende])).rows;
/** Land des Vereins (Transfer geht nur an Vereine in Deutschland). */
export const vereinLand = (db, id) => eine(db, 'select land from vereine where id = $1 and geloescht_am is null', [id]);
