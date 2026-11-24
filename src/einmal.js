// Einmal-Tokens (E-Mail bestätigen, Passwort zurücksetzen, Einladung): nur der Hash liegt in der Datenbank.
import { neuesToken, sha256 } from './passwords.js';

/** Legt ein Token an und liefert den Klartext (nur zum Versand per Mail). */
export async function erzeugeEinmalToken(db, { benutzerId, zweck, stunden, vereinId = null, rolle = null, rechte = [], mitgliedId = null, erstelltVon = null }) {
  const t = neuesToken();
  await db.query(
    `insert into einmal_tokens (benutzer_id, zweck, verein_id, rolle, rechte, mitglied_id, erstellt_von, token_hash, laeuft_ab_am)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(hours => $9))`,
    [benutzerId, zweck, vereinId, rolle, rechte, mitgliedId, erstelltVon, sha256(t), stunden]);
  return t;
}

/** Gültiges, unbenutztes Token lesen (ohne es zu verbrauchen). */
export const liesEinmalToken = async (db, token, zweck) =>
  (await db.query(
    `select * from einmal_tokens where token_hash = $1 and zweck = $2 and benutzt_am is null and laeuft_ab_am > now()`,
    [sha256(token), zweck])).rows[0];

/** Atomar verbrauchen: true, wenn dieser Aufruf das Token benutzt hat (nur einer gewinnt). */
export const verbrauche = async (db, id) =>
  (await db.query('update einmal_tokens set benutzt_am = now() where id = $1 and benutzt_am is null returning id', [id])).rowCount === 1;

export const link = (cfg, pfad, token) => `${cfg.publicBaseUrl}/${pfad}#token=${token}`; // im Fragment: landet in keinem Server-Log
