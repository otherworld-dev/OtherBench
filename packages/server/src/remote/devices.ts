import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Sent as `__Host-otherbench_device`: Secure, HttpOnly, SameSite=Strict, Path=/. */
export const DEVICE_COOKIE = 'otherbench_device';
export const DEVICE_MS = 90 * 24 * 60 * 60_000;
const KEY_BYTES = 32;
const FILE_MODE = 0o600;

/** The file operations a key save uses; tests make them fail. */
export interface DeviceKeyIo {
  write(path: string, data: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

const realIo: DeviceKeyIo = {
  write: (path, data) => writeFileSync(path, data, { mode: FILE_MODE }),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
};

/**
 * "Remembered device" cookies (change 8, fix round 1). A browser that has
 * signed in gets one: a random id and an expiry, signed with a key kept in
 * `device-key.json` beside `login.json` and bound to the password's epoch.
 * It is NOT a session and never lets anything in by itself: it only lets
 * that browser's password attempts skip the global budget and slow-down,
 * so a flood of wrong passwords can't keep Adam's own devices waiting. A
 * password change (new epoch) or "Sign out everywhere" (a new key) makes
 * every one of them worthless. Nothing is stored per device. The sign-in
 * limiter locks a cookie by its id after 5 wrong passwords with it.
 */
export class DeviceKeys {
  private key: Buffer | null = null;

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (line) => console.error(line),
    private readonly io: DeviceKeyIo = realIo
  ) {}

  /** A new cookie value for a browser that just signed in under `epoch`. */
  issue(epoch: string): { value: string; maxAgeSec: number } {
    const id = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + DEVICE_MS;
    return { value: `${id}.${expiresAt}.${this.mac(id, expiresAt, epoch)}`, maxAgeSec: DEVICE_MS / 1000 };
  }

  /** The cookie's id when `value` is one this server issued, unexpired, under the current password and key; else null. */
  idOf(value: string | undefined, epoch: string | null): string | null {
    if (!value || epoch === null) return null;
    const parts = value.split('.');
    if (parts.length !== 3) return null;
    const [id, at, mac] = parts as [string, string, string];
    if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !/^\d{1,16}$/.test(at)) return null;
    const expiresAt = Number(at);
    if (expiresAt <= this.now()) return null;
    const expected = Buffer.from(this.mac(id, expiresAt, epoch));
    const given = Buffer.from(mac);
    return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
  }

  valid(value: string | undefined, epoch: string | null): boolean {
    return this.idOf(value, epoch) !== null;
  }

  /**
   * A new key: every cookie issued so far stops counting ("Sign out
   * everywhere"). If the new key can't be saved, the old file is deleted,
   * so a restart can't bring the revoked cookies back; if that fails too,
   * it says so loudly.
   */
  rotate(): void {
    const key = randomBytes(KEY_BYTES);
    this.key = key;
    if (this.save(key)) return;
    try {
      this.io.unlink(this.path);
      this.log(`[otherbench-server] couldn't save a new ${this.path}, so the old one was deleted: remembered devices stay forgotten after a restart, which makes a new key`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.log(
        `[otherbench-server] COULDN'T SAVE OR DELETE ${this.path} (${(err as Error).message}). The devices just signed out stay out until a restart, but after one they would be remembered again. Delete the file by hand.`
      );
    }
  }

  private fresh(): Buffer {
    const key = randomBytes(KEY_BYTES);
    this.key = key;
    if (!this.save(key)) this.log(`[otherbench-server] couldn't save ${this.path}; devices remembered from now on are forgotten at the next restart`);
    return key;
  }

  private mac(id: string, expiresAt: number, epoch: string): string {
    return createHmac('sha256', this.secret()).update(`otherbench-device-v1\n${id}\n${expiresAt}\n${epoch}`).digest('base64url');
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

  /** Atomically, mode 0600 where the OS has modes. False when it couldn't be written. */
  private save(key: Buffer): boolean {
    const tmp = `${this.path}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.io.write(tmp, `${JSON.stringify({ version: 1, key: key.toString('hex') })}\n`);
      this.io.rename(tmp, this.path);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Nothing more to do.
      }
      return false;
    }
    try {
      chmodSync(this.path, FILE_MODE);
    } catch {
      // A no-op on Windows.
    }
    return true;
  }
}
