import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_MEMORY_MODEL_MESSAGE } from '@grunt/core/domain/memory.js';
import { openDatabase } from '@grunt/store-sqlite/db.js';
import { MIGRATIONS, runMigrations } from '@grunt/store-sqlite/migrations/index.js';
import { ProjectMemoryService } from '../src/memory/service.js';
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

  it('wires scheduled tasks: a run left running by the previous process is marked as an error at startup', async () => {
    const dbPath = join(dir, 'grunt.db');
    const secretsPath = join(dir, 'secrets.json');
    const first = await createContainer({ dbPath, secretsPath });
    first.store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
    first.store.profiles.create({ id: 'p1', name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null });
    first.store.projects.create({ id: 'proj', name: 'Alpha', workspace: null, defaultProfileId: null });
    first.store.schedules.create({ id: 's1', name: 'S', prompt: 'p', profileId: 'p1', target: { kind: 'project', projectId: 'proj' }, rule: { cadence: 'daily', time: '09:00' }, timezone: 'UTC', enabled: false, nextRunAt: null });
    first.store.schedules.addRun({ id: 'r1', scheduleId: 's1', trigger: 'manual', dueAt: null, startedAt: 1, status: 'running' });
    expect(first.schedules).toBeDefined();
    first.close();

    const second = await createContainer({ dbPath, secretsPath });
    expect(second.store.schedules.runs('s1')[0]).toMatchObject({ status: 'error', detail: 'Grunt stopped before this run finished.' });
    second.close();
  });

  it("puts Claude Code clean chats' scratch folders next to the database, or in a private temp folder for :memory:", async () => {
    const onDisk = await createContainer({ dbPath: join(dir, 'grunt.db'), secretsPath: join(dir, 'secrets.json') });
    expect(onDisk.claudeScratchRoot).toBe(join(dir, 'claude-scratch'));
    onDisk.close();
    const a = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json') });
    const b = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json') });
    expect(a.claudeScratchRoot!.startsWith(tmpdir())).toBe(true);
    expect(existsSync(a.claudeScratchRoot!)).toBe(true);
    expect(a.claudeScratchRoot).not.toBe(b.claudeScratchRoot);
    a.close();
    b.close();
  });

  it('wires project memory: a restart re-queues a project chat that went quiet while the server was down', async () => {
    const dbPath = join(dir, 'grunt.db');
    const secretsPath = join(dir, 'secrets.json');
    const old = Date.now() - 10 * 60_000;

    const first = await createContainer({ dbPath, secretsPath });
    try {
      expect(first.memory).toBeDefined();
      first.store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
      first.store.profiles.create({
        id: 'prof',
        name: 'Mock',
        description: null,
        colour: null,
        connectionId: 'conn',
        modelId: 'mock-standard',
        systemPrompt: null,
        params: {},
        toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
        isDefault: true,
        archivedAt: null,
      });
      first.store.projects.create({ id: 'proj', name: 'Alpha', workspaceRoot: null, defaultProfileId: null });
      first.store.chats.create({ id: 'chat', title: 'Chat', profileId: 'prof', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, projectId: 'proj' });
      first.store.messages.create({ id: 'u1', chatId: 'chat', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null, createdAt: old });
      first.store.messages.create({
        id: 'a1',
        chatId: 'chat',
        parentId: 'u1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hello' }],
        status: 'complete',
        error: null,
        producedBy: { profileId: 'prof', profileName: 'Mock', connectionId: 'conn', modelId: 'mock-standard' },
        createdAt: old + 1,
      });
      first.store.chats.update('chat', { headMessageId: 'u1' });
    } finally {
      first.close();
    }

    const second = await createContainer({ dbPath, secretsPath });
    try {
      await second.memory!.idle();
      // The only profile is the mock, which project memory never picks by
      // itself (it can't write a note), so the update fails for want of a
      // model -- which proves the startup sweep ran it.
      expect(second.memory!.lastError('proj')).toMatchObject({ chatId: 'chat', message: NO_MEMORY_MODEL_MESSAGE });
      expect(second.store.chats.get('chat')!.memoryCursor).toBeNull();
    } finally {
      second.close();
    }
  });

  // Task 32 fix round 2, Minor #2: a `:memory:` database's blob write root
  // is a fresh per-process temp directory (resolveAttachmentsRoots) that
  // nothing else will ever reuse -- without cleaning it up, it accumulates
  // forever under %TEMP%/$TMPDIR across every restart and every test run
  // (confirmed: 28 stray `grunt-attachments-*` directories already there
  // from exactly this, before this fix). Fails against 22cee46: the
  // directory survives `close()` there.
  it(':memory:\'s temp attachments directory is removed once the container is closed', async () => {
    const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json') });
    const tempRoot = container.blobStore.root;
    expect(tempRoot).toContain('grunt-attachments-');
    await expect(stat(tempRoot)).resolves.toBeTruthy();

    container.close();
    // close() removes it best-effort and unawaited (same fire-and-forget
    // pattern as toolProvider.shutdown()), so wait for it -- a fixed short
    // sleep was too tight on a busy machine.
    await vi.waitFor(() => expect(stat(tempRoot)).rejects.toThrow(), { timeout: 5_000, interval: 25 });
  });

  it('a real FILE database\'s attachments directory is NEVER removed on close -- it is the user\'s own attachment storage, not scratch', async () => {
    const dbPath = join(dir, 'grunt.db');
    const container = await createContainer({ dbPath, secretsPath: join(dir, 'secrets.json') });
    const writeRoot = container.blobStore.root;
    await container.blobStore.put(Buffer.from('a real user attachment'));

    container.close();
    await new Promise((r) => setTimeout(r, 50));

    await expect(stat(writeRoot)).resolves.toBeTruthy();
  });

  it(
    'reconciles a message left "streaming" by a previous process on startup, over a real reopened database -- ' +
      'simulates the process dying mid-turn (kill -9 / power loss / crash): the row is never cleanly closed, so ' +
      'nothing but the next process opening this same file can ever move it out of "streaming"',
    async () => {
      const dbPath = join(dir, 'grunt.db');
      const secretsPath = join(dir, 'secrets.json');

      // First "process": creates the referential chain a message needs, and
      // a row left mid-stream -- as if TurnRunner.runVariant was still
      // writing to it when this process died, with SOME partial content
      // already checkpointed.
      const first = await createContainer({ dbPath, secretsPath });
      first.store.connections.create({
        id: 'conn-1', name: 'Test', kind: 'mock', baseUrl: null, secretRef: null,
        extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null,
      });
      first.store.models.create({
        id: 'model-1', connectionId: 'conn-1', modelId: 'm', displayName: 'M', source: 'manual',
        supportsVision: false, supportsTools: false, supportsReasoning: false, contextWindow: null,
        maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
      });
      first.store.profiles.create({
        id: 'profile-1', name: 'P', description: null, colour: null, connectionId: 'conn-1', modelId: 'model-1',
        systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
        isDefault: false, archivedAt: null,
      });
      first.store.chats.create({ id: 'chat-1', profileId: 'profile-1', title: 'Chat', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
      first.store.messages.create({
        id: 'user-1', chatId: 'chat-1', parentId: null, role: 'user',
        parts: [{ type: 'text', text: 'hello' }], status: 'complete', error: null, producedBy: null,
      });
      first.store.messages.create({
        id: 'msg-orphaned', chatId: 'chat-1', parentId: 'user-1', role: 'assistant',
        parts: [{ type: 'text', text: 'partial answer before the crash' }],
        status: 'streaming', error: null, producedBy: null,
      });
      // No graceful shutdown call exists that would flush a terminal status
      // -- `close()` here only releases the file handle, exactly like a
      // crash would (kill -9 doesn't run any of this process's JS either).
      first.close();

      // Second "process": reopens the SAME database file.
      const second = await createContainer({ dbPath, secretsPath });
      try {
        const reconciled = second.store.messages.get('msg-orphaned');
        expect(reconciled?.status).toBe('error');
        expect(reconciled?.status).not.toBe('streaming');
        expect(reconciled?.error?.message.toLowerCase()).toContain('restart');
        // Partial content survives -- reconciliation never touches parts.
        expect(reconciled?.parts).toEqual([{ type: 'text', text: 'partial answer before the crash' }]);
      } finally {
        second.close();
      }
    }
  );

  it(
    'startup blob sweep (task 32 decision #2c): removes a pre-existing orphan blob, and leaves a still-referenced ' +
      'blob and a stray non-blob file completely alone -- over a real reopened database and a real on-disk BlobStore',
    async () => {
      const dbPath = join(dir, 'grunt.db');
      const secretsPath = join(dir, 'secrets.json');

      // First "process": seeds a referential chain, an attachment row that
      // legitimately references one blob, and writes a SECOND blob directly
      // via BlobStore with no attachment row at all -- simulating a blob
      // orphaned before this GC existed, or left behind by a crash between
      // a row delete and its (not-yet-existing) blob cleanup.
      const first = await createContainer({ dbPath, secretsPath });
      first.store.connections.create({
        id: 'conn-1', name: 'Test', kind: 'mock', baseUrl: null, secretRef: null,
        extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null,
      });
      first.store.models.create({
        id: 'model-1', connectionId: 'conn-1', modelId: 'm', displayName: 'M', source: 'manual',
        supportsVision: false, supportsTools: false, supportsReasoning: false, contextWindow: null,
        maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
      });
      first.store.profiles.create({
        id: 'profile-1', name: 'P', description: null, colour: null, connectionId: 'conn-1', modelId: 'model-1',
        systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
        isDefault: false, archivedAt: null,
      });
      first.store.chats.create({ id: 'chat-1', profileId: 'profile-1', title: 'Chat', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });

      const referencedBlob = await first.blobStore.put(Buffer.from('still referenced -- must survive'));
      first.store.attachments.create({
        id: 'att-referenced', chatId: 'chat-1', messageId: null, filename: 'keep.txt', mime: 'text/plain',
        size: referencedBlob.size, sha256: referencedBlob.sha256, storagePath: referencedBlob.path, extractedText: null,
      });

      const orphanBlob = await first.blobStore.put(Buffer.from('nobody references me any more'));
      // No attachment row for orphanBlob at all -- that's the orphan.

      // A stray, non-blob file sitting inside a real shard directory --
      // must never be treated as a delete candidate, no matter what.
      const strayShardDir = join(first.blobStore.root, referencedBlob.sha256.slice(0, 2));
      const strayPath = join(strayShardDir, 'not-a-blob.txt');
      await writeFile(strayPath, 'definitely not a content-addressed blob');

      first.close();

      // Second "process": reopens the SAME database (and therefore derives
      // the exact same per-database attachments root). Its startup sweep
      // runs before createContainer even returns.
      const second = await createContainer({ dbPath, secretsPath });
      try {
        await expect(stat(orphanBlob.path)).rejects.toThrow(); // swept away
        await expect(stat(referencedBlob.path)).resolves.toBeTruthy(); // untouched
        await expect(stat(strayPath)).resolves.toBeTruthy(); // untouched
      } finally {
        second.close();
      }
    }
  );

  it('startup blob sweep tolerates an attachments directory that does not exist yet (nothing has ever been uploaded)', async () => {
    const dbPath = join(dir, 'grunt.db');
    const secretsPath = join(dir, 'secrets.json');

    // A fresh database's derived write root never exists on disk yet.
    const container = await createContainer({ dbPath, secretsPath });
    container.close();
  });
});

describe('project memory on startup (final review)', () => {
  it('a throwing sweep() never stops the container being created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sweep = vi.spyOn(ProjectMemoryService.prototype, 'sweep').mockImplementation(() => {
      throw new Error('sweep exploded');
    });
    try {
      const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json') });
      expect(sweep).toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      container.close();
    } finally {
      sweep.mockRestore();
      warn.mockRestore();
    }
  });

  it('upgrading a v7 database queues nothing: old chats are not back-filled through the memory model', async () => {
    const dbPath = join(dir, 'v7.db');
    const secretsPath = join(dir, 'secrets.json');
    const old = Date.now() - 60 * 60_000;
    const raw = openDatabase(dbPath);
    runMigrations(raw, MIGRATIONS.filter((m) => m.version < 8));
    raw.exec(`INSERT INTO connection (id, name, kind) VALUES ('conn', 'Mock', 'mock')`);
    raw.exec(`INSERT INTO profile (id, name, connection_id, model_id, is_default) VALUES ('prof', 'Mock', 'conn', 'mock-standard', 1)`);
    raw.exec(`INSERT INTO project (id, name, created_at, updated_at) VALUES ('proj', 'Alpha', 1, 1)`);
    raw.exec(`INSERT INTO chat (id, title, profile_id, project_id, created_at, updated_at) VALUES ('chat', 'Old chat', 'prof', 'proj', 1, 1)`);
    raw.exec(`INSERT INTO message (id, chat_id, parent_id, role, parts, status, created_at) VALUES ('u1', 'chat', NULL, 'user', '[{"type":"text","text":"hi"}]', 'complete', ${old})`);
    raw.exec(`INSERT INTO message (id, chat_id, parent_id, role, parts, status, created_at) VALUES ('a1', 'chat', 'u1', 'assistant', '[{"type":"text","text":"hello"}]', 'complete', ${old + 1})`);
    raw.exec(`UPDATE chat SET head_message_id = 'u1' WHERE id = 'chat'`);
    raw.close();

    const container = await createContainer({ dbPath, secretsPath });
    try {
      expect(container.store.chats.get('chat')!.memoryCursor).toBe('a1');
      await container.memory!.idle();
      expect(container.memory!.lastError('proj')).toBeNull();
      expect(container.store.projectMemory.get('proj')).toBeNull();
    } finally {
      container.close();
    }
  });
});
