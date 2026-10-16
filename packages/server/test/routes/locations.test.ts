import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@otherbench/core/testing/fakes.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { AppEventBus, withChatEvents } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { eventView } from '../../src/workspace-view.js';

let container: Container;
let store: InMemoryStore;
let engine: FakeChatEngine;
let dataDir: string;
/** A real folder standing in for this machine's Nextcloud, with a `phd` folder in it. */
let nextcloud: string;
let events: AppEvent[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'otherbench-locations-route-test-'));
  nextcloud = join(dataDir, 'Nextcloud');
  await mkdir(join(nextcloud, 'phd'), { recursive: true });
  store = new InMemoryStore('node-pc');
  engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  const bus = new AppEventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  container = {
    // Announcing chat changes, as createContainer's store does.
    store: withChatEvents(store, bus),
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    events: bus,
    close: () => {},
  };
  store.connections.create({ id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.models.create({
    id: 'model-1', connectionId: 'conn-1', modelId: 'm', displayName: 'M', source: 'manual', supportsVision: false, supportsTools: false,
    supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  store.profiles.create({
    id: 'profile-1', name: 'P', description: null, colour: null, connectionId: 'conn-1', modelId: 'model-1', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
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

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createNextcloud(): Promise<string> {
  const res = await send('POST', '/api/locations', { name: 'Nextcloud', path: nextcloud });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

describe('/api/locations', () => {
  it("creates a location with this machine's path, lists every machine's paths, and renames it", async () => {
    const id = await createNextcloud();
    store.locations.setPath({ locationId: id, nodeId: 'node-laptop', path: 'C:\\Users\\Adam\\Nextcloud' });

    const list = await json<unknown[]>(await send('GET', '/api/locations'));
    expect(list).toEqual([
      {
        id,
        name: 'Nextcloud',
        paths: expect.arrayContaining([
          { locationId: id, nodeId: 'node-pc', path: nextcloud },
          { locationId: id, nodeId: 'node-laptop', path: 'C:\\Users\\Adam\\Nextcloud' },
        ]),
      },
    ]);

    expect(await json(await send('PATCH', `/api/locations/${id}`, { name: '  Cloud  ' }))).toMatchObject({ name: 'Cloud' });
    expect((await send('PATCH', `/api/locations/${id}`, { name: '' })).status).toBe(400);
    expect((await send('POST', '/api/locations', { name: 'Bad', path: 'relative/path' })).status).toBe(400);
    expect((await send('PATCH', '/api/locations/nope', { name: 'x' })).status).toBe(404);
  });

  it('refuses a second location with the same name, ignoring case, when adding or renaming', async () => {
    await createNextcloud();
    const again = await send('POST', '/api/locations', { name: 'nextcloud', path: dataDir });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("already a location called Nextcloud");
    const git = await json<{ id: string }>(await send('POST', '/api/locations', { name: 'Git' }));
    expect((await send('PATCH', `/api/locations/${git.id}`, { name: 'NEXTCLOUD' })).status).toBe(409);
    expect((await send('PATCH', `/api/locations/${git.id}`, { name: 'git' })).status).toBe(200);
    expect(store.locations.list()).toHaveLength(2);
  });

  it("PUT path sets or removes only this machine's path, and re-announces the chats in the location", async () => {
    const id = await createNextcloud();
    const chat = await json<Chat>(await send('POST', '/api/chats', { profileId: 'profile-1', workspacePath: join(nextcloud, 'phd') }));
    events.length = 0;

    expect((await send('PUT', `/api/locations/${id}/path`, { path: null })).status).toBe(200);
    expect(store.locations.paths(id)).toEqual([]);
    expect(events).toEqual([{ type: 'chat-updated', chat: expect.objectContaining({ id: chat.id }) }]);

    const res = await send('PUT', `/api/locations/${id}/path`, { path: nextcloud });
    expect(await json(res)).toMatchObject({ paths: [{ nodeId: 'node-pc', path: nextcloud }] });
    expect((await send('PUT', `/api/locations/${id}/path`, {})).status).toBe(400);
  });

  it('DELETE keeps the chats in it, without a folder, and announces them', async () => {
    const id = await createNextcloud();
    const chat = await json<Chat>(await send('POST', '/api/chats', { profileId: 'profile-1', workspacePath: join(nextcloud, 'phd') }));
    events.length = 0;

    expect((await send('DELETE', `/api/locations/${id}`)).status).toBe(204);
    expect(store.chats.get(chat.id)!.workspace).toBeNull();
    expect(events).toEqual([{ type: 'chat-updated', chat: expect.objectContaining({ id: chat.id, workspace: null }) }]);
    expect((await send('DELETE', `/api/locations/${id}`)).status).toBe(404);
  });
});

describe('inferring and adopting a location from another machine', () => {
  const PC_GIT = 'E:\\Git';

  function pcChat(id: string, root: string): void {
    store.chats.create({ id, title: id, profileId: 'profile-1', headMessageId: null, workspace: { kind: 'machine', nodeId: 'node-laptop', root }, pinned: false, archivedAt: null });
  }

  it('infer suggests the shared location and counts what adopting it would move', async () => {
    pcChat('a', 'E:\\Git\\OtherBench');
    pcChat('b', 'E:\\Git\\Other\\src');
    pcChat('c', 'E:\\Nextcloud\\x');
    const here = join(dataDir, 'Git', 'OtherBench');

    const res = await json(await send('POST', '/api/locations/infer', { nodeId: 'node-laptop', fromPath: 'E:\\Git\\OtherBench', toPath: here }));

    expect(res).toEqual({ mapping: { fromRoot: PC_GIT, toRoot: join(dataDir, 'Git'), tail: ['OtherBench'], name: 'Git' }, existing: null, affected: 2 });
    expect(await json(await send('POST', '/api/locations/infer', { nodeId: 'node-laptop', fromPath: 'E:\\Git\\OtherBench', toPath: join(dataDir, 'Elsewhere') }))).toEqual({
      mapping: null,
      existing: null,
      affected: 0,
    });
  });

  it("infer finds a location that already has either machine's root", async () => {
    store.locations.create({ id: 'git', name: 'Git' });
    store.locations.setPath({ locationId: 'git', nodeId: 'node-laptop', path: 'e:\\git' });
    const res = await json(await send('POST', '/api/locations/infer', { nodeId: 'node-laptop', fromPath: 'E:\\Git\\OtherBench', toPath: join(dataDir, 'Git', 'OtherBench') }));
    expect(res).toMatchObject({ existing: { id: 'git', name: 'Git' } });
  });

  it("adopt creates the location with both machines' roots and moves exactly the chats and projects under the other machine's root", async () => {
    pcChat('a', 'E:\\Git\\OtherBench');
    pcChat('b', 'E:\\Gitlab\\x');
    store.chats.create({ id: 'mine', title: 'm', profileId: 'profile-1', headMessageId: null, workspace: { kind: 'machine', nodeId: 'node-pc', root: 'E:\\Git\\OtherBench' }, pinned: false, archivedAt: null });
    store.projects.create({ id: 'proj', name: 'P', workspace: { kind: 'machine', nodeId: 'node-laptop', root: PC_GIT }, defaultProfileId: null });
    const toRoot = join(dataDir, 'Git');
    await mkdir(join(toRoot, 'OtherBench'), { recursive: true });
    events.length = 0;

    const res = await send('POST', '/api/locations/adopt', { name: 'Git', nodeId: 'node-laptop', fromRoot: PC_GIT, toRoot });

    expect(res.status).toBe(201);
    const { location, converted } = await json<{ location: { id: string; paths: unknown[] }; converted: number }>(res);
    expect(converted).toBe(2);
    expect(location.paths).toEqual(expect.arrayContaining([
      { locationId: location.id, nodeId: 'node-pc', path: toRoot },
      { locationId: location.id, nodeId: 'node-laptop', path: PC_GIT },
    ]));
    expect(store.chats.get('a')!.workspace).toEqual({ kind: 'location', locationId: location.id, subpath: 'OtherBench' });
    expect(store.chats.get('b')!.workspace).toEqual({ kind: 'machine', nodeId: 'node-laptop', root: 'E:\\Gitlab\\x' });
    expect(store.chats.get('mine')!.workspace).toEqual({ kind: 'machine', nodeId: 'node-pc', root: 'E:\\Git\\OtherBench' });
    expect(store.projects.get('proj')!.workspace).toEqual({ kind: 'location', locationId: location.id, subpath: '' });
    expect(await json(await send('GET', '/api/chats/a'))).toMatchObject({ workspaceStatus: { status: 'ok', root: join(toRoot, 'OtherBench') } });
    expect(events.filter((e) => e.type === 'chat-updated').map((e) => (e as { chat: Chat }).chat.id)).toEqual(['a']);
  });

  it("adopt refuses this machine as the other one, and needs a native root here", async () => {
    expect((await send('POST', '/api/locations/adopt', { name: 'Git', nodeId: 'node-pc', fromRoot: PC_GIT, toRoot: dataDir })).status).toBe(400);
    expect((await send('POST', '/api/locations/adopt', { name: 'Git', nodeId: 'node-laptop', fromRoot: PC_GIT, toRoot: 'relative' })).status).toBe(400);
    expect((await send('POST', '/api/locations/adopt', { locationId: 'nope', nodeId: 'node-laptop', fromRoot: PC_GIT, toRoot: dataDir })).status).toBe(404);
  });
});

describe('/api/node', () => {
  it("returns and renames this machine", async () => {
    expect(await json(await send('GET', '/api/node'))).toEqual({ id: 'node-pc', name: 'This machine' });
    expect(await json(await send('PATCH', '/api/node', { name: 'PC' }))).toEqual({ id: 'node-pc', name: 'PC' });
    expect((await send('PATCH', '/api/node', { name: ' ' })).status).toBe(400);
  });
});

describe('chat folders', () => {
  it('a folder inside a location is stored relative to it, and the API shows where it is on this machine', async () => {
    const id = await createNextcloud();
    const created = await json<Chat>(await send('POST', '/api/chats', { profileId: 'profile-1', workspacePath: join(nextcloud, 'phd') }));

    expect(store.chats.get(created.id)!.workspace).toEqual({ kind: 'location', locationId: id, subpath: 'phd' });
    expect(created).toMatchObject({ workspaceRoot: join(nextcloud, 'phd'), workspaceStatus: { status: 'ok', root: join(nextcloud, 'phd') } });
    expect(await json(await send('GET', `/api/chats/${created.id}`))).toMatchObject({ workspaceRoot: join(nextcloud, 'phd') });
    const list = await json<Chat[]>(await send('GET', '/api/chats'));
    expect(list[0]).toMatchObject({ workspaceRoot: join(nextcloud, 'phd'), runsOn: 'node-pc' });
  });

  it("the older workspaceRoot field still works, and a folder outside every location is bound to this machine", async () => {
    const created = await json<Chat>(await send('POST', '/api/chats', { profileId: 'profile-1', workspaceRoot: dataDir }));
    expect(store.chats.get(created.id)!.workspace).toEqual({ kind: 'machine', nodeId: 'node-pc', root: dataDir });

    const patched = await json<Chat>(await send('PATCH', `/api/chats/${created.id}`, { workspace: null }));
    expect(patched).toMatchObject({ workspace: null, workspaceRoot: null, workspaceStatus: { status: 'none' } });
    expect((await send('PATCH', `/api/chats/${created.id}`, { workspace: { kind: 'machine', nodeId: 'x', root: '/' } })).status).toBe(400);
  });

  it("another machine's folder, or a location with no path here, shows as unresolved with no folder", async () => {
    store.locations.create({ id: 'git', name: 'Git' });
    store.locations.setPath({ locationId: 'git', nodeId: 'node-laptop', path: '/home/adam/git' });
    store.chats.create({ id: 'remote', title: 'T', profileId: 'profile-1', headMessageId: null, workspace: { kind: 'machine', nodeId: 'node-laptop', root: '/home/adam/x' }, pinned: false, archivedAt: null });
    store.chats.create({ id: 'nopath', title: 'T', profileId: 'profile-1', headMessageId: null, workspace: { kind: 'location', locationId: 'git', subpath: 'otherbench' }, pinned: false, archivedAt: null });

    expect(await json(await send('GET', '/api/chats/remote'))).toMatchObject({
      workspaceRoot: null,
      workspaceStatus: { status: 'unresolved', reason: 'other-machine', hint: { nodeId: 'node-laptop', path: '/home/adam/x' } },
    });
    expect(await json(await send('GET', '/api/chats/nopath'))).toMatchObject({
      workspaceRoot: null,
      workspaceStatus: { status: 'unresolved', reason: 'no-location-path', hint: { nodeId: 'node-laptop', path: '/home/adam/git/otherbench' } },
    });
  });

  it("a folder that's gone still shows its path, marked missing", async () => {
    const gone = join(dataDir, 'gone');
    const created = await json<Chat>(await send('POST', '/api/chats', { profileId: 'profile-1', workspacePath: gone }));
    expect(created).toMatchObject({ workspaceRoot: gone, workspaceStatus: { status: 'unresolved', reason: 'missing' } });
  });

  it("a chat started in a project copies the project's folder as stored, so it resolves on any machine with the location", async () => {
    const id = await createNextcloud();
    const project = await json<{ id: string; workspaceRoot: string }>(await send('POST', '/api/projects', { name: 'PhD', workspacePath: join(nextcloud, 'phd') }));
    expect(project.workspaceRoot).toBe(join(nextcloud, 'phd'));
    expect(store.projects.get(project.id)!.workspace).toEqual({ kind: 'location', locationId: id, subpath: 'phd' });

    const chat = await json<Chat>(await send('POST', '/api/chats', { projectId: project.id }));
    expect(store.chats.get(chat.id)!.workspace).toEqual({ kind: 'location', locationId: id, subpath: 'phd' });
    const noFolder = await json<Chat>(await send('POST', '/api/chats', { projectId: project.id, workspace: null }));
    expect(store.chats.get(noFolder.id)!.workspace).toBeNull();
  });

  it('chat events carry the same view as the API', () => {
    const chat = store.chats.create({ id: 'c', title: 'T', profileId: 'profile-1', headMessageId: null, workspace: { kind: 'machine', nodeId: 'node-pc', root: dataDir }, pinned: false, archivedAt: null });
    expect(eventView(container, { type: 'chat-updated', chat })).toMatchObject({ chat: { workspaceRoot: dataDir, workspaceStatus: { status: 'ok' } } });
    expect(eventView(container, { type: 'chat-deleted', chatId: 'c' })).toEqual({ type: 'chat-deleted', chatId: 'c' });
  });
});

describe('turns in a chat whose folder does not resolve here', () => {
  it('409 workspace_unresolved before anything is written or sent to the model', async () => {
    store.chats.create({ id: 'remote', title: 'T', profileId: 'profile-1', headMessageId: null, workspace: { kind: 'machine', nodeId: 'node-laptop', root: '/x' }, pinned: false, archivedAt: null });

    const res = await send('POST', '/api/chats/remote/turns', { parts: [{ type: 'text', text: 'hi' }], profileIds: ['profile-1'] });

    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ kind: 'workspace_unresolved', workspaceStatus: { reason: 'other-machine' }, error: expect.stringContaining('another machine') });
    expect(store.messages.roots('remote')).toEqual([]);
    expect(engine.requests).toEqual([]);
    expect((await send('POST', '/api/chats/remote/regenerate', { messageId: 'm' })).status).toBe(409);
  });
});
