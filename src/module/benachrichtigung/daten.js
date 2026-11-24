export const nachrichtAnlegen = (db, { benutzer_id, art, titel, text, jetzt }) => db.query(
  'insert into nachrichten (benutzer_id, art, titel, text, erstellt_am) values ($1,$2,$3,$4,$5)', [benutzer_id, art, titel, text, jetzt]);

export const mailAnlegen = (db, { benutzer_id, betreff, text, jetzt }) => db.query(
  'insert into mail_auftraege (benutzer_id, betreff, text, erstellt_am, naechster_versuch_am) values ($1,$2,$3,$4,$4)', [benutzer_id, betreff, text, jetzt]);

export const naechsteOffeneMail = async (db, jetzt) => (await db.query(
  `select id, benutzer_id, an, betreff, text, versuche from mail_auftraege where status = 'offen' and naechster_versuch_am <= $1
    order by naechster_versuch_am, id limit 1 for update skip locked`, [jetzt])).rows[0];

export const mailGesendet = (db, id, jetzt) => db.query(
  `update mail_auftraege set status = 'gesendet', gesendet_am = $2, versuche = versuche + 1 where id = $1`, [id, jetzt]);

export const mailFehlgeschlagen = (db, id, { status, naechster }) => db.query(
  'update mail_auftraege set versuche = versuche + 1, status = $2, naechster_versuch_am = $3 where id = $1', [id, status, naechster]);
