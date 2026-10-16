import { createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintOf } from '@otherbench/core/domain/pairing.js';
import { IdentityStore } from '../../src/peer/identity.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('node identity', () => {
  it('a valid self-signed P-256 certificate whose fingerprint is the SHA-256 of its DER, valid for decades', () => {
    const identity = new IdentityStore(() => 'node-a', null).get();
    const cert = new X509Certificate(identity.certPem);

    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.checkPrivateKey(createPrivateKey(identity.keyPem))).toBe(true);
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(cert.subject).toBe('CN=otherbench-node-a');
    expect(cert.ca).toBe(false);
    expect(identity.fingerprint).toBe(fingerprintOf(cert.raw));
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now());
    expect(new Date(cert.validTo).getUTCFullYear()).toBeGreaterThan(new Date().getUTCFullYear() + 25);
  });

  it('is created once per machine and reused from disk; nothing is written until it is first needed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'otherbench-identity-'));
    dirs.push(dir);
    const store = new IdentityStore(() => 'node-a', dir);
    expect(readdirSync(dir)).toEqual([]);

    const first = store.get();
    expect(readdirSync(dir).sort()).toEqual(['node-node-a.crt', 'node-node-a.key']);
    expect(new IdentityStore(() => 'node-a', dir).get().fingerprint).toBe(first.fingerprint);
    expect(new IdentityStore(() => 'node-b', dir).get().fingerprint).not.toBe(first.fingerprint);
  });

  it('works for mutual TLS: each side sees the other certificate it pins', async () => {
    const server = new IdentityStore(() => 'server', null).get();
    const client = new IdentityStore(() => 'client', null).get();
    const seenByServer = new Promise<string>((resolve) => {
      const tls = createServer({ key: server.keyPem, cert: server.certPem, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, (socket) => {
        resolve(fingerprintOf(socket.getPeerCertificate().raw));
        socket.end();
      });
      tls.listen(0, '127.0.0.1', () => {
        const port = (tls.address() as { port: number }).port;
        const socket: TLSSocket = connect({ host: '127.0.0.1', port, key: client.keyPem, cert: client.certPem, rejectUnauthorized: false }, () => {
          seenByClient = fingerprintOf(socket.getPeerCertificate().raw);
          socket.on('close', () => tls.close());
        });
        socket.on('data', () => {});
      });
    });
    let seenByClient = '';

    expect(await seenByServer).toBe(client.fingerprint);
    await expect.poll(() => seenByClient).toBe(server.fingerprint);
  });
});
