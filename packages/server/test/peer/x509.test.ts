import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { connect, createServer, type Server } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorityKeyId,
  basicConstraints,
  certificate,
  certificatePem,
  extKeyUsageServerAuth,
  ipBytes,
  keyIdOf,
  keyUsage,
  selfSignedCertificate,
  subjectAltName,
  subjectKeyId,
} from '../../src/peer/x509.js';

const DAY = 86_400_000;
const CA_CN = 'OtherBench local CA test 2026-10-12';

/** A CA and a server certificate it signed, the way `--tls auto` makes them. */
function chain(names: { dns: string[]; ips: string[] }, days = 800) {
  const now = Date.now();
  const notBefore = new Date(now - DAY);
  const notAfter = new Date(now + days * DAY);
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caId = keyIdOf(ca.publicKey);
  const caDer = certificate({
    subjectCn: CA_CN,
    issuerCn: CA_CN,
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
    notBefore,
    notAfter,
    extensions: [basicConstraints(true, 0), keyUsage('certSign'), subjectKeyId(caId)],
  });
  const server = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const certDer = certificate({
    subjectCn: names.dns[0] ?? names.ips[0] ?? 'otherbench',
    issuerCn: CA_CN,
    publicKey: server.publicKey,
    signingKey: ca.privateKey,
    notBefore,
    notAfter,
    extensions: [basicConstraints(false), keyUsage('digitalSignature'), extKeyUsageServerAuth(), subjectAltName(names), subjectKeyId(keyIdOf(server.publicKey)), authorityKeyId(caId)],
  });
  return {
    ca: new X509Certificate(caDer),
    cert: new X509Certificate(certDer),
    caPem: certificatePem(caDer),
    certPem: certificatePem(certDer),
    keyPem: server.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(keyPem: string, certPem: string): Promise<number> {
  const server = createServer({ key: keyPem, cert: certPem, minVersion: 'TLSv1.2' }, (socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

/** 'ok' when the handshake verifies against `caPem`, else the error's code. */
function handshake(port: number, caPem: string, servername?: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, ca: caPem, rejectUnauthorized: true, ...(servername ? { servername } : {}) }, () => {
      resolve('ok');
      socket.destroy();
    });
    socket.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
  });
}

describe('certificate builders', () => {
  it('make a CA and a server certificate that Node reads the way browsers need', () => {
    const { ca, cert } = chain({ dns: ['otherbench.test'], ips: ['127.0.0.1', '::1'] });

    expect(ca.ca).toBe(true);
    expect(cert.ca).toBe(false);
    expect(cert.issuer).toBe(`CN=${CA_CN}`);
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.checkHost('otherbench.test')).toBe('otherbench.test');
    expect(cert.checkHost('other.test')).toBeUndefined();
    expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(cert.checkIP('::1')).toBe('::1');
    expect(cert.checkIP('10.0.0.1')).toBeUndefined();
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    expect((cert.validToDate.getTime() - cert.validFromDate.getTime()) / DAY).toBeLessThanOrEqual(825);
  });

  it('encode the key usage bits the spec gives', () => {
    expect(keyUsage('digitalSignature').subarray(-4)).toEqual(Buffer.from([0x03, 0x02, 0x07, 0x80]));
    expect(keyUsage('certSign').subarray(-4)).toEqual(Buffer.from([0x03, 0x02, 0x01, 0x06]));
  });

  it('turn IPv4 and IPv6 addresses into SAN bytes', () => {
    expect(ipBytes('192.168.1.5')).toEqual(Buffer.from([192, 168, 1, 5]));
    expect(ipBytes('::1').toString('hex')).toBe('00000000000000000000000000000001');
    expect(ipBytes('fd00::5:6').toString('hex')).toBe('fd000000000000000000000000050006');
    expect(ipBytes('::ffff:10.0.0.1').toString('hex')).toBe('00000000000000000000ffff0a000001');
    expect(() => ipBytes('otherbench.lan')).toThrow(/not an IP address/);
  });

  it('still make the node identity with basicConstraints and nothing else', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = selfSignedCertificate(publicKey, privateKey, { commonName: 'otherbench-n', notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY) });
    const cert = new X509Certificate(der);

    expect(cert.subject).toBe('CN=otherbench-n');
    expect(cert.issuer).toBe('CN=otherbench-n');
    expect(cert.ca).toBe(false);
    expect(cert.subjectAltName).toBeUndefined();
    expect(cert.keyUsage ?? []).toEqual([]);
    expect(cert.verify(cert.publicKey)).toBe(true);
  });
});

describe('a TLS handshake that trusts only the CA', () => {
  it('passes for a SAN DNS name and a SAN IP, and fails for a name not in the SANs', async () => {
    const { caPem, certPem, keyPem } = chain({ dns: ['otherbench.test'], ips: ['127.0.0.1'] });
    const port = await listen(keyPem, certPem);

    expect(await handshake(port, caPem, 'otherbench.test')).toBe('ok');
    expect(await handshake(port, caPem)).toBe('ok');
    expect(await handshake(port, caPem, 'other.test')).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('fails against a different CA', async () => {
    const { certPem, keyPem } = chain({ dns: ['otherbench.test'], ips: [] });
    const other = chain({ dns: ['otherbench.test'], ips: [] });
    const port = await listen(keyPem, certPem);

    expect(await handshake(port, other.caPem, 'otherbench.test')).not.toBe('ok');
  });
});
