import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SecretStore } from '@grunt/core/ports/secret-store.js';

const SCRYPT_KEY_LENGTH = 32; // AES-256
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }; // interactive-strength scrypt cost
const IV_LENGTH = 12; // recommended GCM nonce size
const SALT_LENGTH = 16;
const FILE_MODE = 0o600;

interface EncryptedEntry {
  iv: string; // base64
  authTag: string; // base64
  ciphertext: string; // base64
}

interface FileEnvelope {
  version: 1;
  /** Per-file scrypt salt (base64), shared by every entry in the file. */
  salt: string;
  entries: Record<string, EncryptedEntry>;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function deriveKey(passphrase: string, saltB64: string): Buffer {
  const salt = Buffer.from(saltB64, 'base64');
  return scryptSync(passphrase, salt, SCRYPT_KEY_LENGTH, SCRYPT_PARAMS);
}

function encryptValue(value: string, key: Buffer): EncryptedEntry {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Throws if `key` is wrong or the entry has been tampered with (GCM auth-tag check). */
function decryptValue(entry: EncryptedEntry, key: Buffer): string {
  const iv = Buffer.from(entry.iv, 'base64');
  const authTag = Buffer.from(entry.authTag, 'base64');
  const ciphertext = Buffer.from(entry.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * `SecretStore` backed by a single AES-256-GCM-encrypted JSON file. The
 * encryption key is derived from a passphrase with scrypt, using a random
 * salt generated once per file and stored (not secret) alongside the
 * ciphertext. Each entry gets its own random IV.
 *
 * Writes are atomic: the new envelope is written to a temp file in the same
 * directory and then renamed over the target, so a crash mid-write can never
 * leave a partially-written or corrupt secrets file. The file (and the temp
 * file that becomes it) is created with mode 0600; `chmod` is attempted
 * again after rename since some platforms don't preserve mode across
 * rename/replace, and is a documented no-op on Windows (whose ACL model
 * `fs.chmod` cannot express) rather than a silent skip.
 *
 * This is the real, working default secret store for Grunt -- see
 * `createSecretStore` for why it is used unconditionally rather than behind
 * an OS-keychain-with-fallback factory.
 */
export class EncryptedFileSecretStore implements SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly passphrase: string
  ) {}

  async get(ref: string): Promise<string | null> {
    const envelope = await this.readEnvelope();
    const entry = envelope?.entries[ref];
    if (!envelope || !entry) return null;
    const key = deriveKey(this.passphrase, envelope.salt);
    return decryptValue(entry, key);
  }

  async set(ref: string, value: string): Promise<void> {
    const envelope = (await this.readEnvelope()) ?? {
      version: 1,
      salt: randomBytes(SALT_LENGTH).toString('base64'),
      entries: {},
    };
    const key = deriveKey(this.passphrase, envelope.salt);
    envelope.entries[ref] = encryptValue(value, key);
    await this.writeEnvelope(envelope);
  }

  async delete(ref: string): Promise<void> {
    const envelope = await this.readEnvelope();
    if (!envelope || !(ref in envelope.entries)) return;
    delete envelope.entries[ref];
    await this.writeEnvelope(envelope);
  }

  private async readEnvelope(): Promise<FileEnvelope | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as FileEnvelope;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  private async writeEnvelope(envelope: FileEnvelope): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${randomBytes(6).toString('hex')}`;
    await writeFile(tmpPath, JSON.stringify(envelope), { mode: FILE_MODE });
    await chmod(tmpPath, FILE_MODE).catch(() => {
      // Best-effort: no-op on Windows (no POSIX mode bits), and any other
      // failure here shouldn't block the write -- the mode was already
      // requested at file-creation time above.
    });
    await rename(tmpPath, this.filePath);
    await chmod(this.filePath, FILE_MODE).catch(() => {
      // Same best-effort reasoning: some platforms/filesystems don't
      // preserve the mode of the source across a rename-over-existing-file.
    });
  }
}

const KEYCHAIN_UNAVAILABLE_WARNING =
  '[@grunt/store-sqlite] OS keychain storage is not available: there is no ' +
  'non-native OS tool on this platform that can both store AND read back a ' +
  'secret over a CLI (Windows\' `cmdkey`, for example, can set a Credential ' +
  'Manager entry but the OS deliberately refuses to hand its password back ' +
  'out via the CLI). Rather than ship a keychain path that silently can\'t ' +
  'round-trip, API keys and other secrets will be stored in an ' +
  'AES-256-GCM-encrypted file instead.';

/**
 * Builds the `SecretStore` Grunt actually uses. There is deliberately no
 * "try the OS keychain, silently fall back to a file" branch here: the
 * obvious keychain-via-shelling-out options were evaluated and rejected --
 * see {@link KEYCHAIN_UNAVAILABLE_WARNING} -- so this always returns the
 * encrypted-file store, and always says so loudly (never silently) via
 * `console.warn` so nobody mistakes "encrypted file" for "OS keychain" when
 * reasoning about the machine's threat model.
 */
export function createSecretStore(filePath: string, passphrase: string): SecretStore {
  console.warn(KEYCHAIN_UNAVAILABLE_WARNING);
  return new EncryptedFileSecretStore(filePath, passphrase);
}
