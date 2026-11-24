// Signaturschlüssel (EdDSA/Ed25519) in der Tabelle signaturschluessel; privater Schlüssel mit AES-256-GCM (KEK aus der Umgebung).
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';

const kekBytes = (hex) => {
  const b = Buffer.from(hex, 'hex');
  if (b.length !== 32) throw new Error('SCHLUESSEL_KEK muss 32 Byte (64 Hex-Zeichen) lang sein');
  return b;
};

export function verschluessele(text, kekHex) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kekBytes(kekHex), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `enc1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
}
export function entschluessele(wert, kekHex) {
  const [praefix, iv, tag, enc] = wert.split(':');
  if (praefix !== 'enc1') throw new Error('Unbekanntes Format');
  const d = createDecipheriv('aes-256-gcm', kekBytes(kekHex), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

/** Neuen Signaturschlüssel anlegen (aktiv ab jetzt). */
export async function neuerSchluessel(db, kekHex) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const kid = `sk-${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'EdDSA' };
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  await db.query(
    `insert into signaturschluessel (kid, algorithmus, public_key_jwk, private_key_verschluesselt) values ($1, 'EdDSA', $2, $3)`,
    [kid, jwk, verschluessele(pem, kekHex)],
  );
  return kid;
}

/**
 * Schlüsselbund: aktueller Signaturschlüssel + alle zur Prüfung veröffentlichten. Legt beim ersten Start einen Schlüssel an.
 * Rotation: neuen Schlüssel anlegen, beim alten `signiert_bis` setzen (bleibt in der JWKS, bis `entfernt_am` gesetzt ist).
 */
export async function ladeSchluessel(pool, kekHex) {
  const aktiv = `where entfernt_am is null and aktiv_ab <= now() and (signiert_bis is null or signiert_bis > now())`;
  const hole = () => pool.query(`select kid, private_key_verschluesselt from signaturschluessel ${aktiv} order by aktiv_ab desc limit 1`);
  let r = await hole();
  if (!r.rows[0]) {
    await neuerSchluessel(pool, kekHex);
    r = await hole();
  }
  const { kid, private_key_verschluesselt: enc } = r.rows[0];
  const privateKey = createPrivateKey(entschluessele(enc, kekHex));
  const jwks = (await pool.query(`select public_key_jwk from signaturschluessel where entfernt_am is null order by aktiv_ab desc`)).rows.map((x) => x.public_key_jwk);
  return { kid, privateKey, jwks: { keys: jwks }, publicKeys: new Map(jwks.map((j) => [j.kid, createPublicKey({ key: j, format: 'jwk' })])) };
}
