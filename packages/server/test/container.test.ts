import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPUTER_SCREEN_ABOUT } from '@grunt/core/domain/computer-apps.js';
import { NO_MEMORY_MODEL_MESSAGE } from '@grunt/core/domain/memory.js';
import { encodeHlc } from '@grunt/core/domain/hlc.js';
import type { SaveToolImage } from '@grunt/core/domain/tool-images.js';
import { FAKE_PNG, FakeComputerDriver } from '@grunt/core/testing/fake-computer.js';
import { openDatabase } from '@grunt/store-sqlite/db.js';
import { MIGRATIONS, runMigrations } from '@grunt/store-sqlite/migrations/index.js';
import { COMPUTER_NO_SCREENSHOT_REASON } from '@grunt/tools/computer-tool.js';
import { createApp } from '../src/app.js';
import { ComputerSessions } from '../src/computer/sessions.js';
import { ProjectMemoryService } from '../src/memory/service.js';
import { createContainer, loopbackPortsFromEnv, resolveSecretsPassphrase, withoutOwnPorts, type Container } from '../src/container.js';

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

describe('loopbackPortsFromEnv', () => {
  it('reads comma-separated ports and drops anything that is not one', () => {
    expect(loopbackPortsFromEnv(undefined)).toEqual([]);
    expect(loopbackPortsFromEnv('')).toEqual([]);
    expect(loopbackPortsFromEnv('4766, 5000,abc,0,70000,12.5')).toEqual([4766, 5000]);
    expect(loopbackPortsFromEnv('0x1F90,1e3,+80,-80, ,8080')).toEqual([8080]);
  });
});

describe('withoutOwnPorts', () => {
  it("drops Grunt's own API and peer ports, and says which", () => {
    expect(withoutOwnPorts([4797, 4796, 4748], [4796, 4748])).toEqual({ ports: [4797], dropped: [4796, 4748] });
    expect(withoutOwnPorts([4797], [undefined, 0])).toEqual({ ports: [4797], dropped: [] });
  });
});

describe('createContainer', () => {
  it("leaves Grunt's own ports out of GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS, with a warning", async () => {
    const before = process.env['GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS'];
    process.env['GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS'] = '4797,4796,4790';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json'), apiPort: 4796, peerPort: 4790 });
      container.close();
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toContainEqual(expect.stringContaining("names Grunt's own port(s) 4796, 4790"));
      expect(lines).toContainEqual(expect.stringContaining('may reach 127.0.0.1 on port(s) 4797. This is for tests only.'));
    } finally {
      warn.mockRestore();
      if (before === undefined) delete process.env['GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS'];
      else process.env['GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS'] = before;
    }
  });

  it("makes the model's browser (nothing launches until a call) and closes it with the container", async () => {
    const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json') });
    expect(container.browser).toBeDefined();
    expect(container.browser!.state('no-such-chat')).toMatchObject({ open: false });
    const closeAll = vi.spyOn(container.browser!, 'closeAll');
    container.close();
    expect(closeAll).toHaveBeenCalledTimes(1);
  });

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

describe('computer use wiring', () => {
  const on = { fs: 'off' as const, shell: false, mcpServerIds: [], approvalMode: 'always_ask' as const, computer: true };
  const off = { fs: 'off' as const, shell: false, mcpServerIds: [], approvalMode: 'always_ask' as const };
  const names = async (container: Container, policy: typeof on | typeof off): Promise<string[]> => (await container.toolProvider.listTools(policy)).map((t) => t.name);
  const open = (computer?: FakeComputerDriver): Promise<Container> =>
    createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json'), ...(computer ? { computer } : {}) });

  beforeEach(() => {
    delete process.env['GRUNT_COMPUTER_FAKE_DRIVER'];
  });
  afterEach(() => {
    delete process.env['GRUNT_COMPUTER_FAKE_DRIVER'];
  });

  it('offers no computer tool without a driver, even to a profile that turns it on', async () => {
    const container = await open();
    try {
      expect(container.computer).toBeUndefined();
      expect(await names(container, on)).not.toContain('computer');
      // Nor to Claude Code, whose tools are listed apart.
      const relayed = (container.toolProvider as unknown as { relayGruntTools: (policy: typeof on) => { name: string }[] }).relayGruntTools(on);
      expect(relayed.map((t) => t.name)).not.toContain('computer');
    } finally {
      container.close();
    }
  });

  it('offers it with a driver, only to a profile that turns it on, and only while the driver can carry it out', async () => {
    const driver = new FakeComputerDriver();
    const container = await open(driver);
    try {
      expect(container.computer?.available()).toBe(true);
      expect(await names(container, on)).toContain('computer');
      expect(await names(container, off)).not.toContain('computer');
      expect(await names(container, { ...off, computer: false })).not.toContain('computer');
      driver.isAvailable = false;
      expect(container.computer?.available()).toBe(false);
      expect(await names(container, on)).not.toContain('computer');
      // Listing the tool starts nothing.
      expect(driver.started).toEqual([]);
    } finally {
      container.close();
    }
  });

  it('wires the fake driver for tests when GRUNT_COMPUTER_FAKE_DRIVER=1, and for no other value', async () => {
    for (const value of ['0', 'true', 'yes', '']) {
      process.env['GRUNT_COMPUTER_FAKE_DRIVER'] = value;
      const container = await open();
      try {
        expect(container.computer, JSON.stringify(value)).toBeUndefined();
        expect(await names(container, on), JSON.stringify(value)).not.toContain('computer');
      } finally {
        container.close();
      }
    }
    process.env['GRUNT_COMPUTER_FAKE_DRIVER'] = '1';
    // It says so at startup (the next test); kept out of this run's output.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = await open();
    try {
      expect(await names(container, on)).toContain('computer');
      expect(await names(container, off)).not.toContain('computer');
      expect(container.computer?.available()).toBe(true);
    } finally {
      container.close();
      warn.mockRestore();
    }
  });

  it('says so at startup when the fake driver is wired, and only then', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const about = (): string[] => warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('GRUNT_COMPUTER_FAKE_DRIVER'));
    try {
      (await open()).close();
      (await open(new FakeComputerDriver())).close();
      process.env['GRUNT_COMPUTER_FAKE_DRIVER'] = '0';
      (await open()).close();
      expect(about()).toEqual([]);
      process.env['GRUNT_COMPUTER_FAKE_DRIVER'] = '1';
      (await open()).close();
      expect(about()).toEqual([
        '[grunt-server] GRUNT_COMPUTER_FAKE_DRIVER is set: computer use is carried out by a fake driver that touches nothing on this machine. This is for tests only.',
      ]);
      // A real driver handed in wins, and then there is nothing to warn about.
      warn.mockClear();
      (await open(new FakeComputerDriver())).close();
      expect(about()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  /** A profile, and for each chat id a chat with one reply `<chat>-reply`. */
  function seed(container: Container, ...chatIds: string[]): void {
    container.store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
    container.store.profiles.create({
      id: 'prof', name: 'P', description: null, colour: null, connectionId: 'conn', modelId: 'mock-standard', systemPrompt: null, params: {},
      toolPolicy: on, isDefault: false, archivedAt: null,
    });
    for (const id of chatIds) {
      container.store.chats.create({ id, title: `Chat ${id}`, profileId: 'prof', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
      container.store.messages.create({ id: `${id}-reply`, chatId: id, parentId: null, role: 'assistant', parts: [], status: 'streaming', error: null, producedBy: null });
    }
  }
  const ctxFor = (chatId: string) => ({ chatId, messageId: `${chatId}-reply`, profileId: 'prof', workspaceRoot: null, signal: new AbortController().signal });

  it('puts the control sessions between the tool and the driver: one chat at a time, announced on the app-wide stream', async () => {
    const driver = new FakeComputerDriver();
    const container = await open(driver);
    try {
      seed(container, 'c1', 'c2');
      expect(container.computer).toBeInstanceOf(ComputerSessions);
      const tool = (await container.toolProvider.listTools(on)).find((t) => t.name === 'computer')!;
      // The tool's own call starts the session through the sessions, which announce it.
      expect(await tool.execute({ action: 'screenshot' }, ctxFor('c1'))).toMatchObject([{ type: 'text', text: COMPUTER_SCREEN_ABOUT }, { type: 'text' }, { type: 'image', mimeType: 'image/png' }]);
      expect(container.computer!.activeChat()).toBe('c1');
      expect(container.events!.computerSessions()).toEqual([{ chatId: 'c1' }]);
      // A second chat's tool call is refused by them: the driver is never asked, so no second dialog.
      const second = (await tool.execute({ action: 'screenshot' }, ctxFor('c2'))) as { error: boolean; message: string };
      expect(second).toMatchObject({ error: true });
      expect(second.message).toContain('Another chat is controlling this computer. Stop it first.');
      expect(driver.started).toEqual([{ chatId: 'c1', chatTitle: 'Chat c1' }]);
    } finally {
      container.close();
    }
  });

  it("Stop cancels the chat's reply through the runner, and the tool forgets that chat's last screenshot", async () => {
    const driver = new FakeComputerDriver();
    const container = await open(driver);
    try {
      seed(container, 'c1');
      const tool = (await container.toolProvider.listTools(on)).find((t) => t.name === 'computer')!;
      await tool.execute({ action: 'screenshot' }, ctxFor('c1'));
      const cancel = vi.spyOn(container.turnRunner, 'cancel');
      container.events!.emit({ type: 'turn-started', chatId: 'c1', messageIds: ['c1-reply'] });

      await container.computer!.stop('c1');

      expect(cancel).toHaveBeenCalledWith('c1-reply');
      expect(driver.ended).toEqual(['c1']);
      expect(container.events!.computerSessions()).toEqual([]);
      // The tool heard the server's own stop: a point in the old screenshot is refused before anything is started.
      const click = (await tool.execute({ action: 'left_click', coordinate: [10, 20] }, ctxFor('c1'))) as { error: boolean; message: string };
      expect(click.message).toContain(COMPUTER_NO_SCREENSHOT_REASON);
      expect(driver.started).toHaveLength(1);
      expect(driver.targets).toEqual([]);
    } finally {
      container.close();
    }
  });

  it('ends a session left without a reply, and ends the one in control when the server closes', async () => {
    const driver = new FakeComputerDriver();
    const container = await open(driver);
    let closed = false;
    try {
      seed(container, 'c1');
      const stopped: string[] = [];
      container.computer!.onStopped((chatId, why) => stopped.push(`${chatId}:${why}`));
      // Started and never used, and the chat's reply is over: nobody is watching it.
      await container.computer!.ensureSession('c1', 'One');
      container.events!.emit({ type: 'turn-finished', chatId: 'c1', messageId: 'm1', status: 'cancelled' });
      expect(driver.ended).toEqual(['c1']);
      expect(container.computer!.activeChat()).toBeNull();
      // One in use is the chat's until the server closes.
      await container.computer!.ensureSession('c1', 'One');
      await container.computer!.screenshot('c1');
      container.events!.emit({ type: 'turn-finished', chatId: 'c1', messageId: 'm2', status: 'complete' });
      expect(container.computer!.activeChat()).toBe('c1');
      closed = true;
      container.close();
      expect(driver.ended).toEqual(['c1', 'c1']);
      expect(driver.hasSession('c1')).toBe(false);
      expect(stopped).toEqual(['c1:button', 'c1:quit']);
    } finally {
      if (!closed) container.close();
    }
  });

  /**
   * Two profiles on two connections, a chat on each. `c1` is in control with a
   * session it has used and a reply the app-wide stream knows is running.
   */
  async function inControl(driver: FakeComputerDriver): Promise<{ container: Container; cancel: ReturnType<typeof vi.spyOn> }> {
    const container = await open(driver);
    for (const n of ['1', '2']) {
      container.store.connections.create({ id: `conn${n}`, name: `Mock ${n}`, kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
      container.store.profiles.create({
        id: `prof${n}`, name: `P${n}`, description: null, colour: null, connectionId: `conn${n}`, modelId: 'mock-standard', systemPrompt: null, params: {},
        toolPolicy: on, isDefault: false, archivedAt: null,
      });
      container.store.chats.create({ id: `c${n}`, title: `Chat c${n}`, profileId: `prof${n}`, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    }
    container.store.messages.create({ id: 'c1-reply', chatId: 'c1', parentId: null, role: 'assistant', parts: [], status: 'streaming', error: null, producedBy: null });
    container.events!.emit({ type: 'turn-started', chatId: 'c1', messageIds: ['c1-reply'] });
    await container.computer!.ensureSession('c1', 'Chat c1');
    await container.computer!.screenshot('c1');
    return { container, cancel: vi.spyOn(container.turnRunner, 'cancel') };
  }

  /** The session ended on the driver, the reply was cancelled, and another chat can start with a dialog of its own. */
  async function expectStoppedAndFree(container: Container, driver: FakeComputerDriver, cancel: ReturnType<typeof vi.spyOn>): Promise<void> {
    expect(container.store.chats.get('c1')).toBeNull();
    await vi.waitFor(() => expect(driver.ended).toEqual(['c1']));
    expect(driver.hasSession('c1')).toBe(false);
    expect(container.computer!.activeChat()).toBeNull();
    expect(container.events!.computerSessions()).toEqual([]);
    expect(cancel).toHaveBeenCalledWith('c1-reply');
    expect(await container.computer!.ensureSession('c2', 'Chat c2')).toEqual({ ok: true });
    expect(driver.started.map((s) => s.chatId)).toEqual(['c1', 'c2']);
  }

  it("deleting the profile of the chat in control ends its session and cancels its reply", async () => {
    const driver = new FakeComputerDriver();
    const { container, cancel } = await inControl(driver);
    try {
      expect((await createApp(container).request('/api/profiles/prof1', { method: 'DELETE' })).status).toBe(204);
      await expectStoppedAndFree(container, driver, cancel);
    } finally {
      container.close();
    }
  });

  it("deleting the connection of the chat in control ends its session and cancels its reply", async () => {
    const driver = new FakeComputerDriver();
    const { container, cancel } = await inControl(driver);
    try {
      expect((await createApp(container).request('/api/connections/conn1', { method: 'DELETE' })).status).toBe(204);
      await expectStoppedAndFree(container, driver, cancel);
    } finally {
      container.close();
    }
  });

  it('deleting another profile or connection leaves the chat in control alone', async () => {
    const driver = new FakeComputerDriver();
    const { container, cancel } = await inControl(driver);
    try {
      expect((await createApp(container).request('/api/profiles/prof2', { method: 'DELETE' })).status).toBe(204);
      expect((await createApp(container).request('/api/connections/conn2', { method: 'DELETE' })).status).toBe(204);
      expect(container.computer!.activeChat()).toBe('c1');
      expect(driver.ended).toEqual([]);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      container.close();
    }
  });

  it("a delete of the chat in control that arrives from a paired machine ends its session and cancels its reply", async () => {
    const driver = new FakeComputerDriver();
    const { container, cancel } = await inControl(driver);
    try {
      // What the syncer does with a peer's changes: apply them, then say so on the app-wide stream.
      const result = container.store.sync!.apply([{ tbl: 'chat', id: 'c1', op: 'delete', hlc: encodeHlc(Date.now() + 60_000, 0, 'another-machine') }]);
      expect(result.applied).toBe(1);
      container.events!.emit({ type: 'sync-applied', nodeId: 'another-machine', changed: result.applied });
      await expectStoppedAndFree(container, driver, cancel);
    } finally {
      container.close();
    }
  });

  it("a chat deleted through the store by anything ends its session", async () => {
    const driver = new FakeComputerDriver();
    const { container, cancel } = await inControl(driver);
    try {
      container.store.chats.delete('c1');
      await expectStoppedAndFree(container, driver, cancel);
    } finally {
      container.close();
    }
  });

  it("a chat that went with nobody saying so is caught by the next start: its session is ended first", async () => {
    const driver = new FakeComputerDriver();
    const { container, cancel } = await inControl(driver);
    try {
      // A cascade inside the database, past every route and every event.
      container.store.profiles.delete('prof1');
      expect(container.computer!.activeChat()).toBe('c1');
      expect(await container.computer!.ensureSession('c2', 'Chat c2')).toEqual({ ok: true });
      expect(driver.ended).toEqual(['c1']);
      expect(cancel).toHaveBeenCalledWith('c1-reply');
      expect(driver.started.map((s) => s.chatId)).toEqual(['c1', 'c2']);
    } finally {
      container.close();
    }
  });

  it("gives the turn runner a saver that keeps a tool's image in this database and its blob store", async () => {
    const container = await open();
    try {
      container.store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
      container.store.profiles.create({
        id: 'prof', name: 'P', description: null, colour: null, connectionId: 'conn', modelId: 'mock-standard', systemPrompt: null, params: {},
        toolPolicy: off, isDefault: false, archivedAt: null,
      });
      container.store.chats.create({ id: 'chat', title: 'Chat', profileId: 'prof', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
      container.store.messages.create({ id: 'reply', chatId: 'chat', parentId: null, role: 'assistant', parts: [], status: 'streaming', error: null, producedBy: null });
      // The runner keeps its options to itself; this reads the one the container gave it.
      const save = (container.turnRunner as unknown as { saveToolImage?: SaveToolImage }).saveToolImage;
      expect(save).toBeTypeOf('function');
      const id = await save!('chat', 'reply', FAKE_PNG, 'image/png');
      const row = container.store.attachments.get(id)!;
      expect(row).toMatchObject({ chatId: 'chat', messageId: 'reply', mime: 'image/png', size: FAKE_PNG.length, filename: 'tool-image.png' });
      expect(await container.blobStore.get(row.sha256)).toEqual(FAKE_PNG);
    } finally {
      container.close();
    }
  });
});
