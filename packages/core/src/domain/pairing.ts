import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Pairing two machines with a one-time code (v2 spec §3). Pure helpers: the
 * code, the MACs that bind it to both certificates, fingerprints and tokens.
 * The exchange itself lives in the server (peer/pairing.ts).
 */

/** The peer protocol's version, compared in `GET /peer/info` before syncing. */
export const PEER_PROTOCOL_VERSION = 2;

/** 32 symbols with no lookalikes: no 0/O, 1/I. */
export const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/** Wrong codes allowed before the session is cancelled. */
export const PAIRING_MAX_FAILURES = 5;

/** A fresh code, uniformly random over the alphabet. */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code;
}

/** A code as typed: case, spaces and dashes don't matter. */
export function normalisePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** `ABCD-EFGH`, for reading out. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Whether `input` could be a code at all, before any MAC is computed. */
export function isPlausiblePairingCode(input: string): boolean {
  const code = normalisePairingCode(input);
  return code.length === PAIRING_CODE_LENGTH && [...code].every((c) => PAIRING_ALPHABET.includes(c));
}

/**
 * scrypt cost for the pairing key: ~16 MiB and tens of milliseconds per
 * guess, once per side per pairing. A plain HMAC of an 8-character code is
 * only 2^40 guesses, which a GPU gets through within the code's 10 minutes
 * if someone in the middle captures a MAC; scrypt puts that out of reach.
 */
const PAIRING_SCRYPT = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * The key a pairing's MACs are made with: scrypt of the code, salted with
 * both certificate fingerprints (in a fixed order, so both sides derive the
 * same key from the same pair). A different fingerprint on either side
 * gives a different key.
 */
export function pairingKey(code: string, fpA: string, fpB: string): Promise<Buffer> {
  const salt = `otherbench-pairing|${[fpA, fpB].sort().join('|')}`;
  return new Promise((resolve, reject) => {
    scrypt(normalisePairingCode(code), salt, 32, PAIRING_SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * `HMAC-SHA256(key, firstFp ‖ secondFp)` as hex, `key` from `pairingKey`. The
 * initiator sends `pairingMac(key, ownFp, responderFpAsSeen)`; the responder
 * answers with `pairingMac(key, ownFp, initiatorFp)`. A machine in the middle
 * with its own certificate changes a fingerprint one side sees, so a MAC fails.
 */
export function pairingMac(key: Buffer, firstFp: string, secondFp: string): string {
  return createHmac('sha256', key).update(`${firstFp}|${secondFp}`).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** A certificate's identity: SHA-256 of its DER encoding, lowercase hex. */
export function fingerprintOf(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

/** The first 16 hex digits in groups of four, for comparing by eye: `ab12 cd34 ef56 7890`. */
export function shortFingerprint(fp: string): string {
  return (fp.slice(0, 16).match(/.{1,4}/g) ?? []).join(' ').toUpperCase();
}

/** A random 256-bit bearer token. */
export function generatePeerToken(): string {
  return randomBytes(32).toString('base64url');
}

/** How an issued token is stored: SHA-256, hex. */
export function hashPeerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
