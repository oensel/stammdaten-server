// Passwort-/PIN-Hashes (argon2id), Startpasswörter, Token-Hashes.
import argon2 from 'argon2';
import { createHash, randomBytes, randomInt } from 'node:crypto';
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
