import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPayload, generateVapidKeys, MAX_PLAINTEXT, pushKeysProblem, vapidAuthorization, vapidKeysValid } from '../../src/push/web-push.js';
import { decryptAes128gcm, fakeBrowser } from './helpers.js';

const u = (s: string): Buffer => Buffer.from(s, 'base64url');

// RFC 8291 Appendix A (and the message in its section 5).
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('encryptPayload (RFC 8291)', () => {
  it("matches RFC 8291's worked example byte for byte", () => {
    const body = encryptPayload(u(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.authSecret }, { salt: u(RFC.salt), serverPrivateKey: u(RFC.asPrivate) });
    expect(body.toString('base64url')).toBe(RFC.message);
    // The header: salt, record size 4096, the server's 65-byte public key.
    expect(body.subarray(16, 20).readUInt32BE()).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body.subarray(21, 86).toString('base64url')).toBe(RFC.asPublic);
  });

  it('decrypts with the browser keys back to the plaintext, and with fresh keys and salt each time', () => {
    expect(decryptAes128gcm(u(RFC.message), u(RFC.uaPrivate), u(RFC.authSecret))).toBe(u(RFC.plaintext).toString('utf8'));
    const browser = fakeBrowser();
    const a = encryptPayload(Buffer.from('{"title":"t"}'), browser);
    const b = encryptPayload(Buffer.from('{"title":"t"}'), browser);
    expect(a.equals(b)).toBe(false);
    expect(browser.decrypt(a)).toBe('{"title":"t"}');
    expect(browser.decrypt(b)).toBe('{"title":"t"}');
  });

  it('refuses a payload that would not fit in one 4096-byte push', () => {
    const browser = fakeBrowser();
    expect(encryptPayload(Buffer.alloc(MAX_PLAINTEXT, 0x61), browser).length).toBe(4096);
    expect(() => encryptPayload(Buffer.alloc(MAX_PLAINTEXT + 1, 0x61), browser)).toThrow(/at most/);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('makes a valid P-256 pair, and spots one that is not', () => {
    const keys = generateVapidKeys();
    expect(u(keys.publicKey)).toHaveLength(65);
    expect(u(keys.privateKey)).toHaveLength(32);
    expect(vapidKeysValid(keys)).toBe(true);
    expect(vapidKeysValid({ ...keys, publicKey: generateVapidKeys().publicKey })).toBe(false);
    expect(vapidKeysValid({ ...keys, privateKey: 'short' })).toBe(false);
  });

  it('signs an ES256 JWT for the endpoint origin that the public key verifies', () => {
    const keys = generateVapidKeys();
    const now = 1_800_000_000_000;
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', keys, 'https://otherbench.test:4747', now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(u(h!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(u(c!).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://otherbench.test:4747' });
    const pub = u(keys.publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(u(sig!)).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, u(sig!))).toBe(true);
    expect(verify('sha256', Buffer.from(`${h}.${c}x`), { key, dsaEncoding: 'ieee-p1363' }, u(sig!))).toBe(false);
  });
});

describe('pushKeysProblem', () => {
  it("takes a browser's keys and refuses anything else", () => {
    expect(pushKeysProblem({ p256dh: RFC.uaPublic, auth: RFC.authSecret })).toBeNull();
    expect(pushKeysProblem({ p256dh: RFC.uaPublic, auth: 'AAAA' })).toMatch(/16 bytes/);
    expect(pushKeysProblem({ p256dh: 'BAAA', auth: RFC.authSecret })).toMatch(/P-256/);
    // 65 bytes starting 0x04, but not a point on the curve.
    expect(pushKeysProblem({ p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: RFC.authSecret })).toMatch(/P-256/);
  });
});
