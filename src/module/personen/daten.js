const eine = async (db, sql, p) => (await db.query(sql, p)).rows[0];

export const personAnlegen = (db, p) => eine(db,
  `insert into personen (vorname, nachname, geburtsdatum, geschlecht, nationalitaet, strasse, plz, ort, land, email, telefon,
                         heimatverein_id, judopass_hinweis, geaendert_von)
   values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,'DE'),$10,$11,$12,$13,$14) returning id`,
  [p.vorname, p.nachname, p.geburtsdatum, p.geschlecht, p.nationalitaet, p.strasse, p.plz, p.ort, p.land, p.email, p.telefon,
    p.vereinId, p.judopassId, p.von]);

/** Vergibt die nächste Mitgliedsnummer. Dieselbe Sperre wie der /v1-Import, damit beide Wege nicht dieselbe Nummer ziehen. */
export async function mitgliedschaftAnlegen(db, { personId, vereinId, vorname, nachname, eintritt, von }) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`import:${vereinId}`]);
  return eine(db,
    `insert into mitglieder (person_id, verein_id, mitgliedsnr, vorname, nachname, eintritt, geaendert_von)
     select $1::uuid, $2::uuid, coalesce(max(mitgliedsnr), 0) + 1, $3, $4, $5::date, $6::uuid from mitglieder where verein_id = $2
     returning id, mitgliedsnr, status, eintritt`, [personId, vereinId, vorname, nachname, eintritt, von]);
}

export const aufgabeAnlegen = (db, { art, verbandId, personId, jetzt, von }) => db.query(
  'insert into aufgaben (art, verband_id, person_id, erstellt_am, erstellt_von) values ($1,$2,$3,$4,$5)', [art, verbandId, personId, jetzt, von]);

const PERSON = `id, vorname, nachname, geburtsdatum, geschlecht, nationalitaet, strasse, plz, ort, land, email, telefon, heimatverein_id, benutzer_id, change_seq`;
export const personLesen = (db, id) => eine(db, `select ${PERSON} from personen where id = $1`, [id]);
export const personSperren = (db, id) => eine(db, `select ${PERSON} from personen where id = $1 for no key update`, [id]);
export const mitgliedschaften = async (db, personId) => (await db.query(
  `select id, verein_id, mitgliedsnr, status, eintritt, austritt from mitglieder where person_id = $1 and geloescht_am is null order by erstellt_am, id`, [personId])).rows;
export const kontaktAendern = (db, p) => eine(db,
  `update personen set strasse = $2, plz = $3, ort = $4, land = $5, email = $6, telefon = $7, geaendert_von = $8 where id = $1 returning ${PERSON}`,
  [p.id, p.strasse, p.plz, p.ort, p.land, p.email, p.telefon, p.von]);

// ---- Zugriffe ----
const ZUGRIFF = 'id, person_id, benutzer_id, art, umfang, erteilt_von, erteilt_am, freigeschaltet_bis, widerrufen_am';
export const zugriffFuer = (db, { personId, benutzerId }) => eine(db,
  `select ${ZUGRIFF} from personen_zugriffe where person_id = $1 and benutzer_id = $2 and widerrufen_am is null`, [personId, benutzerId]);
export const zugriffeVon = async (db, personId) => (await db.query(
  `select ${ZUGRIFF} from personen_zugriffe where person_id = $1 and widerrufen_am is null order by erteilt_am, id`, [personId])).rows;
export const zugriffSperren = (db, { id, personId }) => eine(db,
  `select ${ZUGRIFF} from personen_zugriffe where id = $1 and person_id = $2 and widerrufen_am is null for update`, [id, personId]);
export const zugriffAnlegen = (db, z) => eine(db,
  `insert into personen_zugriffe (person_id, benutzer_id, art, umfang, freigeschaltet_bis, erteilt_von, erteilt_am) values ($1,$2,$3,$4,$5,$6,$7) returning ${ZUGRIFF}`,
  [z.personId, z.benutzerId, z.art, z.umfang, z.bis, z.von, z.jetzt]);
export const zugriffBeenden = (db, { id, von, jetzt }) => eine(db,
  `update personen_zugriffe set widerrufen_am = $3, widerrufen_von = $2 where id = $1 returning ${ZUGRIFF}`, [id, von, jetzt]);
export const personenFuerBenutzer = async (db, benutzerId) => (await db.query(
  `select ${PERSON} from personen where benutzer_id = $1
      or id in (select person_id from personen_zugriffe where benutzer_id = $1 and widerrufen_am is null) order by lower(nachname), lower(vorname), id`, [benutzerId])).rows;
