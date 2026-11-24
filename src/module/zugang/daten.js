const SPALTEN = 'bv.id, bv.benutzer_id, bv.verein_id, bv.rolle, bv.status, bv.change_seq';
const eine = async (db, sql, p) => (await db.query(sql, p)).rows[0];

export const freigegebeneVereine = async (db, benutzerId) => (await db.query(
  `select verein_id from benutzer_vereine where benutzer_id = $1 and status = 'freigegeben' and geloescht_am is null order by 1`, [benutzerId])).rows.map((r) => r.verein_id);

/** Neue Anfrage; eine abgelehnte oder entfernte Zugehörigkeit lebt als reine Mitglied-Anfrage wieder auf. Sonst undefined. */
export const anfragen = (db, { benutzerId, vereinId }) => eine(db,
  `insert into benutzer_vereine as bv (benutzer_id, verein_id, status, angefragt_ueber, geaendert_von)
   values ($1, $2, 'angefragt', 'selbstregistrierung', $1)
   on conflict (benutzer_id, verein_id) do update
     set status = 'angefragt', rolle = 'mitglied', mitglied_id = null, angefragt_ueber = 'selbstregistrierung',
         entschieden_von = null, entschieden_am = null, geloescht_am = null, geaendert_von = excluded.geaendert_von
     where bv.status = 'abgelehnt' or (bv.geloescht_am is not null and bv.status <> 'gesperrt')
   returning ${SPALTEN}`, [benutzerId, vereinId]);

export const liste = async (db, { vereinId, status }) => (await db.query(
  `select ${SPALTEN}, b.benutzername, b.vorname, b.nachname
     from benutzer_vereine bv join benutzer b on b.id = bv.benutzer_id and b.geloescht_am is null
    where bv.verein_id = $1 and bv.geloescht_am is null and ($2::text is null or bv.status = $2)
    order by lower(b.nachname), lower(b.vorname), bv.id`, [vereinId, status])).rows;

export const sperren = (db, { id, vereinId }) => eine(db,
  `select ${SPALTEN}, b.ist_super_admin from benutzer_vereine bv join benutzer b on b.id = bv.benutzer_id and b.geloescht_am is null
    where bv.id = $1 and bv.verein_id = $2 and bv.geloescht_am is null for update of bv`, [id, vereinId]);

/** Beim Entzug fällt die Rolle auf Mitglied zurück, damit eine spätere Freigabe keine alten Rechte belebt. */
export const entscheiden = (db, { id, status, rolle, von, jetzt }) => eine(db,
  `update benutzer_vereine bv set status = $2, rolle = $3, entschieden_von = $4, entschieden_am = $5, geaendert_von = $4
    where id = $1 returning ${SPALTEN}`, [id, status, rolle, von, jetzt]);

export const qrAnlegen = (db, c) => eine(db,
  `insert into vereins_qr_codes (verein_id, token_hash, erstellt_von, erstellt_am, laeuft_ab_am) values ($1,$2,$3,$4,$5)
   returning id, erstellt_am, laeuft_ab_am`, [c.vereinId, c.hash, c.von, c.jetzt, c.ablauf]);
export const qrListe = async (db, vereinId) => (await db.query(
  'select id, erstellt_am, laeuft_ab_am, widerrufen_am from vereins_qr_codes where verein_id = $1 order by erstellt_am desc', [vereinId])).rows;
export const qrWiderrufen = async (db, { id, vereinId, jetzt }) => eine(db,
  `update vereins_qr_codes set widerrufen_am = coalesce(widerrufen_am, $3) where id = $1 and verein_id = $2
   returning id, erstellt_am, laeuft_ab_am, widerrufen_am`, [id, vereinId, jetzt]);
/** Gültiger Code; die Zeilensperre hält einen gleichzeitigen Widerruf bis zum Ende der Transaktion auf. */
export const qrGueltig = (db, { hash, jetzt }) => eine(db,
  'select verein_id from vereins_qr_codes where token_hash = $1 and widerrufen_am is null and laeuft_ab_am > $2 for update', [hash, jetzt]);

export const offeneAnfragen = async (db, vereinId) => (await eine(db,
  `select count(*)::int n from benutzer_vereine where verein_id = $1 and status = 'angefragt' and geloescht_am is null`, [vereinId])).n;
export const vereinsAdmins = async (db, vereinId) => (await db.query(
  `select benutzer_id from benutzer_vereine where verein_id = $1 and rolle = 'admin' and status = 'freigegeben' and geloescht_am is null`, [vereinId])).rows;
export const benutzerName = (db, id) => eine(db, 'select benutzername, vorname, nachname from benutzer where id = $1', [id]);
export const benutzerAnlegen = (db, b) => eine(db,
  'insert into benutzer (benutzername, vorname, nachname, passwort_hash) values ($1,$2,$3,$4) returning id', [b.benutzername, b.vorname, b.nachname, b.hash]);

export const einladungenVerbrauchen = (db, { benutzerId, vereinId, jetzt }) => db.query(
  `update einmal_tokens set benutzt_am = $3 where benutzer_id = $1 and verein_id = $2 and zweck = 'einladung' and benutzt_am is null`, [benutzerId, vereinId, jetzt]);

/** Beendet die Bezüge eines Benutzers auf Mitglieder eines Vereins: eigenes Mitglied und Kinder. */
export async function mitgliedsbezuegeBeenden(db, { benutzerId, vereinId, jetzt }) {
  await db.query('update benutzer_vereine set mitglied_id = null where benutzer_id = $1 and verein_id = $2 and mitglied_id is not null', [benutzerId, vereinId]);
  await db.query('update erziehungsberechtigte set geloescht_am = $3 where benutzer_id = $1 and verein_id = $2 and geloescht_am is null', [benutzerId, vereinId, jetzt]);
}

/** Konto zur Anmeldung mit Passwort (Benutzername oder E-Mail), mit Sperrzustand. */
export const kontoFuerAnmeldung = (db, { kennung, jetzt }) => eine(db,
  `select id, passwort_hash, coalesce(gesperrt_bis > $2, false) as gesperrt from benutzer
    where (lower(benutzername) = lower($1) or lower(email) = lower($1)) and aktiv and geloescht_am is null
    order by (lower(benutzername) = lower($1)) desc limit 1`, [kennung, jetzt]);
export const fehlversuch = (db, { id, max, sperreBis }) => db.query(
  `update benutzer set gesperrt_bis = case when fehlversuche + 1 >= $2 then $3::timestamptz else gesperrt_bis end,
          fehlversuche = case when fehlversuche + 1 >= $2 then 0 else fehlversuche + 1 end where id = $1`, [id, max, sperreBis]);
export const fehlversucheZuruecksetzen = (db, id) => db.query('update benutzer set fehlversuche = 0 where id = $1', [id]);

// ---- Zweiter Faktor (Story 2.9) ----
export const mfaBenutzer = (db, { id, jetzt }) => eine(db,
  `select id, benutzername, ist_super_admin, totp_aktiv_am, gesperrt_bis > $2 as gesperrt
     from benutzer where id = $1 and aktiv and geloescht_am is null`, [id, jetzt]);

export const totpGeheimnisLesen = async (db, id) => (await eine(db, 'select totp_secret_verschluesselt as wert from benutzer where id = $1', [id]))?.wert ?? null;

export const totpGeheimnisSetzen = (db, { id, wert }) => db.query(
  'update benutzer set totp_secret_verschluesselt = $2, totp_letzter_schritt = null where id = $1 and totp_aktiv_am is null', [id, wert]);

/** Ein UPDATE: bei parallelen Anfragen gewinnt genau eine; ein schon benutzter Schritt zählt nicht. */
export const totpSchrittVerbrauchen = async (db, { id, schritt }) => (await db.query(
  'update benutzer set totp_letzter_schritt = $2 where id = $1 and (totp_letzter_schritt is null or totp_letzter_schritt < $2)', [id, schritt])).rowCount === 1;

export const totpAktivieren = (db, { id, schritt, jetzt }) => db.query(
  'update benutzer set totp_aktiv_am = $3, totp_letzter_schritt = $2 where id = $1', [id, schritt, jetzt]);

export const backupCodesErsetzen = async (db, { id, hashes }) => {
  await db.query('delete from totp_backup_codes where benutzer_id = $1', [id]);
  for (const h of hashes) await db.query('insert into totp_backup_codes (benutzer_id, code_hash) values ($1, $2)', [id, h]);
};

export const backupCodeVerbrauchen = async (db, { id, hash, jetzt }) => (await db.query(
  'update totp_backup_codes set benutzt_am = $3 where benutzer_id = $1 and code_hash = $2 and benutzt_am is null', [id, hash, jetzt])).rowCount === 1;
