import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TlsFilesError } from '../../src/remote/errors.js';
import { AUTO_CERT_DAYS, expiryWarning, loadOrCreateAutoTls, loadTlsFiles, TlsFileWatcher, type FileTls } from '../../src/remote/tls.js';

const DAY = 86_400_000;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'otherbench-tls-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const make = (names: string[], now = Date.now()) => loadOrCreateAutoTls({ dir: join(dir, 'https'), names, nodeName: 'box', now: () => now });

describe('loadOrCreateAutoTls', () => {
  it('makes a CA and a server certificate for the public names, and writes no CA key', () => {
    const tls = make(['otherbench.test', '192.168.1.5', 'fd00::5']);

    expect(tls.created).toBe(true);
    expect(readdirSync(join(dir, 'https')).sort()).toEqual(['otherbench-ca.crt', 'server.crt', 'server.key']);
    const ca = new X509Certificate(tls.caDer);
    const cert = new X509Certificate(tls.certPem);
    expect(ca.ca).toBe(true);
    expect(ca.subject).toMatch(/^CN=OtherBench local CA box \d{4}-\d{2}-\d{2}$/);
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.checkHost('otherbench.test')).toBe('otherbench.test');
    expect(cert.checkIP('192.168.1.5')).toBe('192.168.1.5');
    expect(cert.checkIP('fd00::5')).toBe('fd00::5');
    expect(cert.checkPrivateKey(createPrivateKey(tls.keyPem))).toBe(true);
    expect(tls.caFingerprint).toBe(ca.fingerprint256);
    expect(Math.round((cert.validToDate.getTime() - Date.now()) / DAY)).toBe(AUTO_CERT_DAYS);
    // The only private key on disk is the server's.
    const key = readFileSync(join(dir, 'https', 'server.key'), 'utf8');
    expect(cert.checkPrivateKey(createPrivateKey(key))).toBe(true);
    for (const f of ['otherbench-ca.crt', 'server.crt']) expect(readFileSync(join(dir, 'https', f), 'utf8')).not.toContain('PRIVATE KEY');
  });

  it('reuses the files unchanged on the next start, IPv6 names included', () => {
    const first = make(['otherbench.test', 'fd00::5']);
    const second = make(['fd00::5', 'OTHERBENCH.test']);

    expect(second.created).toBe(false);
    expect(second.caFingerprint).toBe(first.caFingerprint);
    expect(second.certPem).toBe(first.certPem);
  });

  it('makes new ones when the names change, when a file is missing, or with 30 days or fewer left', () => {
    const now = Date.now();
    const first = make(['otherbench.test'], now);

    const renamed = make(['otherbench.test', 'otherbench.lan'], now);
    expect(renamed.created).toBe(true);
    expect(renamed.caFingerprint).not.toBe(first.caFingerprint);

    unlinkSync(join(dir, 'https', 'otherbench-ca.crt'));
    expect(make(['otherbench.test', 'otherbench.lan'], now).created).toBe(true);

    const fresh = make(['otherbench.test', 'otherbench.lan'], now);
    expect(fresh.created).toBe(false);
    expect(make(['otherbench.test', 'otherbench.lan'], now + (AUTO_CERT_DAYS - 31) * DAY).created).toBe(false);
    expect(make(['otherbench.test', 'otherbench.lan'], now + (AUTO_CERT_DAYS - 29) * DAY).created).toBe(true);
  });

  it('makes new ones when a file is garbage, and refuses to touch the files when one cannot be read', () => {
    const now = Date.now();
    make(['otherbench.test'], now);
    writeFileSync(join(dir, 'https', 'server.crt'), 'not a certificate');
    expect(make(['otherbench.test'], now).created).toBe(true);

    // A directory where the certificate should be: reading it fails with EISDIR, not ENOENT.
    const crt = join(dir, 'https', 'server.crt');
    rmSync(crt);
    mkdirSync(crt);
    const caBefore = readFileSync(join(dir, 'https', 'otherbench-ca.crt'), 'utf8');
    const keyBefore = readFileSync(join(dir, 'https', 'server.key'), 'utf8');

    expect(() => make(['otherbench.test'], now)).toThrow(TlsFilesError);
    expect(() => make(['otherbench.test'], now)).toThrow(/couldn't read .*server\.crt.*left as they are/);
    expect(readFileSync(join(dir, 'https', 'otherbench-ca.crt'), 'utf8')).toBe(caBefore);
    expect(readFileSync(join(dir, 'https', 'server.key'), 'utf8')).toBe(keyBefore);
    expect(statSync(crt).isDirectory()).toBe(true);
  });
});

describe('loadTlsFiles', () => {
  function files(names: string[]) {
    const tls = loadOrCreateAutoTls({ dir: join(dir, 'own'), names, nodeName: 'box' });
    // A chain file: the server certificate, then the CA.
    writeFileSync(join(dir, 'chain.pem'), tls.certPem + readFileSync(join(dir, 'own', 'otherbench-ca.crt'), 'utf8'));
    return { cert: join(dir, 'chain.pem'), key: join(dir, 'own', 'server.key') };
  }

  it('reads a certificate chain and its key that cover every public host', () => {
    const { cert, key } = files(['otherbench.test', '192.168.1.5']);
    const loaded = loadTlsFiles(cert, key, ['otherbench.test', '192.168.1.5']);

    expect(loaded.certPem).toContain('BEGIN CERTIFICATE');
    expect(loaded.certPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(loaded.warning).toBeNull();
  });

  it("refuses a key that doesn't match, a host the certificate doesn't cover, and files that don't parse", () => {
    const { cert, key } = files(['otherbench.test']);
    const other = join(dir, 'other.key');
    writeFileSync(other, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    writeFileSync(join(dir, 'junk.pem'), 'hello');

    expect(() => loadTlsFiles(cert, other, ['otherbench.test'])).toThrow(TlsFilesError);
    expect(() => loadTlsFiles(cert, key, ['otherbench.test', 'otherbench.lan'])).toThrow(/doesn't cover otherbench\.lan/);
    expect(() => loadTlsFiles(join(dir, 'junk.pem'), key, ['otherbench.test'])).toThrow(TlsFilesError);
    expect(() => loadTlsFiles(join(dir, 'missing.pem'), key, ['otherbench.test'])).toThrow(TlsFilesError);
  });

  it('warns when the certificate expires within 30 days', () => {
    const { cert, key } = files(['otherbench.test']);

    expect(loadTlsFiles(cert, key, ['otherbench.test'], () => Date.now() + (AUTO_CERT_DAYS - 10) * DAY).warning).toMatch(/expires on/);
  });
});

describe('TlsFileWatcher', () => {
  /** A fresh certificate and key for `names`, written over `cert.pem` and `key.pem`. */
  function renew(names: string[], tag: string): { cert: string; key: string; certPem: string } {
    const tls = loadOrCreateAutoTls({ dir: join(dir, tag), names, nodeName: 'box' });
    writeFileSync(join(dir, 'cert.pem'), tls.certPem);
    writeFileSync(join(dir, 'key.pem'), tls.keyPem);
    return { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem'), certPem: tls.certPem };
  }

  /** Moves both files' modification time on, as a renewal would. */
  function touch(seconds: number): void {
    const t = new Date(Date.now() + seconds * 1000);
    for (const f of ['cert.pem', 'key.pem']) utimesSync(join(dir, f), t, t);
  }

  it('puts a renewed pair into service, keeps the old one while a pair is broken, and logs each change once', () => {
    const { cert, key } = renew(['otherbench.test'], 'a');
    const applied: FileTls[] = [];
    const lines: string[] = [];
    const watcher = new TlsFileWatcher({ certPath: cert, keyPath: key, hosts: ['otherbench.test'], apply: (f) => applied.push(f), log: (l) => lines.push(l) });

    expect(watcher.check()).toBe(false);
    expect(applied).toHaveLength(0);

    const b = renew(['otherbench.test'], 'b');
    touch(10);
    expect(watcher.check()).toBe(true);
    expect(applied.map((f) => f.certPem)).toEqual([b.certPem]);
    expect(lines.at(-1)).toMatch(/^\[otherbench-server\] Loaded the renewed certificate in .*cert\.pem, valid until \d{4}-\d{2}-\d{2}\.$/);

    // Half way through a renewal: the new certificate, the old key.
    const keyBefore = readFileSync(key, 'utf8');
    renew(['otherbench.test'], 'c');
    writeFileSync(key, keyBefore);
    touch(20);
    expect(watcher.check()).toBe(false);
    expect(watcher.check()).toBe(false);
    expect(applied).toHaveLength(1);
    expect(lines.filter((l) => l.includes("Couldn't load"))).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/still in use: .*is not the key for the certificate/);
    expect(lines.at(-1)).not.toMatch(/Refusing to start/);

    // A certificate that no longer covers a public host is refused too.
    renew(['other.example'], 'd');
    touch(30);
    expect(watcher.check()).toBe(false);
    expect(lines.at(-1)).toMatch(/doesn't cover otherbench\.test/);

    const e = renew(['otherbench.test'], 'e');
    touch(40);
    expect(watcher.check()).toBe(true);
    expect(applied.map((f) => f.certPem)).toEqual([b.certPem, e.certPem]);
  });

  it("swaps a running HTTPS server's certificate for new connections", async () => {
    const first = renew(['localhost'], 'a');
    const server = createHttpsServer({ key: readFileSync(first.key, 'utf8'), cert: first.certPem }, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const served = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false }, () => {
          const raw = socket.getPeerX509Certificate()?.fingerprint256 ?? '';
          socket.end();
          resolve(raw);
        });
        socket.on('error', reject);
      });
    try {
      const watcher = new TlsFileWatcher({
        certPath: first.cert,
        keyPath: first.key,
        hosts: ['localhost'],
        apply: (f) => server.setSecureContext({ key: f.keyPem, cert: f.certPem }),
        log: () => {},
      });
      expect(await served()).toBe(new X509Certificate(first.certPem).fingerprint256);

      const second = renew(['localhost'], 'b');
      touch(10);
      expect(watcher.check()).toBe(true);
      expect(await served()).toBe(new X509Certificate(second.certPem).fingerprint256);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('expiryWarning', () => {
  it('says nothing with more than 30 days left, warns inside 30, and says expired after', () => {
    const now = Date.now();
    expect(expiryWarning(now + 31 * DAY, now)).toBeNull();
    expect(expiryWarning(now + 10 * DAY, now)).toMatch(/expires on .* \(in 10 days\)/);
    expect(expiryWarning(now - DAY, now)).toMatch(/expired on/);
  });
});
