// JWT mit EdDSA (Ed25519) – nur Node-Bordmittel. Die Apps prüfen mit jedem JWKS-fähigen Paket (z. B. jose).
import { sign, verify } from 'node:crypto';

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function signJwt(payload, { kid, privateKey }, typ = 'at+jwt') {
  const kopf = b64({ alg: 'EdDSA', typ, kid });
  const body = b64(payload);
  const sig = sign(null, Buffer.from(`${kopf}.${body}`), privateKey).toString('base64url');
  return `${kopf}.${body}.${sig}`;
}

/** Payload oder null (falsche Signatur, abgelaufen, falsche aud/iss). */
export function verifyJwt(token, keys, { aud, iss } = {}) {
  if (typeof token !== 'string') return null;
  const t = token.split('.');
  if (t.length !== 3) return null;
  try {
    const kopf = JSON.parse(Buffer.from(t[0], 'base64url').toString());
    const key = keys.publicKeys.get(kopf.kid);
    if (kopf.alg !== 'EdDSA' || !key) return null;
    if (!verify(null, Buffer.from(`${t[0]}.${t[1]}`), key, Buffer.from(t[2], 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(t[1], 'base64url').toString());
    if (typeof p.exp !== 'number' || p.exp <= Math.floor(Date.now() / 1000)) return null;
    if (aud && !(Array.isArray(p.aud) ? p.aud.includes(aud) : p.aud === aud)) return null;
    if (iss && p.iss !== iss) return null;
    return p;
  } catch {
    return null;
  }
}
