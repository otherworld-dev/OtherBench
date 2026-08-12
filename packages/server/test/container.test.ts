import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer, resolveSecretsPassphrase } from '../src/container.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-container-test-'));
});

afterEach(async () => {
  delete process.env['GRUNT_SECRETS_PASSPHRASE'];
  await rm(dir, { recursive: true, force: true });
});

describe('resolveSecretsPassphrase', () => {
  it('uses GRUNT_SECRETS_PASSPHRASE when set, without touching the filesystem', async () => {
    process.env['GRUNT_SECRETS_PASSPHRASE'] = 'env-supplied-passphrase';
    const secretsPath = join(dir, 'secrets.json');

    const passphrase = await resolveSecretsPassphrase(secretsPath);

    expect(passphrase).toBe('env-supplied-passphrase');
    await expect(stat(`${secretsPath}.key`)).rejects.toThrow();
  });

  it('generates and persists a random passphrase on first call', async () => {
    const secretsPath = join(dir, 'secrets.json');

    const passphrase = await resolveSecretsPassphrase(secretsPath);

    expect(passphrase.length).toBeGreaterThan(20);
    const keyFileContents = (await readFile(`${secretsPath}.key`, 'utf8')).trim();
    expect(keyFileContents).toBe(passphrase);
  });

  // Split out from the test above (rather than an `if (platform !== win32)`
  // inside it) so the Windows skip is visible in the test-runner's own
  // output -- a conditional assertion buried inside a passing test would
  // quietly stop checking anything on this platform without saying so
  // anywhere a reader would notice.
  it.skipIf(process.platform === 'win32')(
    'creates the key file with mode 0600 on POSIX -- a documented no-op on Windows',
    async () => {
      const secretsPath = join(dir, 'secrets.json');

      await resolveSecretsPassphrase(secretsPath);

      const mode = (await stat(`${secretsPath}.key`)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  );

  it('reuses the persisted passphrase on subsequent calls instead of generating a new one', async () => {
    const secretsPath = join(dir, 'secrets.json');

    const first = await resolveSecretsPassphrase(secretsPath);
    const second = await resolveSecretsPassphrase(secretsPath);

    expect(second).toBe(first);
  });

  it('generates independent passphrases for different secrets paths', async () => {
    const a = await resolveSecretsPassphrase(join(dir, 'a.json'));
    const b = await resolveSecretsPassphrase(join(dir, 'b.json'));

    expect(a).not.toBe(b);
  });
});

describe('createContainer', () => {
  it('wires a working store, secrets, and engine over a real (temp-file) SQLite database', async () => {
    const dbPath = join(dir, 'grunt.db');
    const secretsPath = join(dir, 'secrets.json');

    const container = await createContainer({ dbPath, secretsPath });
    try {
      // Store: migrations ran, repos are usable.
      const connection = container.store.connections.create({
        id: 'conn-1',
        name: 'Test',
        kind: 'mock',
        baseUrl: null,
        secretRef: null,
        extraHeaders: {},
        status: 'unknown',
        statusMessage: null,
        checkedAt: null,
      });
      expect(container.store.connections.get(connection.id)).toMatchObject({ id: 'conn-1', name: 'Test' });

      // Secrets: round-trips a value.
      await container.secrets.set('conn:conn-1', 'sk-super-secret');
      expect(await container.secrets.get('conn:conn-1')).toBe('sk-super-secret');

      // Engine: the mock connection works with no API key (decision #3).
      const result = await container.engine.testConnection(connection, null);
      expect(result.ok).toBe(true);
    } finally {
      container.close();
    }
  });

  it('accepts :memory: as a database path', async () => {
    const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json') });
    expect(container.store.connections.list()).toEqual([]);
    container.close();
  });
});
