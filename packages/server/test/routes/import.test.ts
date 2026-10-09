import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_ROOT_PARENT } from '@grunt/core/domain/claude-import.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { Profile } from '@grunt/core/types/config.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { ClaudeImportService } from '../../src/import/claude-import.js';
import { MemoryQueue } from '../../src/memory/shared.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;
let dataDir: string;
let exportDir: string;
let store: InMemoryStore;

function makeProfile(over: Partial<Profile> & { id: string }): Profile {
  return {
    name: over.id,
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'model-1',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    ...over,
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'grunt-import-route-test-'));
  exportDir = join(dataDir, 'export');
  await mkdir(join(exportDir, 'conversations'), { recursive: true });
  await mkdir(join(dataDir, 'empty'));
  await writeFile(
    join(exportDir, 'conversations', 'conversations.json'),
    JSON.stringify([
      {
        uuid: 'c1',
        name: 'Garden plans',
        created_at: '2026-01-01T12:00:00Z',
        updated_at: '2026-01-01T12:05:00Z',
        chat_messages: [{ uuid: 'm1', sender: 'human', parent_message_uuid: CLAUDE_ROOT_PARENT, created_at: '2026-01-01T12:00:00Z', content: [{ type: 'text', text: 'hello' }], attachments: [], files: [] }],
      },
    ])
  );
  store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    claudeImport: new ClaudeImportService({
      store,
      engine,
      resolveProfile: async () => Promise.reject(new Error('no model in this test')),
      queue: new MemoryQueue(),
      importRoot: join(dataDir, 'imported', 'claude'),
    }),
    close: () => {},
  };
  store.connections.create({ id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create(makeProfile({ id: 'claude', name: 'Claude' }));
  store.profiles.create(makeProfile({ id: 'old', name: 'Old', archivedAt: 1 }));
});

afterEach(async () => {
  await container.claudeImport?.idle();
  await rm(dataDir, { recursive: true, force: true });
});

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    createApp(container).request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

describe('/api/import/claude', () => {
  it('GET is idle before any import', async () => {
    const res = await send('GET', '/api/import/claude');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'idle', report: null });
  });

  it('preview reads the folder and says what would happen', async () => {
    const res = await send('POST', '/api/import/claude/preview', { folder: exportDir, profileId: 'claude' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ folder: exportDir, chats: { total: 1, existing: 0, messages: 1 }, memoryModel: null });
  });

  it('preview and start answer 400 with a message for a bad folder or profile', async () => {
    for (const [path, body, message] of [
      ['/api/import/claude/preview', { folder: 7 }, '"folder"'],
      ['/api/import/claude/preview', {}, 'This machine has no Cowork sessions'],
      ['/api/import/claude/preview', { folder: join(dataDir, 'missing') }, "There's no folder"],
      ['/api/import/claude/preview', { folder: join(dataDir, 'empty') }, "There's no claude.ai export or Cowork session in"],
      ['/api/import/claude', { folder: exportDir }, '"profileId"'],
      ['/api/import/claude', { folder: exportDir, profileId: 'old' }, 'archived'],
      ['/api/import/claude', { folder: join(dataDir, 'empty'), profileId: 'claude' }, "There's no conversations.json"],
      ['/api/import/claude', { folder: exportDir, profileId: 'claude', spaces: ['space-1'] }, '"spaces" must be an object'],
      ['/api/import/claude', { folder: exportDir, profileId: 'claude', spaces: { 'space-1': 7 } }, '"spaces.space-1" must be a project id or null'],
      ['/api/import/claude', { folder: exportDir, profileId: 'claude', spaces: { 'space-1': 'no-such-project' } }, 'Project "no-such-project" not found'],
    ] as const) {
      const res = await send('POST', path, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(message);
    }
  });

  it('start answers 202, runs the import, and GET reports it', async () => {
    const res = await send('POST', '/api/import/claude', { folder: exportDir, profileId: 'claude', memory: false });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: 'running', total: 1 });
    await container.claudeImport!.idle();
    const done = (await (await send('GET', '/api/import/claude')).json()) as { state: string; report: { chats: { imported: number } } };
    expect(done.state).toBe('done');
    expect(done.report.chats.imported).toBe(1);
    expect(store.chats.get('c1')).toMatchObject({ title: 'Garden plans', profileId: 'claude' });
  });

  it('a second start while one is being set up answers 409', async () => {
    const first = send('POST', '/api/import/claude', { folder: exportDir, profileId: 'claude', memory: false });
    const second = await send('POST', '/api/import/claude', { folder: exportDir, profileId: 'claude', memory: false });
    expect([(await first).status, second.status].sort()).toEqual([202, 409]);
  });

  it('answers 503 on a server without the import', async () => {
    delete container.claudeImport;
    expect((await send('GET', '/api/import/claude')).status).toBe(503);
  });
});
