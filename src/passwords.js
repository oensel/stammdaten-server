// Passwort-/PIN-Hashes (argon2id), Startpasswörter, Token-Hashes.
import argon2 from 'argon2';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { badRequest } from './errors.js';

export const PW_MIN = 8;
export const PW_MAX = 200;
export const PIN_RE = /^\d{4,6}$/;

export const hashSecret = (s) => argon2.hash(s, { type: argon2.argon2id });
export async function verifySecret(hash, s) {
  if (!hash) return false;
  try { return await argon2.verify(hash, s); } catch { return false; }
}

// Für unbekannte Benutzer trotzdem einmal argon2 rechnen (gleiche Antwortzeit).
let dummy;
export async function verifyDummy(s) {
  dummy ||= hashSecret(randomBytes(16).toString('hex'));
  await verifySecret(await dummy, s);
  return false;
}

export function pruefeNeuesPasswort(pw, benutzername) {
  if (typeof pw !== 'string' || pw.length < PW_MIN) throw badRequest(`Das Passwort muss mindestens ${PW_MIN} Zeichen haben`, 'passwort_zu_kurz');
  if (pw.length > PW_MAX) throw badRequest('Das Passwort ist zu lang', 'passwort_zu_lang');
  if (benutzername && pw.toLowerCase() === String(benutzername).toLowerCase()) throw badRequest('Passwort und Benutzername dürfen nicht gleich sein', 'passwort_schwach');
}

// Startpasswort zum Abtippen: ohne verwechselbare Zeichen (0/O, 1/l/I), 10 Zeichen.
const ALPHA = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const startpasswort = (n = 10) => Array.from({ length: n }, () => ALPHA[randomInt(ALPHA.length)]).join('');

export const neuesToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---- TOTP nach RFC 6238 (HMAC-SHA1, 6 Stellen, 30 s) für den zweiten Faktor des Super-Admins ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SCHRITT_SEK = 30;
const FENSTER = 1; // ±1 Schritt Uhrabweichung

export function base32(buf) {
  let bits = 0; let wert = 0; let out = '';
  for (const b of buf) {
    wert = (wert << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(wert >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(wert << (5 - bits)) & 31];
  return out;
}
export const base32Dekodieren = (s) => {
  let bits = 0; let wert = 0; const out = [];
  for (const z of s.replace(/=+$/, '')) {
    wert = (wert << 5) | B32.indexOf(z); bits += 5;
    if (bits >= 8) { out.push((wert >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};

export const neuesGeheimnis = () => base32(randomBytes(20));
export const schrittFuer = (jetzt) => Math.floor(jetzt.getTime() / 1000 / SCHRITT_SEK);

export function code(geheimnis, schritt) {
  const z = Buffer.alloc(8); z.writeBigUInt64BE(BigInt(schritt));
  const h = createHmac('sha1', base32Dekodieren(geheimnis)).update(z).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Liefert den passenden Zeitschritt oder null. Der Aufrufer muss ihn danach als verbraucht eintragen (kein zweites Mal gültig). */
export function pruefeCode(geheimnis, eingabe, jetzt) {
  if (typeof eingabe !== 'string' || !/^\d{6}$/.test(eingabe)) return null;
  const jetztSchritt = schrittFuer(jetzt);
  for (let s = jetztSchritt - FENSTER; s <= jetztSchritt + FENSTER; s++) {
    if (timingSafeEqual(Buffer.from(code(geheimnis, s)), Buffer.from(eingabe))) return s;
  }
  return null;
}

export const otpauthUri = (geheimnis, konto, aussteller) =>
  `otpauth://totp/${encodeURIComponent(aussteller)}:${encodeURIComponent(konto)}?secret=${geheimnis}&issuer=${encodeURIComponent(aussteller)}`;

// Backup-Codes: 10 Stück, je einmal gültig, gespeichert nur als Hash
const CODE_ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
export const neueBackupCodes = (n = 10) => Array.from({ length: n }, () => {
  const b = randomBytes(10);
  return Array.from(b, (x) => CODE_ALPHA[x % CODE_ALPHA.length]).join('').replace(/(.{5})(.{5})/, '$1-$2');
});
