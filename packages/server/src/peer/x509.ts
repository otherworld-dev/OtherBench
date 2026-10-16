import { createHash, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * A minimal DER encoder for the certificates OtherBench makes itself: the node's
 * self-signed identity on the peer listener (v2 spec §3), whose SHA-256 is
 * what peers pin, and, for `otherbench serve --tls auto` (spec
 * 2026-10-12-remote-access §4), a one-off local CA and the server
 * certificate it signs. Hand-written (rather than a certificate library)
 * because Node can parse and sign but not build certificates, and these
 * shapes are small enough to encode and test directly.
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
const TRUE = tlv(0x01, Buffer.from([0xff]));

function name(commonName: string): Buffer {
  return sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
}

/** One X.509 v3 extension: its OID, whether it's critical, and its DER value. */
export function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [TRUE] : []), tlv(0x04, value));
}

/** basicConstraints, always critical: `CA:FALSE` (an empty SEQUENCE), or `CA:TRUE` with an optional path length. */
export function basicConstraints(ca: boolean, pathLen?: number): Buffer {
  const value = ca ? sequence(TRUE, ...(pathLen === undefined ? [] : [integer(Buffer.from([pathLen]))])) : sequence();
  return extension('2.5.29.19', true, value);
}

/**
 * keyUsage, critical. A BIT STRING: the count of unused bits, then the bits.
 * digitalSignature is bit 0 (`03 02 07 80`); keyCertSign and cRLSign are bits
 * 5 and 6 (`03 02 01 06`).
 */
export function keyUsage(usage: 'digitalSignature' | 'certSign'): Buffer {
  return extension('2.5.29.15', true, tlv(0x03, Buffer.from(usage === 'digitalSignature' ? [0x07, 0x80] : [0x01, 0x06])));
}

/** extKeyUsage serverAuth (1.3.6.1.5.5.7.3.1): iOS and Chrome want it on a server certificate. */
export function extKeyUsageServerAuth(): Buffer {
  return extension('2.5.29.37', false, sequence(oid('1.3.6.1.5.5.7.3.1')));
}

/** An IP address as a SAN wants it: 4 bytes for IPv4, 16 for IPv6 (an embedded IPv4 tail included). */
export function ipBytes(ip: string): Buffer {
  if (isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  if (!isIPv6(ip)) throw new Error(`"${ip}" is not an IP address.`);
  let text = ip.replace(/%.*$/, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, -v4[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined ? left : [...left, ...new Array<string>(8 - left.length - right.length).fill('0'), ...right];
  const out = Buffer.alloc(16);
  groups.forEach((group, i) => out.writeUInt16BE(parseInt(group, 16), i * 2));
  return out;
}

/** subjectAltName: `[2]` dNSName (IA5String) and `[7]` iPAddress (4 or 16 bytes). Browsers ignore the CN. */
export function subjectAltName(names: { dns: string[]; ips: string[] }): Buffer {
  return extension(
    '2.5.29.17',
    false,
    sequence(...names.dns.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))), ...names.ips.map((ip) => tlv(0x87, ipBytes(ip))))
  );
}

/** The key identifier RFC 5280 §4.2.1.2 (1) describes: SHA-1 of the public key's bits (for P-256, the uncompressed point). */
export function keyIdOf(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('keyIdOf needs an EC public key.');
  const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return createHash('sha1').update(point).digest();
}

export function subjectKeyId(id: Buffer): Buffer {
  return extension('2.5.29.14', false, tlv(0x04, id));
}

/** authorityKeyIdentifier with only `[0] keyIdentifier`: the issuing CA's subject key id. */
export function authorityKeyId(id: Buffer): Buffer {
  return extension('2.5.29.35', false, sequence(tlv(0x80, id)));
}

export interface CertificateOptions {
  subjectCn: string;
  /** Must be the issuer's own subject CN, byte for byte, for a chain to build. */
  issuerCn: string;
  /** The certificate's own (EC P-256) public key. */
  publicKey: KeyObject;
  /** The issuer's private key; the certificate's own for a self-signed one. */
  signingKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: Buffer[];
}

/** An X.509 v3 certificate, DER-encoded, signed ECDSA-SHA256. */
export function certificate(o: CertificateOptions): Buffer {
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ECDSA_WITH_SHA256,
    name(o.issuerCn),
    sequence(time(o.notBefore), time(o.notAfter)),
    name(o.subjectCn),
    o.publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, sequence(...o.extensions))
  );
  // Node signs an EC key as a DER ECDSA-Sig-Value, which is what X.509 expects.
  const signature = sign('sha256', tbs, o.signingKey);
  return sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

export interface SelfSignedOptions {
  commonName: string;
  notBefore: Date;
  notAfter: Date;
}

/**
 * The node identity: self-signed, with basicConstraints CA:FALSE and nothing
 * else. Its shape must not change: its fingerprint is what paired machines pin.
 */
export function selfSignedCertificate(publicKey: KeyObject, privateKey: KeyObject, options: SelfSignedOptions): Buffer {
  return certificate({
    subjectCn: options.commonName,
    issuerCn: options.commonName,
    publicKey,
    signingKey: privateKey,
    notBefore: options.notBefore,
    notAfter: options.notAfter,
    extensions: [basicConstraints(false)],
  });
}

/** PEM armour for a DER certificate. */
export function certificatePem(der: Buffer): string {
  const body = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}
