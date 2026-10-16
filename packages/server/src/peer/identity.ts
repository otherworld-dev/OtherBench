import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintOf } from '@otherbench/core/domain/pairing.js';
import { certificatePem, selfSignedCertificate } from './x509.js';

/** This node's TLS identity on the peer listener (v2 spec §3). */
export interface NodeIdentity {
  certPem: string;
  keyPem: string;
  /** SHA-256 of the certificate's DER, lowercase hex: what peers pin. */
  fingerprint: string;
}

/** Long-lived: the fingerprint is the node's identity, and a new one means pairing again. */
const VALID_YEARS = 30;

function generate(nodeId: string): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const now = new Date();
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(now.getUTCFullYear() + VALID_YEARS);
  const der = selfSignedCertificate(publicKey, privateKey, {
    commonName: `otherbench-${nodeId}`,
    // A day early, so a peer whose clock runs behind doesn't see it as not yet valid.
    notBefore: new Date(now.getTime() - 86_400_000),
    notAfter,
  });
  return {
    certPem: certificatePem(der),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fingerprint: fingerprintOf(der),
  };
}

/**
 * This node's identity, created on first use: the peer listener and pairing
 * need it, nothing else does, so a server that never pairs never writes one.
 * With `dir` set it's kept there as `node-<id>.crt` and `node-<id>.key`
 * (beside the secrets file; the key mode 0600 on POSIX, a no-op on Windows
 * as for the secrets key) and reused across restarts. Without `dir` (an
 * in-memory database) it lives only as long as the process.
 */
export class IdentityStore {
  private identity: NodeIdentity | null = null;

  constructor(
    private readonly nodeId: () => string,
    private readonly dir: string | null
  ) {}

  get(): NodeIdentity {
    if (this.identity) return this.identity;
    const id = this.nodeId();
    if (this.dir === null) {
      this.identity = generate(id);
      return this.identity;
    }
    const certPath = join(this.dir, `node-${id}.crt`);
    const keyPath = join(this.dir, `node-${id}.key`);
    if (existsSync(certPath) && existsSync(keyPath)) {
      const certPem = readFileSync(certPath, 'utf8');
      const keyPem = readFileSync(keyPath, 'utf8');
      const cert = new X509Certificate(certPem);
      // A key that doesn't match its certificate would fail every handshake; refuse it here, by name.
      if (!cert.checkPrivateKey(createPrivateKey(keyPem))) throw new Error(`${keyPath} does not match ${certPath}.`);
      this.identity = { certPem, keyPem, fingerprint: fingerprintOf(cert.raw) };
      return this.identity;
    }
    const fresh = generate(id);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(keyPath, fresh.keyPem, { mode: 0o600 });
    writeFileSync(certPath, fresh.certPem);
    this.identity = fresh;
    return fresh;
  }
}

/** The SHA-256 fingerprint of a PEM certificate. */
export function pemFingerprint(certPem: string): string {
  return fingerprintOf(new X509Certificate(certPem).raw);
}

