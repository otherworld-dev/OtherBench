import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
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
