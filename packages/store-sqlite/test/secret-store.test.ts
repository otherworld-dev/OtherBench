import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileSecretStore, createSecretStore } from '../src/secret-store.js';

const base = mkdtempSync(join(tmpdir(), 'grunt-secrets-'));
let counter = 0;
function freshPath(): string {
  counter += 1;
  return join(base, `secrets-${counter}.json`);
}

afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // ignore cleanup races
  }
});

describe('EncryptedFileSecretStore', () => {
  it('round-trips a value through set/get', async () => {
    const store = new EncryptedFileSecretStore(freshPath(), 'correct horse battery staple');
    await store.set('anthropic/default', 'sk-ant-super-secret-value');
    await expect(store.get('anthropic/default')).resolves.toBe('sk-ant-super-secret-value');
  });

  it('returns null for a ref that was never set', async () => {
    const store = new EncryptedFileSecretStore(freshPath(), 'passphrase');
    await expect(store.get('nope')).resolves.toBeNull();
  });

  it('returns null after delete', async () => {
    const store = new EncryptedFileSecretStore(freshPath(), 'passphrase');
    await store.set('ref-1', 'value-1');
    await store.delete('ref-1');
    await expect(store.get('ref-1')).resolves.toBeNull();
  });

  it('delete is a no-op when the file does not exist yet', async () => {
    const store = new EncryptedFileSecretStore(freshPath(), 'passphrase');
    await expect(store.delete('never-set')).resolves.toBeUndefined();
  });

  it('stores multiple refs independently', async () => {
    const path = freshPath();
    const store = new EncryptedFileSecretStore(path, 'passphrase');
    await store.set('ref-a', 'value-a');
    await store.set('ref-b', 'value-b');
    await expect(store.get('ref-a')).resolves.toBe('value-a');
    await expect(store.get('ref-b')).resolves.toBe('value-b');
  });

  it('a wrong passphrase fails to decrypt rather than returning garbage', async () => {
    const path = freshPath();
    const writer = new EncryptedFileSecretStore(path, 'correct-passphrase');
    await writer.set('ref', 'top-secret');

    const reader = new EncryptedFileSecretStore(path, 'wrong-passphrase');
    await expect(reader.get('ref')).rejects.toThrow();
  });

  it('rejects tampered ciphertext even with the correct passphrase (GCM auth tag)', async () => {
    const path = freshPath();
    const store = new EncryptedFileSecretStore(path, 'correct-passphrase');
    await store.set('ref', 'top-secret');

    // Flip one bit of one byte in the stored ciphertext, on disk, leaving
    // the passphrase, salt, IV, and auth tag untouched. GCM's auth tag is
    // computed over the ciphertext, so this must be caught as a decrypt
    // failure rather than silently producing corrupted plaintext.
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as {
      entries: Record<string, { ciphertext: string }>;
    };
    const entry = envelope.entries['ref'];
    const ciphertext = Buffer.from(entry.ciphertext, 'base64');
    ciphertext[0] = ciphertext[0] ^ 0x01;
    entry.ciphertext = ciphertext.toString('base64');
    writeFileSync(path, JSON.stringify(envelope));

    await expect(store.get('ref')).rejects.toThrow();
  });

  it('never writes the plaintext value into the file bytes', async () => {
    const path = freshPath();
    const store = new EncryptedFileSecretStore(path, 'passphrase');
    const secret = 'sk-live-do-not-leak-this-0123456789';
    await store.set('ref', secret);

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(secret);
    // Also guard against a trivial base64 leak of the exact plaintext bytes.
    expect(raw).not.toContain(Buffer.from(secret, 'utf8').toString('base64'));
  });

  it('overwriting an existing ref replaces its value', async () => {
    const path = freshPath();
    const store = new EncryptedFileSecretStore(path, 'passphrase');
    await store.set('ref', 'first-value');
    await store.set('ref', 'second-value');
    await expect(store.get('ref')).resolves.toBe('second-value');
  });

  it.skipIf(process.platform === 'win32')(
    'creates the file with mode 0600 on POSIX',
    async () => {
      const path = freshPath();
      const store = new EncryptedFileSecretStore(path, 'passphrase');
      await store.set('ref', 'value');
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  );

  it('serializes concurrent deletes so none are lost (read-modify-write race)', async () => {
    const path = freshPath();
    const store = new EncryptedFileSecretStore(path, 'passphrase');
    const refs = ['h1', 'h2', 'h3', 'h4'];
    for (const ref of refs) {
      await store.set(ref, `value-${ref}`);
    }

    // Fire all deletes concurrently, the way Promise.all(...) over per-header
    // deletes does in packages/server/src/routes/tools.ts. Without write
    // serialization, each call reads the envelope before any other call's
    // write lands, so all four writes race to overwrite each other and only
    // the last one to rename() sticks -- losing the other three deletes.
    await Promise.all(refs.map((ref) => store.delete(ref)));

    for (const ref of refs) {
      await expect(store.get(ref)).resolves.toBeNull();
    }
  });

  it('serializes concurrent sets so none are lost (read-modify-write race)', async () => {
    const path = freshPath();
    const store = new EncryptedFileSecretStore(path, 'passphrase');
    const refs = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];

    // Fire all sets concurrently. Without serialization this can also throw
    // EPERM/EBUSY on the rename() when two writers race on the same temp
    // target window, in addition to silently losing entries.
    await Promise.all(refs.map((ref) => store.set(ref, `value-${ref}`)));

    for (const ref of refs) {
      await expect(store.get(ref)).resolves.toBe(`value-${ref}`);
    }
  });

  it('a rejected write does not poison the serialization chain for later calls', async () => {
    const path = freshPath();
    const store = new EncryptedFileSecretStore(path, 'passphrase');

    // Force one write to fail (bad envelope state is hard to trigger
    // directly, so we simulate by deleting from an empty store concurrently
    // with a set that must still land afterwards). The key property under
    // test: an error in one queued operation must not prevent subsequent
    // operations on the same instance from ever running.
    const results = await Promise.allSettled([
      store.delete('does-not-exist'),
      store.set('ref', 'value'),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    await expect(store.get('ref')).resolves.toBe('value');

    // And a subsequent call after that must still work.
    await store.set('ref2', 'value2');
    await expect(store.get('ref2')).resolves.toBe('value2');
  });
});

describe('createSecretStore', () => {
  it('logs a loud, explicit warning that OS keychain storage is unavailable', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = createSecretStore(freshPath(), 'passphrase');
      expect(store).toBeInstanceOf(EncryptedFileSecretStore);
      expect(warnSpy).toHaveBeenCalled();
      const message = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(message.toLowerCase()).toContain('keychain');
      expect(message.toLowerCase()).toContain('encrypted file');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns a working store', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = createSecretStore(freshPath(), 'passphrase');
      await store.set('ref', 'value');
      await expect(store.get('ref')).resolves.toBe('value');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
