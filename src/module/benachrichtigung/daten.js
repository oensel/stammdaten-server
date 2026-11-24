export const nachrichtAnlegen = (db, { benutzer_id, art, titel, text, jetzt }) => db.query(
  'insert into nachrichten (benutzer_id, art, titel, text, erstellt_am) values ($1,$2,$3,$4,$5)', [benutzer_id, art, titel, text, jetzt]);

export const mailAnlegen = (db, { benutzer_id, betreff, text, jetzt }) => db.query(
  'insert into mail_auftraege (benutzer_id, betreff, text, erstellt_am, naechster_versuch_am) values ($1,$2,$3,$4,$4)', [benutzer_id, betreff, text, jetzt]);

/** Reserviert den nächsten fälligen Auftrag bis `frist` und zählt den Versuch; danach ist keine Transaktion mehr offen. */
export const mailReservieren = async (db, { jetzt, frist }) => (await db.query(
  `update mail_auftraege set versuche = versuche + 1, naechster_versuch_am = $2
    where id = (select id from mail_auftraege where status = 'offen' and naechster_versuch_am <= $1
                 order by naechster_versuch_am, id limit 1 for update skip locked)
   returning id, benutzer_id, an, betreff, text, versuche`, [jetzt, frist])).rows[0];

export const mailGesendet = (db, id, jetzt) => db.query(`update mail_auftraege set status = 'gesendet', gesendet_am = $2 where id = $1`, [id, jetzt]);

export const mailFehlgeschlagen = (db, id, { status, naechster }) => db.query(
  'update mail_auftraege set status = $2, naechster_versuch_am = $3 where id = $1', [id, status, naechster]);

/** Gibt eine Reservierung zurück, ohne dass ein Versuch stattfand. */
export const mailFreigeben = (db, id, jetzt) => db.query(
  'update mail_auftraege set versuche = versuche - 1, naechster_versuch_am = $2 where id = $1', [id, jetzt]);
