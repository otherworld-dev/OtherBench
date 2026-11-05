import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

/**
 * Web Push with Node's own crypto, no dependency: VAPID (RFC 8292) signs a
 * short ES256 JWT naming the push service's origin, and the payload is
 * encrypted to the browser's keys as RFC 8291 says, in RFC 8188's aes128gcm
 * content coding (one record). `web-push.test.ts` checks the encryption
 * against RFC 8291's Appendix A and the JWT by verifying its signature.
 */

/** This server's VAPID key pair, base64url: `publicKey` is the 65-byte uncompressed P-256 point, `privateKey` the 32-byte scalar. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** What a browser's `PushSubscription.toJSON().keys` holds, base64url. */
export interface PushKeys {
  p256dh: string;
  auth: string;
}

const b64u = (buf: Uint8Array): string => Buffer.from(buf).toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(padScalar(ecdh.getPrivateKey())) };
}

/** OpenSSL drops leading zero bytes of a scalar; the JWK and the key file want all 32. */
function padScalar(d: Buffer): Buffer {
  return d.length >= 32 ? d : Buffer.concat([Buffer.alloc(32 - d.length), d]);
}

/** Whether `keys` are a usable pair: a 32-byte scalar whose public point is `publicKey`. */
export function vapidKeysValid(keys: VapidKeys): boolean {
  try {
    const d = unb64u(keys.privateKey);
    if (d.length !== 32) return false;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    return ecdh.getPublicKey().equals(unb64u(keys.publicKey));
  } catch {
    return false;
  }
}

/** A browser's p256dh and auth as Web Push wants them: a 65-byte uncompressed P-256 point and a 16-byte secret. Null if not. */
export function pushKeysProblem(keys: PushKeys): string | null {
  const pub = unb64u(keys.p256dh);
  if (pub.length !== 65 || pub[0] !== 0x04) return 'The subscription key is not a P-256 public key.';
  if (unb64u(keys.auth).length !== 16) return 'The subscription auth secret is not 16 bytes.';
  try {
    // Throws if the point isn't on the curve.
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pub);
  } catch {
    return 'The subscription key is not a P-256 public key.';
  }
  return null;
}

/**
 * The `Authorization` header for a push to `endpoint` (RFC 8292 §3):
 * `vapid t=<JWT>, k=<public key>`. The JWT's `aud` is the endpoint's origin,
 * `exp` 12 hours on (the most push services take is 24), `sub` a contact
 * for the push service (this server's https address).
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs: number): string {
  const pub = unb64u(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 60 * 60, sub: subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** Record size written in the header; one record carries the whole payload, so it only has to exceed it. */
const RECORD_SIZE = 4096;
/** The most plaintext one push can carry: 4096 bytes on the wire, less the header (86), the delimiter and the tag. */
export const MAX_PLAINTEXT = RECORD_SIZE - 86 - 1 - 16;

/**
 * `plaintext` encrypted to the browser's keys (RFC 8291 §3.4), as the
 * aes128gcm body (RFC 8188 §2): salt, record size, the server's ephemeral
 * public key, then one record (the plaintext, the 0x02 last-record delimiter,
 * the GCM tag). `salt` and `serverPrivateKey` are for the RFC's test vector
 * only; normally both are fresh for every message.
 */
export function encryptPayload(plaintext: Uint8Array, keys: PushKeys, opts: { salt?: Uint8Array; serverPrivateKey?: Uint8Array } = {}): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`a push payload can be at most ${MAX_PLAINTEXT} bytes`);
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  const salt = Buffer.from(opts.salt ?? randomBytes(16));
  const ecdh = createECDH('prime256v1');
  if (opts.serverPrivateKey) ecdh.setPrivateKey(Buffer.from(opts.serverPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  // RFC 8188: CEK and NONCE from HKDF(salt, IKM, ...)
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, record]);
}
