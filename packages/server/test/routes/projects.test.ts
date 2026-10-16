import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@otherbench/core/testing/fakes.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
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
  dataDir = await mkdtemp(join(tmpdir(), 'otherbench-projects-route-test-'));
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

  it("sets the folders every chat in it can use, shown resolved, and refuses the project's own folder", async () => {
    newProject('p1', { workspaceRoot: NATIVE_ABSOLUTE });
    const self = container.store.nodes.self().id;

    const res = await send('PATCH', '/api/projects/p1', { folders: [{ path: dataDir, access: 'readwrite' }] });
    expect(res.status).toBe(200);
    const folder = { workspace: { kind: 'machine', nodeId: self, root: dataDir }, access: 'readwrite' };
    expect(await res.json()).toMatchObject({ folders: [folder], folderViews: [{ ...folder, root: dataDir, status: { status: 'ok', root: dataDir } }] });

    const same = await send('PATCH', '/api/projects/p1', { folders: [{ path: NATIVE_ABSOLUTE, access: 'read' }] });
    expect(same.status).toBe(400);
    expect(container.store.projects.get('p1')!.folders).toEqual([folder]);

    const cleared = await send('PATCH', '/api/projects/p1', { folders: [] });
    expect(((await cleared.json()) as { folders?: unknown }).folders ?? []).toEqual([]);
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

describe('the project page fields', () => {
  it('POST creates a project with description, instructions and other folders in one request', async () => {
    const res = await send('POST', '/api/projects', {
      name: 'OtherBench',
      description: '  Local workbench  ',
      instructions: 'British English.\nBe brief.',
      workspaceRoot: NATIVE_ABSOLUTE,
      folders: [{ path: dataDir, access: 'read' }],
    });
    expect(res.status).toBe(201);
    const self = container.store.nodes.self().id;
    expect(await res.json()).toMatchObject({
      name: 'OtherBench',
      description: 'Local workbench',
      instructions: 'British English.\nBe brief.',
      workspaceRoot: NATIVE_ABSOLUTE,
      folders: [{ workspace: { kind: 'machine', nodeId: self, root: dataDir }, access: 'read' }],
    });
  });

  it('POST defaults description and instructions to empty, and accepts the longest of each', async () => {
    expect(await (await send('POST', '/api/projects', { name: 'Plain' })).json()).toMatchObject({ description: '', instructions: '' });
    const longest = await send('POST', '/api/projects', { name: 'Full', description: 'd'.repeat(500), instructions: 'i'.repeat(8_000) });
    expect(longest.status).toBe(201);
  });

  it.each([
    ['a 501-character description', { name: 'A', description: 'x'.repeat(501) }],
    ['8,001 characters of instructions', { name: 'A', instructions: 'x'.repeat(8_001) }],
    ['a non-string description', { name: 'A', description: 5 }],
    ['non-string instructions', { name: 'A', instructions: ['x'] }],
    ['a relative other folder', { name: 'A', folders: [{ path: 'relative', access: 'read' }] }],
    ['an other folder without access', { name: 'A', folders: [{ path: NATIVE_ABSOLUTE }] }],
    ["the project's own folder as an other folder", { name: 'A', workspaceRoot: NATIVE_ABSOLUTE, folders: [{ path: NATIVE_ABSOLUTE, access: 'read' }] }],
  ])('POST rejects %s with 400 and creates nothing', async (_label, body) => {
    const res = await send('POST', '/api/projects', body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0);
    expect(container.store.projects.list()).toEqual([]);
  });

  it('PATCH updates description and instructions and leaves the rest alone', async () => {
    newProject('p1', { name: 'Keep', workspaceRoot: NATIVE_ABSOLUTE });

    const res = await send('PATCH', '/api/projects/p1', { description: 'Now described', instructions: 'Be terse.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Keep', workspaceRoot: NATIVE_ABSOLUTE, description: 'Now described', instructions: 'Be terse.' });

    const cleared = await send('PATCH', '/api/projects/p1', { instructions: '' });
    expect(await cleared.json()).toMatchObject({ description: 'Now described', instructions: '' });
  });

  it.each([
    ['8,001 characters of instructions', { instructions: 'x'.repeat(8_001) }],
    ['a null description', { description: null }],
  ])('PATCH rejects %s with 400 and changes nothing', async (_label, body) => {
    const before = newProject('p1', { name: 'Keep' });
    const res = await send('PATCH', '/api/projects/p1', { name: 'Should not apply', ...body });
    expect(res.status).toBe(400);
    expect(container.store.projects.get('p1')).toEqual(before);
  });
});

describe('sub-projects (spec 2026-10-15-sub-projects-design §2)', () => {
  const nest = (id: string, parentId: string) => container.store.projects.create({ id, name: id, workspaceRoot: null, defaultProfileId: null, parentId });

  it('creates a project under a top-level parent, and moves one under and back out', async () => {
    newProject('top');
    newProject('loose');
    const created = await send('POST', '/api/projects', { name: 'Desktop', parentId: 'top' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: 'Desktop', parentId: 'top' });

    const moved = await send('PATCH', '/api/projects/loose', { parentId: 'top' });
    expect(moved.status).toBe(200);
    expect(container.store.projects.get('loose')?.parentId).toBe('top');
    expect((await send('PATCH', '/api/projects/loose', { parentId: null })).status).toBe(200);
    expect(container.store.projects.get('loose')?.parentId).toBeNull();
  });

  it.each([
    ['an unknown parent', 'nope', /not found/],
    ['a sub-project as parent', 'sub', /can't have sub-projects/],
  ])('refuses %s on create', async (_label, parentId, message) => {
    newProject('top');
    nest('sub', 'top');
    const res = await send('POST', '/api/projects', { name: 'X', parentId });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(message);
    expect(container.store.projects.list()).toHaveLength(2);
  });

  it('refuses a project as its own parent, and moving a project that has sub-projects', async () => {
    newProject('top');
    newProject('other');
    nest('sub', 'top');
    const self = await send('PATCH', '/api/projects/other', { parentId: 'other' });
    expect(self.status).toBe(400);
    expect(((await self.json()) as { error: string }).error).toMatch(/its own parent/);
    const withChildren = await send('PATCH', '/api/projects/top', { parentId: 'other' });
    expect(withChildren.status).toBe(400);
    expect(((await withChildren.json()) as { error: string }).error).toMatch(/has sub-projects|with sub-projects/);
    expect(container.store.projects.get('top')?.parentId).toBeNull();
  });

  it('deleting a parent leaves its sub-projects at the top level', async () => {
    newProject('top');
    nest('sub', 'top');
    expect((await send('DELETE', '/api/projects/top')).status).toBe(204);
    expect(container.store.projects.get('sub')?.parentId).toBeNull();
  });
});
