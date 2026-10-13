import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LoginFileError } from './errors.js';

/** spec 2026-10-12-remote-access, "Setting the password". */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const SALT_BYTES = 16;
const HASH_BYTES = 32;
/** N=2^15, r=8 needs 32 MiB, exactly Node's default limit, which it refuses; give it room. */
const MAXMEM = 64 * 1024 * 1024;
const FILE_MODE = 0o600;
/** How often `epoch()` may look at the file. */
const EPOCH_CHECK_MS = 1000;

/** `login.json`: the one password, and an epoch that changes with it, so a change ends every session. */
export interface PasswordRecord {
  version: 1;
  scrypt: ScryptParams;
  salt: string;
  hash: string;
  epoch: string;
  setAt: number;
}

/** Why `pw` can't be the password, or null. Counts characters (code points), not UTF-16 units. */
export function passwordProblem(pw: string): string | null {
  const n = [...pw].length;
  if (n < MIN_PASSWORD_LENGTH) return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (n > MAX_PASSWORD_LENGTH) return 'The password can be at most 1,024 characters.';
  return null;
}

/**
 * The same password typed on an iPhone (often NFD) and on Windows (NFC) must
 * match, so it's normalised before hashing.
 */
function derive(pw: string, salt: Buffer, params: ScryptParams, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pw.normalize('NFC'), salt, keylen, { ...params, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(pw: string, params: ScryptParams = DEFAULT_SCRYPT, now: number = Date.now()): Promise<PasswordRecord> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(pw, salt, params, HASH_BYTES);
  return { version: 1, scrypt: { ...params }, salt: salt.toString('hex'), hash: hash.toString('hex'), epoch: randomBytes(8).toString('hex'), setAt: now };
}

/** Uses the record's own parameters, so they can be raised later without breaking old files. */
export async function verifyPassword(pw: string, record: PasswordRecord): Promise<boolean> {
  const expected = Buffer.from(record.hash, 'hex');
  if (expected.length === 0) return false;
  const actual = await derive(pw, Buffer.from(record.salt, 'hex'), record.scrypt, expected.length);
  return timingSafeEqual(actual, expected);
}

const isHex = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && /^[0-9a-f]+$/.test(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

function parseRecord(raw: string, path: string): PasswordRecord {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LoginFileError(path, 'not JSON');
  }
  const r = data as Partial<PasswordRecord> | null;
  const s = r?.scrypt as Partial<ScryptParams> | undefined;
  if (!r || r.version !== 1 || !s || !isPositiveInt(s.N) || !isPositiveInt(s.r) || !isPositiveInt(s.p) || !isHex(r.salt) || !isHex(r.hash) || !isHex(r.epoch) || typeof r.setAt !== 'number') {
    throw new LoginFileError(path, 'unknown format');
  }
  return { version: 1, scrypt: { N: s.N, r: s.r, p: s.p }, salt: r.salt, hash: r.hash, epoch: r.epoch, setAt: r.setAt };
}

/**
 * `<dir of secrets.json>/login.json` (spec §2). Kept outside the database so
 * `grunt password` works while the server runs and nothing syncs it. A
 * missing file means no one can sign in and every session ends.
 */
export class PasswordFile {
  private cache: { sig: string; record: PasswordRecord | null } | null = null;
  private checkedAt = Number.NEGATIVE_INFINITY;

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly params: ScryptParams = DEFAULT_SCRYPT
  ) {}

  /** The record, or null when there's no file. Throws `LoginFileError` for a broken one. Refreshes `epoch()`'s view. */
  read(): PasswordRecord | null {
    let raw: string;
    let sig: string;
    try {
      const st = statSync(this.path);
      sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.remember('missing', null);
        return null;
      }
      throw err;
    }
    const record = parseRecord(raw, this.path);
    this.remember(sig, record);
    return record;
  }

  /** Hashes and writes `pw` atomically (temp file, then rename), mode 0600 where the OS has modes. */
  async write(pw: string): Promise<PasswordRecord> {
    const problem = passwordProblem(pw);
    if (problem) throw new Error(problem);
    const record = await hashPassword(pw, this.params, this.now());
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${randomBytes(6).toString('hex')}`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
    await chmod(tmp, FILE_MODE).catch(() => {
      // A no-op on Windows; the mode was already asked for at creation.
    });
    await rename(tmp, this.path);
    await chmod(this.path, FILE_MODE).catch(() => {});
    this.read();
    return record;
  }

  /**
   * The current epoch, or null when there's no usable file (missing, or not a
   * password record). Looks at the file at most once a second and re-reads it
   * only when its mtime, size or inode changed, so `grunt password` against a
   * live server takes effect within a second and a busy server doesn't read
   * the file on every request. A transient I/O error (EBUSY, EPERM) keeps the
   * last good epoch, so it doesn't end every session.
   */
  epoch(): string | null {
    const t = this.now();
    if (this.cache && t - this.checkedAt < EPOCH_CHECK_MS) return this.cache.record?.epoch ?? null;
    this.checkedAt = t;
    let sig: string;
    try {
      const st = statSync(this.path);
      sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch (err) {
      // Anything but a missing file is an I/O error: see above.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return this.cache?.record?.epoch ?? null;
      this.cache = { sig: 'missing', record: null };
      return null;
    }
    if (this.cache?.sig !== sig) {
      let record: PasswordRecord | null;
      try {
        record = parseRecord(readFileSync(this.path, 'utf8'), this.path);
      } catch (err) {
        if (err instanceof LoginFileError) {
          record = null;
        } else if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Gone between the stat and the read.
          this.cache = { sig: 'missing', record: null };
          return null;
        } else {
          // An I/O error says nothing about the file's content. Keep the last
          // good epoch and don't record this signature, so the next check, a
          // second on, reads the file again.
          return this.cache?.record?.epoch ?? null;
        }
      }
      this.cache = { sig, record };
    }
    return this.cache.record?.epoch ?? null;
  }

  private remember(sig: string, record: PasswordRecord | null): void {
    this.cache = { sig, record };
    this.checkedAt = this.now();
  }
}
