import { dirname, join } from 'node:path';
import type { Context } from 'hono';
import { clientAddress, normalizeIp } from './client-address.js';
import { DeviceKeys } from './devices.js';
import { LoginLimiter } from './limiter.js';
import { PasswordFile, type ScryptParams } from './password.js';
import { parsePublicUrl } from './public-url.js';
import { SessionStore } from './sessions.js';

/** How HTTPS reaches the browser, for the status route and Settings → Remote access. */
export interface RemoteTls {
  mode: 'auto' | 'files' | 'proxy';
  /** When the certificate Grunt serves expires (auto and files). */
  notAfter?: number;
  /** `--tls auto`: the CA's SHA-256, as `grunt serve` prints it. */
  caFingerprint?: string;
  /** `--tls auto`: the names the certificate covers. */
  names?: string[];
  /** `--tls auto`: the CA certificate, DER, for `GET /grunt-ca.crt`. Never in the status route. */
  caDer?: Buffer;
}

export interface RemoteAccessOptions {
  publicUrls: string[];
  trustProxies: string[];
  /** `<dir of secrets.json>/login.json`. */
  loginPath: string;
  tls: RemoteTls;
  now?: () => number;
  log?: (line: string) => void;
  /** scrypt parameters for a password change; tests lower them. */
  scrypt?: ScryptParams;
}

/** Everything sign-in mode's request checks need (spec 2026-10-12-remote-access §3). Null in open and token modes. */
export interface RemoteAccess {
  publicOrigins: string[];
  publicHosts: string[];
  publicHostnames: string[];
  trustProxies: string[];
  tls: RemoteTls;
  passwords: PasswordFile;
  sessions: SessionStore;
  limiter: LoginLimiter;
  /** Remembered-device cookies: `device-key.json` beside `login.json`. */
  devices: DeviceKeys;
  log: (line: string) => void;
  clientAddress(c: Context): string | null;
  /** Stops the session sweep. */
  close(): void;
}

const unique = (values: string[]): string[] => [...new Set(values)];

export function createRemoteAccess(o: RemoteAccessOptions): RemoteAccess {
  const parsed = o.publicUrls.map(parsePublicUrl);
  const trusted = new Set(o.trustProxies.map((p) => normalizeIp(p)).filter((p): p is string => p !== null));
  const now = o.now ?? Date.now;
  const log = o.log ?? ((line: string) => console.error(line));
  const passwords = new PasswordFile(o.loginPath, now, o.scrypt);
  const sessions = new SessionStore({ now });
  sessions.startSweeping(() => passwords.epoch());
  const limiter = new LoginLimiter({ now, log });
  return {
    publicOrigins: unique(parsed.map((p) => p.origin)),
    publicHosts: unique(parsed.map((p) => p.host)),
    publicHostnames: unique(parsed.map((p) => p.hostname)),
    trustProxies: [...trusted],
    tls: o.tls,
    passwords,
    sessions,
    limiter,
    devices: new DeviceKeys(join(dirname(o.loginPath), 'device-key.json'), now, log),
    log,
    clientAddress: (c) => clientAddress(c, trusted),
    close: () => {
      sessions.stop();
      limiter.close();
    },
  };
}
