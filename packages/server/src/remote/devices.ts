import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Sent as `__Host-grunt_device`: Secure, HttpOnly, SameSite=Strict, Path=/. */
export const DEVICE_COOKIE = 'grunt_device';
export const DEVICE_MS = 90 * 24 * 60 * 60_000;
const KEY_BYTES = 32;
const FILE_MODE = 0o600;

/**
 * "Remembered device" cookies (change 8, fix round 1). A browser that has
 * signed in gets one: a random id and an expiry, signed with a key kept in
 * `device-key.json` beside `login.json` and bound to the password's epoch.
 * It is NOT a session and never lets anything in by itself: it only lets
 * that browser's password attempts skip the global budget and slow-down,
 * so a flood of wrong passwords can't keep Adam's own devices waiting. A
 * password change (new epoch) or "Sign out everywhere" (a new key) makes
 * every one of them worthless. Nothing is stored per device.
 */
export class DeviceKeys {
  private key: Buffer | null = null;

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (line) => console.error(line)
  ) {}

  /** A new cookie value for a browser that just signed in under `epoch`. */
  issue(epoch: string): { value: string; maxAgeSec: number } {
    const id = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + DEVICE_MS;
    return { value: `${id}.${expiresAt}.${this.mac(id, expiresAt, epoch)}`, maxAgeSec: DEVICE_MS / 1000 };
  }

  /** Whether `value` is a cookie this server issued, unexpired, under the current password and key. */
  valid(value: string | undefined, epoch: string | null): boolean {
    if (!value || epoch === null) return false;
    const parts = value.split('.');
    if (parts.length !== 3) return false;
    const [id, at, mac] = parts as [string, string, string];
    if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !/^\d{1,16}$/.test(at)) return false;
    const expiresAt = Number(at);
    if (expiresAt <= this.now()) return false;
    const expected = Buffer.from(this.mac(id, expiresAt, epoch));
    const given = Buffer.from(mac);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** A new key: every cookie issued so far stops counting ("Sign out everywhere"). */
  rotate(): void {
    this.fresh();
  }

  private fresh(): Buffer {
    const key = randomBytes(KEY_BYTES);
    this.key = key;
    this.save(key);
    return key;
  }

  private mac(id: string, expiresAt: number, epoch: string): string {
    return createHmac('sha256', this.secret()).update(`grunt-device-v1\n${id}\n${expiresAt}\n${epoch}`).digest('base64url');
  }

  /** The key, read from its file or made once. A broken file is replaced, which only forgets the devices. */
  private secret(): Buffer {
    if (this.key) return this.key;
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as { version?: unknown; key?: unknown };
      if (data.version === 1 && typeof data.key === 'string' && /^[0-9a-f]{64}$/.test(data.key)) {
        this.key = Buffer.from(data.key, 'hex');
        return this.key;
      }
    } catch {
      // Missing or broken: make a new one below.
    }
    return this.fresh();
  }

  /** Atomically, mode 0600 where the OS has modes. If it can't be written, the key lives until a restart. */
  private save(key: Buffer): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${randomBytes(6).toString('hex')}`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, key: key.toString('hex') })}\n`, { mode: FILE_MODE });
      renameSync(tmp, this.path);
      try {
        chmodSync(this.path, FILE_MODE);
      } catch {
        // A no-op on Windows.
      }
    } catch (err) {
      this.log(`[grunt-server] couldn't save ${this.path} (${(err as Error).message}); remembered devices are forgotten at the next restart`);
    }
  }
}
