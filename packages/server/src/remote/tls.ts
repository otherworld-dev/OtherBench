import { createPrivateKey, generateKeyPairSync, X509Certificate, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import {
  authorityKeyId,
  basicConstraints,
  certificate,
  certificatePem,
  extKeyUsageServerAuth,
  ipBytes,
  keyIdOf,
  keyUsage,
  subjectAltName,
  subjectKeyId,
} from '../peer/x509.js';
import { TlsFilesError } from './errors.js';

/** Apple's limit for certificates under a user-trusted root is 825 days. */
export const AUTO_CERT_DAYS = 800;
export const RENEW_WITHIN_MS = 30 * 86_400_000;
const DAY_MS = 86_400_000;

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** When a certificate needs a warning in the log: inside its last 30 days, or expired. */
export function expiryWarning(notAfter: number, now: number, what = "OtherBench's HTTPS certificate"): string | null {
  if (notAfter <= now) return `Warning: ${what} expired on ${day(notAfter)}. Browsers will refuse it.`;
  if (notAfter - now <= RENEW_WITHIN_MS) return `Warning: ${what} expires on ${day(notAfter)} (in ${Math.ceil((notAfter - now) / DAY_MS)} days).`;
  return null;
}

/** A SAN as a set member: an IP by its bytes (OpenSSL prints IPv6 expanded), a DNS name in lower case. */
const nameKey = (name: string): string => (isIP(name) ? `ip:${ipBytes(name).toString('hex')}` : `dns:${name.toLowerCase()}`);

function sanNames(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? '')
    .split(', ')
    .flatMap((entry) => (entry.startsWith('DNS:') ? [entry.slice(4)] : entry.startsWith('IP Address:') ? [entry.slice(11)] : []));
}

function sameNames(a: string[], b: string[]): boolean {
  const x = new Set(a.map(nameKey));
  const y = new Set(b.map(nameKey));
  return x.size === y.size && [...x].every((k) => y.has(k));
}

export interface AutoTls {
  keyPem: string;
  certPem: string;
  caDer: Buffer;
  /** SHA-256 of the CA, colon-separated hex, as `otherbench serve` prints it and a phone shows it. */
  caFingerprint: string;
  notAfter: number;
  names: string[];
  /** True when a new CA was made this start: every device must trust it again. */
  created: boolean;
}

function reuse(dir: string, names: string[], now: number): AutoTls | null {
  const caPath = join(dir, 'otherbench-ca.crt');
  const certPath = join(dir, 'server.crt');
  const keyPath = join(dir, 'server.key');
  // Reading is the only step whose failure says nothing about the files'
  // content (an antivirus scan holding one at boot, a permissions slip).
  // Remaking the CA on such an error can't be undone: every device would have
  // to trust it again. So only a missing file means "make new ones"; any
  // other read error refuses to start and leaves the files as they are.
  const text = new Map<string, string>();
  let missing = false;
  for (const p of [caPath, certPath, keyPath]) {
    try {
      text.set(p, readFileSync(p, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        missing = true;
        continue;
      }
      throw new TlsFilesError(`Refusing to start: couldn't read ${p}: ${(err as Error).message}. OtherBench's certificate files were left as they are.`);
    }
  }
  if (missing) return null;
  try {
    const keyPem = text.get(keyPath) as string;
    const certPem = text.get(certPath) as string;
    const ca = new X509Certificate(text.get(caPath) as string);
    const cert = new X509Certificate(certPem);
    if (!cert.checkPrivateKey(createPrivateKey(keyPem))) return null;
    if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) return null;
    if (!sameNames(sanNames(cert), names)) return null;
    const notAfter = cert.validToDate.getTime();
    if (notAfter - now <= RENEW_WITHIN_MS) return null;
    return { keyPem, certPem, caDer: Buffer.from(ca.raw), caFingerprint: ca.fingerprint256, notAfter, names: [...names], created: false };
  } catch {
    return null;
  }
}

/**
 * `--tls auto` (spec §4): `<dir>/otherbench-ca.crt`, `server.crt` and `server.key`.
 * Reused when they match each other, name exactly `names` and have more
 * than 30 days left; otherwise a new CA and certificate are made. A file
 * that can't be read for any reason but being absent stops the start with a
 * `TlsFilesError` instead, so a transient error never remakes the CA. The CA's
 * private key is never written and is dropped once the certificate is
 * signed, so a copy of this disk can't mint certificates that devices
 * trusting the CA would accept. Not the node certificate: that one has no
 * SAN, lasts 30 years and is the peer identity.
 */
export function loadOrCreateAutoTls(opts: { dir: string; names: string[]; nodeName: string; now?: () => number }): AutoTls {
  const now = (opts.now ?? Date.now)();
  const existing = reuse(opts.dir, opts.names, now);
  if (existing) return existing;

  const notBefore = new Date(now - DAY_MS);
  const notAfter = new Date(now + AUTO_CERT_DAYS * DAY_MS);
  const caCn = `OtherBench local CA ${opts.nodeName} ${day(now)}`;
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caId = keyIdOf(ca.publicKey);
  const caDer = certificate({
    subjectCn: caCn,
    issuerCn: caCn,
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
    notBefore,
    notAfter,
    extensions: [basicConstraints(true, 0), keyUsage('certSign'), subjectKeyId(caId)],
  });
  const server = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const certDer = signServer(ca.privateKey, caId, caCn, server.publicKey, opts.names, notBefore, notAfter);
  // ca.privateKey is never exported or written; it goes when this function returns.

  const keyPem = server.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const certPem = certificatePem(certDer);
  mkdirSync(opts.dir, { recursive: true });
  const keyPath = join(opts.dir, 'server.key');
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // A no-op on Windows, as for the secrets key.
  }
  writeFileSync(join(opts.dir, 'server.crt'), certPem);
  writeFileSync(join(opts.dir, 'otherbench-ca.crt'), certificatePem(caDer));
  const caCert = new X509Certificate(caDer);
  return {
    keyPem,
    certPem,
    caDer,
    caFingerprint: caCert.fingerprint256,
    notAfter: new X509Certificate(certDer).validToDate.getTime(),
    names: [...opts.names],
    created: true,
  };
}

function signServer(caKey: KeyObject, caId: Buffer, caCn: string, publicKey: KeyObject, names: string[], notBefore: Date, notAfter: Date): Buffer {
  return certificate({
    subjectCn: names[0] ?? 'otherbench',
    issuerCn: caCn,
    publicKey,
    signingKey: caKey,
    notBefore,
    notAfter,
    extensions: [
      basicConstraints(false),
      keyUsage('digitalSignature'),
      extKeyUsageServerAuth(),
      subjectAltName({ dns: names.filter((n) => !isIP(n)), ips: names.filter((n) => isIP(n)) }),
      subjectKeyId(keyIdOf(publicKey)),
      authorityKeyId(caId),
    ],
  });
}

export interface FileTls {
  keyPem: string;
  /** The whole file: the certificate, then any chain, passed to TLS as is. */
  certPem: string;
  notAfter: number;
  warning: string | null;
}

/**
 * `--tls-cert` and `--tls-key` (spec §4): checks the key against the first
 * certificate in the file and that it covers every public host; warns when
 * it expires within 30 days. Read at start; `TlsFileWatcher` picks up a
 * renewed pair while the server runs.
 */
export function loadTlsFiles(certPath: string, keyPath: string, hosts: string[], now: () => number = Date.now): FileTls {
  const read = (path: string, what: string): string => {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      throw new TlsFilesError(`Refusing to start: couldn't read ${what} ${path}: ${(err as Error).message}`);
    }
  };
  const certPem = read(certPath, '--tls-cert');
  const keyPem = read(keyPath, '--tls-key');
  const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(certPem)?.[0];
  if (!first) throw new TlsFilesError(`Refusing to start: ${certPath} has no PEM certificate in it.`);
  let cert: X509Certificate;
  let key: KeyObject;
  try {
    cert = new X509Certificate(first);
  } catch (err) {
    throw new TlsFilesError(`Refusing to start: couldn't parse the certificate in ${certPath}: ${(err as Error).message}`);
  }
  try {
    key = createPrivateKey(keyPem);
  } catch (err) {
    throw new TlsFilesError(`Refusing to start: couldn't parse the private key in ${keyPath}: ${(err as Error).message}`);
  }
  if (!cert.checkPrivateKey(key)) throw new TlsFilesError(`Refusing to start: ${keyPath} is not the key for the certificate in ${certPath}.`);
  for (const host of hosts) {
    const covered = isIP(host) ? cert.checkIP(host) : cert.checkHost(host);
    if (covered === undefined) throw new TlsFilesError(`Refusing to start: the certificate in ${certPath} doesn't cover ${host}. It must name every --public-url host.`);
  }
  const notAfter = cert.validToDate.getTime();
  return { keyPem, certPem, notAfter, warning: expiryWarning(notAfter, now(), `The certificate in ${certPath}`) };
}

/** How often `--tls-cert` and `--tls-key` are looked at for a renewed pair. */
export const TLS_RELOAD_MS = 60_000;

export interface TlsFileWatcherOptions {
  certPath: string;
  keyPath: string;
  /** The public hostnames the certificate must cover, as at start. */
  hosts: string[];
  /** Puts the new pair into service (the HTTPS server's `setSecureContext`). */
  apply: (files: FileTls) => void;
  log: (line: string) => void;
  now?: () => number;
}

/**
 * Picks up a renewed `--tls-cert`/`--tls-key` pair without a restart. Looks
 * at both files' size and modification time; when either has changed, loads
 * the pair with `loadTlsFiles`'s checks and hands it to `apply`. A pair that
 * doesn't load (half written, the wrong key, a host it doesn't cover) is
 * logged once and the certificate already in service is kept; it is tried
 * again when a file changes again. New connections get the new certificate;
 * open ones keep theirs.
 */
export class TlsFileWatcher {
  private seen: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: TlsFileWatcherOptions) {
    this.seen = this.signature();
  }

  /** Whether a new pair was put into service. */
  check(): boolean {
    const now = this.signature();
    if (now === this.seen) return false;
    this.seen = now;
    let files: FileTls;
    try {
      files = loadTlsFiles(this.o.certPath, this.o.keyPath, this.o.hosts, this.o.now);
      this.o.apply(files);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/^Refusing to start: /, '');
      this.o.log(`[otherbench-server] Couldn't load the changed certificate files, so the old certificate is still in use: ${why}`);
      return false;
    }
    this.o.log(`[otherbench-server] Loaded the renewed certificate in ${this.o.certPath}, valid until ${day(files.notAfter)}.`);
    if (files.warning) this.o.log(files.warning);
    return true;
  }

  /** Checks every `intervalMs`; the timer doesn't keep the process alive. */
  start(intervalMs = TLS_RELOAD_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private signature(): string {
    const one = (path: string): string => {
      try {
        const s = statSync(path);
        return `${s.size}:${s.mtimeMs}`;
      } catch {
        return 'missing';
      }
    };
    return `${one(this.o.certPath)}|${one(this.o.keyPath)}`;
  }
}
