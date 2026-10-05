import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import type { Profile } from '@grunt/core/types/config.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const NATIVE_ABSOLUTE = process.platform === 'win32' ? 'C:\\Users\\Test\\project' : '/home/test/project';

let container: Container;
let dataDir: string;

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

// Same container shape as profiles.test.ts (a real temp-dir BlobStore, since
// DELETE /api/profiles/:id runs the real blob sweep).
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'grunt-projects-route-test-'));
  const store = new InMemoryStore();
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
    close: () => {},
  };
  container.store.connections.create({
    id: 'conn-1',
    name: 'Conn',
    kind: 'mock',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
  });
  container.store.profiles.create(makeProfile({ id: 'profile-1', isDefault: true }));
  container.store.profiles.create(makeProfile({ id: 'profile-old', archivedAt: 1 }));
});

afterEach(async () => {
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

function newProject(id: string, over: { name?: string; sortOrder?: number; workspaceRoot?: string | null; defaultProfileId?: string | null } = {}) {
  return container.store.projects.create({ id, name: over.name ?? id, workspaceRoot: over.workspaceRoot ?? null, defaultProfileId: over.defaultProfileId ?? null, ...(over.sortOrder === undefined ? {} : { sortOrder: over.sortOrder }) });
}

describe('POST /api/projects', () => {
  it('creates a project with a trimmed name, each new one after the existing ones', async () => {
    const first = await send('POST', '/api/projects', { name: '  Alpha  ' });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ name: 'Alpha', workspaceRoot: null, defaultProfileId: null, sortOrder: 0 });

    const second = await send('POST', '/api/projects', { name: 'Beta', workspaceRoot: NATIVE_ABSOLUTE, defaultProfileId: 'profile-1' });
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ name: 'Beta', workspaceRoot: NATIVE_ABSOLUTE, defaultProfileId: 'profile-1', sortOrder: 1 });
  });

  it('accepts an 80-character name', async () => {
    const res = await send('POST', '/api/projects', { name: 'x'.repeat(80) });
    expect(res.status).toBe(201);
  });

  it('allows two projects with the same name (spec §5)', async () => {
    expect((await send('POST', '/api/projects', { name: 'Same' })).status).toBe(201);
    expect((await send('POST', '/api/projects', { name: 'Same' })).status).toBe(201);
    expect(container.store.projects.list().map((p) => p.name)).toEqual(['Same', 'Same']);
  });

  it.each([
    ['a missing name', {}],
    ['a blank name', { name: '   ' }],
    ['an 81-character name', { name: 'x'.repeat(81) }],
    ['a non-string name', { name: 7 }],
    ['a relative workspaceRoot', { name: 'A', workspaceRoot: 'demo-workspace' }],
    ['a blank workspaceRoot', { name: 'A', workspaceRoot: '   ' }],
    ['an unknown defaultProfileId', { name: 'A', defaultProfileId: 'no-such-profile' }],
    ['an archived defaultProfileId', { name: 'A', defaultProfileId: 'profile-old' }],
  ])('rejects %s with 400 and creates nothing', async (_label, body) => {
    const res = await send('POST', '/api/projects', body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0);
    expect(container.store.projects.list()).toEqual([]);
  });
});

describe('GET /api/projects', () => {
  it('lists projects by sortOrder, then name', async () => {
    newProject('b', { name: 'beta', sortOrder: 1 });
    newProject('a', { name: 'Alpha', sortOrder: 1 });
    newProject('z', { name: 'Zed', sortOrder: 0 });

    const res = await send('GET', '/api/projects');

    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }[]).map((p) => p.id)).toEqual(['z', 'a', 'b']);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('updates name, folder, default profile and sortOrder, and clears folder and profile with null', async () => {
    newProject('p1');

    const res = await send('PATCH', '/api/projects/p1', { name: ' Renamed ', workspaceRoot: NATIVE_ABSOLUTE, defaultProfileId: 'profile-1', sortOrder: 4 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Renamed', workspaceRoot: NATIVE_ABSOLUTE, defaultProfileId: 'profile-1', sortOrder: 4 });

    const cleared = await send('PATCH', '/api/projects/p1', { workspaceRoot: null, defaultProfileId: null });
    expect(await cleared.json()).toMatchObject({ name: 'Renamed', workspaceRoot: null, defaultProfileId: null, sortOrder: 4 });
  });

  it('404s for an unknown project', async () => {
    expect((await send('PATCH', '/api/projects/nope', { name: 'x' })).status).toBe(404);
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a fractional sortOrder', { sortOrder: 1.5 }],
    ['a string sortOrder', { sortOrder: '2' }],
    ['a path-escape workspaceRoot', { workspaceRoot: '../..' }],
    ['an archived defaultProfileId', { defaultProfileId: 'profile-old' }],
  ])('rejects %s with 400 and changes nothing', async (_label, body) => {
    const before = newProject('p1', { name: 'Keep', workspaceRoot: NATIVE_ABSOLUTE });

    const res = await send('PATCH', '/api/projects/p1', { name: 'Should not apply', ...body });

    expect(res.status).toBe(400);
    expect(container.store.projects.get('p1')).toEqual(before);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('204s and moves its chats to no project without deleting them or touching their folder', async () => {
    newProject('p1');
    container.store.chats.create({ id: 'c1', title: 'T', profileId: 'profile-1', headMessageId: null, workspaceRoot: NATIVE_ABSOLUTE, pinned: false, archivedAt: null, projectId: 'p1' });

    const res = await send('DELETE', '/api/projects/p1');

    expect(res.status).toBe(204);
    expect(container.store.projects.get('p1')).toBeNull();
    expect(container.store.chats.get('c1')).toMatchObject({ projectId: null, workspace: { kind: 'machine', root: NATIVE_ABSOLUTE } });
  });

  it('404s for an unknown project', async () => {
    expect((await send('DELETE', '/api/projects/nope')).status).toBe(404);
  });
});

describe("a project's default profile", () => {
  it('is cleared on every project when that profile is archived', async () => {
    container.store.profiles.create(makeProfile({ id: 'profile-2' }));
    newProject('p1', { defaultProfileId: 'profile-2' });
    newProject('p2', { defaultProfileId: 'profile-1' });

    const res = await send('PATCH', '/api/profiles/profile-2', { archivedAt: 123 });

    expect(res.status).toBe(200);
    expect(container.store.projects.get('p1')!.defaultProfileId).toBeNull();
    expect(container.store.projects.get('p2')!.defaultProfileId).toBe('profile-1');
  });

  it('is cleared when that profile is deleted', async () => {
    container.store.profiles.create(makeProfile({ id: 'profile-2' }));
    newProject('p1', { defaultProfileId: 'profile-2' });

    expect((await send('DELETE', '/api/profiles/profile-2')).status).toBe(204);

    expect(container.store.projects.get('p1')!.defaultProfileId).toBeNull();
  });
});
