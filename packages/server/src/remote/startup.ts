import { dirname, join } from 'node:path';
import { LoginFileError, NoPasswordError, RemoteStartError } from './errors.js';
import { createRemoteAccess, type RemoteAccess, type RemoteTls } from './index.js';
import { PasswordFile } from './password.js';
import { parsePublicUrl } from './public-url.js';
import { loadOrCreateAutoTls, loadTlsFiles, type FileTls } from './tls.js';

export interface SignInOptions {
  publicUrls: string[];
  tls: 'auto' | null;
  tlsCert: string | null;
  tlsKey: string | null;
  trustProxies: string[];
  /** Whether `--host` is a loopback address. */
  loopback: boolean;
}

/** `<dir of secrets.json>/login.json`. */
export function loginPathFor(secretsPath: string): string {
  return join(dirname(secretsPath), 'login.json');
}

export interface SignInCheck {
  loginPath: string;
  /** `<dir of secrets.json>/https`, for `--tls auto`. */
  httpsDir: string;
  files: FileTls | null;
  /** Lines `grunt serve` prints after its listening line. */
  notes: string[];
}

/**
 * Sign-in's I/O checks, run before the container is built so a refusal
 * leaves nothing to clean up: a usable `login.json`, and certificate files
 * that parse, match their key and cover every public host.
 */
export function checkSignIn(o: SignInOptions, secretsPath: string): SignInCheck {
  const loginPath = loginPathFor(secretsPath);
  let record;
  try {
    record = new PasswordFile(loginPath).read();
  } catch (err) {
    // `read` already names a broken file; anything else (EACCES, EISDIR) is an
    // I/O error that would print as a stack trace, so it gets the same refusal.
    if (err instanceof RemoteStartError) throw err;
    throw new LoginFileError(loginPath, `couldn't read it: ${(err as Error).message}`);
  }
  if (record === null) throw new NoPasswordError(loginPath);
  const hostnames = o.publicUrls.map((u) => parsePublicUrl(u).hostname);
  const files = o.tlsCert !== null && o.tlsKey !== null ? loadTlsFiles(o.tlsCert, o.tlsKey, hostnames) : null;
  const notes: string[] = [];
  if (files?.warning) notes.push(files.warning);
  if (o.loopback && o.trustProxies.length === 0) {
    notes.push("Warning: sign-in is on, but Grunt only listens on this machine, so other devices can't reach it. Add --host 0.0.0.0 (or this machine's address), or put an HTTPS proxy in front and pass --trust-proxy.");
  }
  return { loginPath, httpsDir: join(dirname(secretsPath), 'https'), files, notes };
}

export interface SignIn {
  remote: RemoteAccess;
  /** What `https.createServer` gets; null behind a proxy. */
  tls: { key: string; cert: string } | null;
  /** When the served certificate expires, for the daily check; null behind a proxy. */
  notAfter: number | null;
  notes: string[];
}

/** After the container: `--tls auto` names its CA after this node. */
export function startSignIn(o: SignInOptions, check: SignInCheck, nodeName: string, now: () => number = Date.now): SignIn {
  const parsed = o.publicUrls.map(parsePublicUrl);
  const names = [...new Set(parsed.map((p) => p.hostname))];
  const notes = [...check.notes];
  let tls: SignIn['tls'] = null;
  let notAfter: number | null = null;
  let summary: RemoteTls;
  if (o.tls === 'auto') {
    const auto = loadOrCreateAutoTls({ dir: check.httpsDir, names, nodeName, now });
    tls = { key: auto.keyPem, cert: auto.certPem };
    notAfter = auto.notAfter;
    summary = { mode: 'auto', notAfter: auto.notAfter, caFingerprint: auto.caFingerprint, names: auto.names, caDer: auto.caDer };
    notes.push(`Grunt's certificate authority: SHA-256 ${auto.caFingerprint}. Check a device's copy against this, never against a web page.`);
    notes.push(`HTTPS certificate valid until ${new Date(auto.notAfter).toISOString().slice(0, 10)} for ${auto.names.join(', ')}.`);
    if (auto.created) {
      notes.push(`Made a new certificate authority: every device has to trust it again. Download it from ${parsed[0]!.origin}/grunt-ca.crt.`);
    }
  } else if (check.files) {
    tls = { key: check.files.keyPem, cert: check.files.certPem };
    notAfter = check.files.notAfter;
    summary = { mode: 'files', notAfter: check.files.notAfter };
  } else {
    summary = { mode: 'proxy' };
  }
  const remote = createRemoteAccess({ publicUrls: o.publicUrls, trustProxies: o.trustProxies, loginPath: check.loginPath, tls: summary, now });
  return { remote, tls, notAfter, notes };
}
