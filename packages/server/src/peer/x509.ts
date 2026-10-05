import { randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * A minimal DER encoder for the one certificate shape a node needs: a
 * self-signed ECDSA P-256 certificate whose fingerprint is the node's
 * identity (v2 spec §3). Nothing checks it against a CA -- peers pin its
 * SHA-256 -- so it carries a common name, a validity window and
 * basicConstraints CA:FALSE, and nothing else. Hand-written (rather than a
 * certificate library) because Node can parse and sign but not build
 * certificates, and this shape is small enough to encode and test directly.
 */

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a! + b!];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A non-negative INTEGER from big-endian bytes (a leading zero is added when the top bit is set). */
function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b = b.subarray(1);
  return tlv(0x02, (b[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

/** UTCTime before 2050, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const ECDSA_WITH_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));

function name(commonName: string): Buffer {
  return sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
}

export interface SelfSignedOptions {
  commonName: string;
  notBefore: Date;
  notAfter: Date;
}

/** A self-signed X.509 v3 certificate for an EC P-256 key pair, DER-encoded. */
export function selfSignedCertificate(publicKey: KeyObject, privateKey: KeyObject, options: SelfSignedOptions): Buffer {
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  const basicConstraints = sequence(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, sequence()));
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ECDSA_WITH_SHA256,
    name(options.commonName),
    sequence(time(options.notBefore), time(options.notAfter)),
    name(options.commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, sequence(basicConstraints))
  );
  // Node signs an EC key as a DER ECDSA-Sig-Value, which is what X.509 expects.
  const signature = sign('sha256', tbs, privateKey);
  return sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

/** PEM armour for a DER certificate. */
export function certificatePem(der: Buffer): string {
  const body = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}
