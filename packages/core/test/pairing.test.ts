import { describe, expect, it } from 'vitest';
import {
  PAIRING_ALPHABET,
  digestsEqual,
  formatPairingCode,
  generatePairingCode,
  isPlausiblePairingCode,
  normalisePairingCode,
  pairingKey,
  pairingMac,
  shortFingerprint,
} from '../src/domain/pairing.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('pairing codes', () => {
  it('8 characters from a 32-symbol alphabet with no 0/O or 1/I lookalikes', () => {
    expect(PAIRING_ALPHABET).toHaveLength(32);
    expect(PAIRING_ALPHABET).not.toMatch(/[01OI]/);
    for (let i = 0; i < 50; i++) expect(generatePairingCode()).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
  });

  it('as typed: case, spaces and dashes do not matter; only plausible codes pass', () => {
    expect(normalisePairingCode('abcd-efgh ')).toBe('ABCDEFGH');
    expect(formatPairingCode('ABCDEFGH')).toBe('ABCD-EFGH');
    expect(isPlausiblePairingCode('abcd efgh')).toBe(true);
    expect(isPlausiblePairingCode('ABCD-EFG')).toBe(false);
    expect(isPlausiblePairingCode('ABCD-EFG0')).toBe(false);
  });

  it('short fingerprints group the first 16 hex digits', () => {
    expect(shortFingerprint('ab12cd34ef567890ffff')).toBe('AB12 CD34 EF56 7890');
  });
});

describe('pairing key and MACs', () => {
  it('both sides derive the same key from the code and the two fingerprints, in either order', async () => {
    const one = await pairingKey('abcd-efgh', A, B);
    const two = await pairingKey('ABCDEFGH', B, A);
    expect(one.equals(two)).toBe(true);
    expect(one).toHaveLength(32);
  });

  it('a different code or a different certificate on either side gives a different key, so the MAC fails', async () => {
    const key = await pairingKey('ABCDEFGH', A, B);
    const mac = pairingMac(key, A, B);
    expect(digestsEqual(mac, pairingMac(await pairingKey('ABCDEFGJ', A, B), A, B))).toBe(false);
    expect(digestsEqual(mac, pairingMac(await pairingKey('ABCDEFGH', A, 'c'.repeat(64)), A, B))).toBe(false);
    expect(digestsEqual(mac, pairingMac(key, B, A))).toBe(false);
    expect(digestsEqual(mac, pairingMac(key, A, B))).toBe(true);
  });

  it('compares digests in constant time, and never equal when empty or of different lengths', () => {
    expect(digestsEqual('', '')).toBe(false);
    expect(digestsEqual('abcd', 'abcdef')).toBe(false);
  });
});
