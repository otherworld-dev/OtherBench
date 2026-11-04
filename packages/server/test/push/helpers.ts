import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';

/** A browser's side of Web Push, for tests: its keys, and decrypting what the server sent it (RFC 8291 / RFC 8188). */
export interface FakeBrowser {
  p256dh: string;
  auth: string;
  decrypt(body: Buffer): string;
}

export function fakeBrowser(): FakeBrowser {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, 7);
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
    decrypt: (body) => decryptAes128gcm(body, ecdh.getPrivateKey(), auth),
  };
}

/** Decrypts an aes128gcm push body for the user agent holding `uaPrivate` and `authSecret`. */
export function decryptAes128gcm(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // Strip the padding and the last-record delimiter (0x02).
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 0x02) throw new Error('missing the last-record delimiter');
  return plain.subarray(0, end).toString('utf8');
}
