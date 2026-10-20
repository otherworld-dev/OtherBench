import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore } from '@otherbench/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { subscribeAutoTitle } from '../../src/routes/chats.js';
import { StreamRegistry } from '../../src/stream/registry.js';

// ---------------------------------------------------------------------------
// A hand-controllable ChatEngine, keyed by EngineRequest.messageId -- same
// technique as turns.test.ts, needed here to interleave the main turn's
// completion with the *separate* engine call auto-title makes afterwards.
// ---------------------------------------------------------------------------

function manualEngine(): {
  engine: ChatEngine;
  push: (messageId: string, event: EngineEvent | null) => void;
  requests: EngineRequest[];
} {
  interface Channel {
    queued: (EngineEvent | null)[];
    waiters: ((event: EngineEvent | null) => void)[];
  }
  const channels = new Map<string, Channel>();
  const requests: EngineRequest[] = [];

  function channelFor(messageId: string): Channel {
    let ch = channels.get(messageId);
    if (!ch) {
      ch = { queued: [], waiters: [] };
      channels.set(messageId, ch);
    }
    return ch;
  }

  const engine: ChatEngine = {
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      requests.push(req);
      const ch = channelFor(req.messageId);
      while (true) {
        if (req.signal.aborted) return;
        const event = await new Promise<EngineEvent | null>((resolve) => {
          if (ch.queued.length > 0) {
            resolve(ch.queued.shift() as EngineEvent | null);
            return;
          }
          const onAbort = () => resolve(null);
          req.signal.addEventListener('abort', onAbort, { once: true });
          ch.waiters.push((e) => {
            req.signal.removeEventListener('abort', onAbort);
            resolve(e);
          });
        });
        if (event === null) return;
        if (req.signal.aborted) return;
        yield event;
        if (event.type === 'finish' && hangAfterFinish && req.purpose === 'utility') {
          // Like Claude Code: the stream lingers after `finish` until aborted.
          await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }));
          return;
        }
        if (event.type === 'finish' || event.type === 'error') return;
      }
    },
    async listModels() {
      return [];
    },
    async testConnection() {
      return { ok: true, message: 'ok', latencyMs: 0 };
    },
  };

  function push(messageId: string, event: EngineEvent | null): void {
    const ch = channelFor(messageId);
    const waiter = ch.waiters.shift();
    if (waiter) waiter(event);
    else ch.queued.push(event);
  }

  return { engine, push, requests };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const FINISH: EngineEvent = {
  type: 'finish',
  usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 },
  finishReason: 'stop',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let container: Container;
let push: (messageId: string, event: EngineEvent | null) => void;
let requests: EngineRequest[];
let dataDir: string;
/** When set, the manual engine keeps a utility (title) stream open after yielding `finish` until its signal aborts. */
let hangAfterFinish = false;

// A REAL, temp-dir-backed BlobStore -- not a `{} as never` placeholder.
// DELETE /api/chats/:id now runs the real blob-GC sweep after every delete
// (task 32), which used to be swallowed into a silent no-op by ANY thrown
// error, including a TypeError from a mis-wired blobStore like a bare `{}`.
// That's fixed now (blob-gc.ts's `isFilesystemError` only swallows real
// filesystem errors), which means a `{}` stub would make every DELETE test
// below 500 instead of exercising anything real -- a real BlobStore is what
// makes this suite actually catch a wiring regression instead of quietly
// tolerating one (task 32 fix round 1, Minor #8).
beforeEach(async () => {
  hangAfterFinish = false;
  dataDir = await mkdtemp(join(tmpdir(), 'otherbench-chats-route-test-'));
  const store = new InMemoryStore();
  const manual = manualEngine();
  push = manual.push;
  requests = manual.requests;
  const turnRunner = new TurnRunner(store, manual.engine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine: manual.engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    close: () => {},
  };
  subscribeAutoTitle(container);

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
  container.store.profiles.create({
    id: 'profile-1',
    name: 'Profile One',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'model-1',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function app() {
  return createApp(container);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function createChat(profileId = 'profile-1', title?: string): Promise<Record<string, unknown>> {
  const res = await app().request('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, ...(title !== undefined ? { title } : {}) }),
  });
  return json(res);
}

async function postTurn(chatId: string, profileIds: string[], text = 'Hello there'): Promise<{ userMessageId: string; assistantMessageIds: string[] }> {
  const res = await app().request(`/api/chats/${chatId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text }], profileIds }),
  });
  return (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };
}

// ---------------------------------------------------------------------------
// CRUD, rename, pin, archive, delete
// ---------------------------------------------------------------------------

describe('chats CRUD', () => {
  it('creates a chat with a default title when none is given', async () => {
    const body = await createChat();
    expect(body['id']).toBeTruthy();
    expect(body['title']).toBe('New Chat');
    expect(body['profileId']).toBe('profile-1');
    expect(body['pinned']).toBe(false);
    expect(body['archivedAt']).toBeNull();
    expect(body['headMessageId']).toBeNull();
  });

  it('404s creation for an unknown profileId', async () => {
    const res = await app().request('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'no-such-profile' }),
    });
    expect(res.status).toBe(404);
  });

  it('lists and gets chats', async () => {
    const created = await createChat();
    const listRes = await app().request('/api/chats');
    const list = (await listRes.json()) as Record<string, unknown>[];
    expect(list.map((c) => c['id'])).toContain(created['id']);

    const getRes = await app().request(`/api/chats/${created['id'] as string}`);
    expect(getRes.status).toBe(200);
  });

  it('404s get/patch/delete for an unknown chat', async () => {
    expect((await app().request('/api/chats/nope')).status).toBe(404);
    expect(
      (
        await app().request('/api/chats/nope', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'x' }),
        })
      ).status
    ).toBe(404);
    expect((await app().request('/api/chats/nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('renames via PATCH title', async () => {
    const created = await createChat();
    const res = await app().request(`/api/chats/${created['id'] as string}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed Chat' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res))['title']).toBe('Renamed Chat');
  });

  it('pins and unpins via PATCH pinned', async () => {
    const created = await createChat();
    const id = created['id'] as string;

    const pinRes = await app().request(`/api/chats/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    expect((await json(pinRes))['pinned']).toBe(true);

    const unpinRes = await app().request(`/api/chats/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    });
    expect((await json(unpinRes))['pinned']).toBe(false);
  });

  it('archives and unarchives via PATCH archivedAt', async () => {
    const created = await createChat();
    const id = created['id'] as string;

    const archiveRes = await app().request(`/api/chats/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archivedAt: Date.now() }),
    });
    expect((await json(archiveRes))['archivedAt']).not.toBeNull();

    const unarchiveRes = await app().request(`/api/chats/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archivedAt: null }),
    });
    expect((await json(unarchiveRes))['archivedAt']).toBeNull();
  });

  it('starts a new chat with Auto on, unless the request says otherwise', async () => {
    expect((await createChat())['autoMode']).toBe(true);
    const off = await json(await app().request('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: 'profile-1', autoMode: false }) }));
    expect(off['autoMode']).toBe(false);
  });

  it('turns auto mode on and off via PATCH autoMode, without moving the chat in the list', async () => {
    const created = await createChat();
    const id = created['id'] as string;
    await app().request(`/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoMode: false }) });
    const before = container.store.chats.get(id)!.updatedAt;

    const on = await app().request(`/api/chats/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoMode: true }),
    });
    expect(on.status).toBe(200);
    const onBody = await json(on);
    expect(onBody['autoMode']).toBe(true);
    // ChatList sorts by updatedAt; flipping a setting is not chat activity.
    expect(onBody['updatedAt']).toBe(before);
    expect((await json(await app().request(`/api/chats/${id}`)))['autoMode']).toBe(true);

    const off = await app().request(`/api/chats/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoMode: false }),
    });
    expect((await json(off))['autoMode']).toBe(false);
  });

  it('turns plan mode on and off via PATCH planMode, without moving the chat in the list, and refuses a non-boolean', async () => {
    const created = await createChat();
    const id = created['id'] as string;
    expect(created['planMode']).toBe(false);
    const before = container.store.chats.get(id)!.updatedAt;
    const on = await app().request(`/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planMode: true }) });
    expect(on.status).toBe(200);
    const onBody = await json(on);
    expect(onBody['planMode']).toBe(true);
    expect(onBody['updatedAt']).toBe(before);
    const bad = await app().request(`/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planMode: 'yes' }) });
    expect(bad.status).toBe(400);
    expect(container.store.chats.get(id)!.planMode).toBe(true);
  });

  it('rejects a non-boolean autoMode with 400 and leaves the chat unchanged', async () => {
    const created = await createChat();
    const id = created['id'] as string;
    for (const bad of ['yes', 1, null]) {
      const res = await app().request(`/api/chats/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoMode: bad }),
      });
      expect(res.status).toBe(400);
      expect((await json(res))['error']).toBe('"autoMode" must be a boolean.');
    }
    expect(container.store.chats.get(id)!.autoMode).toBe(true);
  });

  it('sets extra folders by path (stored against a location when inside one), keeps ones it has, and refuses the rest', async () => {
    const id = (await createChat())['id'] as string;
    const before = container.store.chats.get(id)!.updatedAt;
    const self = container.store.nodes.self().id;
    const nc = join(dataDir, 'Nextcloud');
    const scratch = join(dataDir, 'scratch');
    mkdirSync(join(nc, 'refs'), { recursive: true });
    mkdirSync(scratch, { recursive: true });
    container.store.locations.create({ id: 'nc', name: 'Nextcloud' });
    container.store.locations.setPath({ locationId: 'nc', nodeId: self, path: nc });
    const patch = (body: unknown) =>
      app().request(`/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const refs = { kind: 'location', locationId: 'nc', subpath: 'refs' };

    const set = await json(await patch({ folders: [{ path: join(nc, 'refs'), access: 'read' }, { path: scratch, access: 'readwrite' }] }));
    expect(set['folders']).toEqual([
      { workspace: refs, access: 'read' },
      { workspace: { kind: 'machine', nodeId: self, root: scratch }, access: 'readwrite' },
    ]);
    expect(set['folderViews']).toEqual([
      { workspace: refs, access: 'read', root: join(nc, 'refs'), status: { status: 'ok', root: join(nc, 'refs') } },
      { workspace: { kind: 'machine', nodeId: self, root: scratch }, access: 'readwrite', root: scratch, status: { status: 'ok', root: scratch } },
    ]);
    // Setting folders is configuration, not chat activity.
    expect(set['updatedAt']).toBe(before);

    // One it already has can be kept by its stored form (here with new access); the other is dropped.
    const kept = await json(await patch({ folders: [{ workspace: refs, access: 'readwrite' }] }));
    expect(kept['folders']).toEqual([{ workspace: refs, access: 'readwrite' }]);

    const refused: [unknown, string][] = [
      [{ folders: [{ workspace: { kind: 'machine', nodeId: 'elsewhere', root: scratch }, access: 'read' }] }, 'name one of the folders it already has'],
      [{ folders: [{ path: scratch, access: 'admin' }] }, '"read" or "readwrite"'],
      [{ folders: 'refs' }, 'must be a list'],
      [{ folders: Array.from({ length: 11 }, () => ({ path: scratch, access: 'read' })) }, 'at most 10'],
    ];
    for (const [body, message] of refused) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(String((await json(res))['error'])).toContain(message);
    }
    expect(container.store.chats.get(id)!.folders).toEqual([{ workspace: refs, access: 'readwrite' }]);

    // The workspace itself isn't an extra folder.
    await patch({ workspacePath: scratch });
    const same = await patch({ folders: [{ path: scratch, access: 'read' }] });
    expect(same.status).toBe(400);
    expect(String((await json(same))['error'])).toContain('workspace folder itself');
  });

  it('sets and clears the effort via PATCH effort, without moving the chat in the list, and refuses an unknown level', async () => {
    const created = await createChat();
    const id = created['id'] as string;
    expect(created['effort']).toBeUndefined();
    const before = container.store.chats.get(id)!.updatedAt;
    const patch = (body: unknown) =>
      app().request(`/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const set = await patch({ effort: 'high' });
    expect(set.status).toBe(200);
    const setBody = await json(set);
    expect(setBody['effort']).toBe('high');
    expect(setBody['updatedAt']).toBe(before);
    expect((await json(await app().request(`/api/chats/${id}`)))['effort']).toBe('high');

    for (const bad of ['extreme', 3, true]) {
      const res = await patch({ effort: bad });
      expect(res.status).toBe(400);
      expect((await json(res))['error']).toBe('"effort" must be null or one of low, medium, high, xhigh, max.');
    }
    expect(container.store.chats.get(id)!.effort).toBe('high');

    // Cleared: absent or null, both meaning "follow Claude Code's settings".
    expect((await json(await patch({ effort: null })))['effort'] ?? null).toBeNull();
    expect(container.store.chats.get(id)!.effort ?? null).toBeNull();
  });

  it('ignores headMessageId in the generic PATCH body (moving it stays POST /:id/head only)', async () => {
    const created = await createChat();
    const res = await app().request(`/api/chats/${created['id'] as string}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headMessageId: 'some-message' }),
    });
    // Silently ignored, not an error -- headMessageId simply isn't a field this route accepts.
    expect(res.status).toBe(200);
    expect((await json(res))['headMessageId']).toBeNull();
  });

  it('deletes a chat', async () => {
    const created = await createChat();
    const id = created['id'] as string;
    const res = await app().request(`/api/chats/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await app().request(`/api/chats/${id}`)).status).toBe(404);
  });

  it("deletes a clean Claude Code chat's scratch folder with it, and doesn't mind when there is none", async () => {
    container.claudeScratchRoot = join(dataDir, 'claude-scratch');
    const id = (await createChat())['id'] as string;
    const folder = join(container.claudeScratchRoot, id);
    await mkdir(join(folder, 'inner'), { recursive: true });
    expect((await app().request(`/api/chats/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(existsSync(folder)).toBe(false);
    const other = (await createChat())['id'] as string;
    expect((await app().request(`/api/chats/${other}`, { method: 'DELETE' })).status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// workspaceRoot validation (server-side backstop -- Finding 4). `containPath`
// (packages/core/src/domain/paths.ts) resolves a non-absolute root relative
// to the SERVER's own cwd rather than erroring, so an unvalidated relative
// or blank value here becomes a real, silently-wrong containment boundary
// for every fs/shell tool call in that chat. The client's own validator
// (Inspector.tsx's validateWorkspaceRoot) is not a substitute -- these go
// straight at the route, bypassing it entirely, the way a direct API call
// would.
// ---------------------------------------------------------------------------

describe('workspaceRoot validation', () => {
  const NATIVE_ABSOLUTE = process.platform === 'win32' ? 'C:\\Users\\Test\\project' : '/home/test/project';

  it('rejects a bare relative-looking workspaceRoot on create', async () => {
    const res = await app().request('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'profile-1', workspaceRoot: 'demo-workspace' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a path-escape attempt ("../..") on create', async () => {
    const res = await app().request('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'profile-1', workspaceRoot: '../..' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a whitespace-only workspaceRoot on create', async () => {
    const res = await app().request('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'profile-1', workspaceRoot: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts a genuine native absolute path on create', async () => {
    const res = await app().request('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'profile-1', workspaceRoot: NATIVE_ABSOLUTE }),
    });
    expect(res.status).toBe(201);
    expect((await json(res))['workspaceRoot']).toBe(NATIVE_ABSOLUTE);
  });

  it('still allows omitting workspaceRoot entirely, and explicitly clearing it with null', async () => {
    const created = await createChat();
    expect(created['workspaceRoot']).toBeNull();

    const res = await app().request(`/api/chats/${created['id'] as string}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: null }),
    });
    expect(res.status).toBe(200);
    expect((await json(res))['workspaceRoot']).toBeNull();
  });

  it('rejects an invalid workspaceRoot on PATCH too, not just create', async () => {
    const created = await createChat();
    const res = await app().request(`/api/chats/${created['id'] as string}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: '../..' }),
    });
    expect(res.status).toBe(400);
    // Nothing was written -- the chat still has no folder.
    expect(container.store.chats.get(created['id'] as string)?.workspace).toBeNull();
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects a Git-Bash-mangled Windows path ("/c/Users/Adam/project") with an actionable message, on a Windows server',
    async () => {
      const res = await app().request('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'profile-1', workspaceRoot: '/c/Users/Adam/project' }),
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(String(body['error'])).toMatch(/git-bash/i);
      expect(String(body['error'])).toMatch(/C:\\/);
      // Never silently discarded to a bare "Bad Request" -- see app.test.ts's onError regression test.
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a Windows-style absolute path on a non-Windows server (it is not a native absolute POSIX path)',
    async () => {
      const res = await app().request('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'profile-1', workspaceRoot: 'E:\\Git\\OtherBench' }),
      });
      expect(res.status).toBe(400);
    }
  );
});

// ---------------------------------------------------------------------------
// GET /:id/messages
// ---------------------------------------------------------------------------

describe('GET /api/chats/:id/export (#820)', () => {
  async function seeded(): Promise<string> {
    const chatId = (await createChat())['id'] as string;
    container.store.chats.update(chatId, { title: 'Trip: plans/ideas' });
    container.store.messages.create({ id: 'u-1', chatId, parentId: null, role: 'user', parts: [{ type: 'text', text: 'Where to?' }], status: 'complete', error: null, producedBy: null });
    container.store.messages.create({
      id: 'a-1', chatId, parentId: 'u-1', role: 'assistant', parts: [{ type: 'text', text: 'Lisbon.' }], status: 'complete', error: null,
      producedBy: { profileId: 'profile-1', profileName: 'Profile One', connectionId: 'conn-1', modelId: 'model-1' },
    });
    container.store.chats.update(chatId, { headMessageId: 'a-1' });
    return chatId;
  }

  it('downloads the shown conversation as Markdown by default, named after the chat', async () => {
    const chatId = await seeded();
    const res = await app().request(`/api/chats/${chatId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="Trip- plans-ideas.md"');
    const text = await res.text();
    expect(text).toContain('# Trip: plans/ideas');
    expect(text).toContain('## You\n\nWhere to?');
    expect(text).toContain('## Profile One (model-1)\n\nLisbon.');
  });

  it('downloads the whole tree as JSON with format=json', async () => {
    const chatId = await seeded();
    const res = await app().request(`/api/chats/${chatId}/export?format=json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain('filename="Trip- plans-ideas.json"');
    const body = (await res.json()) as { format: string; shownPath: string[]; messages: { id: string }[]; chat: { id: string } };
    expect(body.format).toBe('otherbench-chat-export');
    expect(body.chat.id).toBe(chatId);
    expect(body.shownPath).toEqual(['u-1', 'a-1']);
    expect(body.messages.map((m) => m.id)).toEqual(['u-1', 'a-1']);
  });

  it('400s for an unknown format and 404s for an unknown chat', async () => {
    const chatId = await seeded();
    const bad = await app().request(`/api/chats/${chatId}/export?format=pdf`);
    expect(bad.status).toBe(400);
    expect((await json(bad))['error']).toBe('"format" must be "markdown" or "json".');
    expect((await app().request('/api/chats/nope/export')).status).toBe(404);
  });
});

describe('GET /api/chats/:id/messages', () => {
  it('returns the full message tree plus headMessageId, including sibling variants', async () => {
    const created = await createChat();
    const chatId = created['id'] as string;
    container.store.profiles.create({
      id: 'profile-2',
      name: 'Profile Two',
      description: null,
      colour: null,
      connectionId: 'conn-1',
      modelId: 'model-1',
      systemPrompt: null,
      params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
      isDefault: false,
      archivedAt: null,
    });

    const { userMessageId, assistantMessageIds } = await postTurn(chatId, ['profile-1', 'profile-2']);

    const res = await app().request(`/api/chats/${chatId}/messages`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { messages: { id: string }[]; headMessageId: string | null };

    // Posting a turn moves the head to its user message (the compare turn stays unresolved).
    expect(body.headMessageId).toBe(userMessageId);
    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain(userMessageId);
    for (const id of assistantMessageIds) expect(ids).toContain(id);
    expect(body.messages).toHaveLength(1 + assistantMessageIds.length);
  });

  it("returns each reply's recorded usage by message id, with the price snapshot it ran at (#819)", async () => {
    const chatId = (await createChat())['id'] as string;
    container.store.messages.create({ id: 'u-1', chatId, parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    container.store.messages.create({ id: 'a-1', chatId, parentId: 'u-1', role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null });
    const pricingSnapshot = { priceInPer1m: 3, priceOutPer1m: 15, priceCachedPer1m: null, currency: 'USD' };
    container.store.usage.create({
      id: 'usage-1', chatId, messageId: 'a-1', profileId: 'profile-1', connectionId: 'conn-1', modelId: 'model-1',
      tokensIn: 100, tokensOut: 50, tokensCached: 10, tokensReasoning: 5, costEstimate: 0.00105, pricingSnapshot, latencyMs: 1234,
    });

    const body = (await json(await app().request(`/api/chats/${chatId}/messages`))) as { usage: Record<string, unknown> };
    expect(body.usage).toEqual({
      'a-1': { tokensIn: 100, tokensOut: 50, tokensCached: 10, tokensReasoning: 5, pricingSnapshot, latencyMs: 1234 },
    });
  });

  it("keeps a reply's own cost in the usage map: a sub-agent's row never replaces it", async () => {
    const chatId = (await createChat())['id'] as string;
    container.store.messages.create({ id: 'u-1', chatId, parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    container.store.messages.create({ id: 'a-1', chatId, parentId: 'u-1', role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null });
    const pricingSnapshot = { priceInPer1m: 3, priceOutPer1m: 15, priceCachedPer1m: null, currency: 'USD' };
    const row = { chatId, messageId: 'a-1', profileId: 'profile-1', connectionId: 'conn-1', modelId: 'model-1', tokensCached: 0, tokensReasoning: 0, costEstimate: null, pricingSnapshot, latencyMs: 5 };
    container.store.usage.create({ ...row, id: 'own', tokensIn: 100, tokensOut: 50 });
    container.store.usage.create({ ...row, id: 'sub', tokensIn: 9, tokensOut: 9, subagentCallId: 'call-1' });

    const body = (await json(await app().request(`/api/chats/${chatId}/messages`))) as { usage: Record<string, { tokensIn: number }> };
    expect(body.usage['a-1']?.tokensIn).toBe(100);
  });

  it('404s for an unknown chat', async () => {
    const res = await app().request('/api/chats/nope/messages');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/search
// ---------------------------------------------------------------------------

describe('GET /api/search', () => {
  it('finds a message by its text content', async () => {
    const created = await createChat();
    const chatId = created['id'] as string;
    const { assistantMessageIds } = await postTurn(chatId, ['profile-1'], 'Tell me about giraffes');
    push(assistantMessageIds[0] as string, { type: 'text-delta', text: 'Giraffes are tall herbivores.' });
    push(assistantMessageIds[0] as string, FINISH);
    await flush();

    const res = await app().request('/api/search?q=giraffes');
    expect(res.status).toBe(200);
    const results = (await res.json()) as { messageId: string; chatId: string; snippet: string }[];
    expect(results.some((r) => r.chatId === chatId)).toBe(true);
  });

  it('400s when q is missing', async () => {
    const res = await app().request('/api/search');
    expect(res.status).toBe(400);
  });

  it('with scope=chats, lists a matching chat once however many of its messages match', async () => {
    const created = await createChat();
    const chatId = created['id'] as string;
    for (const prompt of ['okapi one', 'okapi two', 'okapi three']) {
      const { assistantMessageIds } = await postTurn(chatId, ['profile-1'], prompt);
      push(assistantMessageIds[0] as string, FINISH);
      await flush();
    }

    const res = await app().request('/api/search?q=okapi&scope=chats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ chatId }]);
  });

  it('400s on an unknown scope', async () => {
    const res = await app().request('/api/search?q=x&scope=everything');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Auto-title
// ---------------------------------------------------------------------------

describe('auto-title', () => {
  it("leaves alone the title of a chat a scheduled run made", async () => {
    const created = await createChat();
    const chatId = created['id'] as string;
    container.store.projects.create({ id: 'proj-s', name: 'Sched', workspace: null, defaultProfileId: null });
    container.store.schedules.create({
      id: 'sched', name: 'Weekly', prompt: 'p', profileId: 'profile-1', target: { kind: 'project', projectId: 'proj-s' },
      rule: { cadence: 'daily', time: '09:00' }, timezone: 'UTC', enabled: false, nextRunAt: null,
    });
    container.store.schedules.addRun({ id: 'run', scheduleId: 'sched', trigger: 'manual', dueAt: null, startedAt: 1, status: 'running', chatId, createdChat: true });
    const titleBefore = container.store.chats.get(chatId)!.title;

    const { assistantMessageIds } = await postTurn(chatId, ['profile-1'], 'hello');
    push(assistantMessageIds[0] as string, FINISH);
    await flush();

    expect(requests.filter((r) => r.messageId !== assistantMessageIds[0])).toEqual([]);
    expect(container.store.chats.get(chatId)!.title).toBe(titleBefore);
  });

  it('generates a title from the same profile after the first assistant message completes', async () => {
    const created = await createChat();
    const chatId = created['id'] as string;
    const { assistantMessageIds } = await postTurn(chatId, ['profile-1'], 'What is the capital of France?');
    const mainMessageId = assistantMessageIds[0] as string;

    push(mainMessageId, { type: 'text-delta', text: 'Paris is the capital of France.' });
    push(mainMessageId, FINISH);
    await flush();

    // A second, distinct engine call was made for title generation, using
    // the same profile (conn-1/profile-1) as the completed message.
    const titleReq = requests.find((r) => r.messageId !== mainMessageId);
    expect(titleReq).toBeDefined();
    expect(titleReq?.profile.id).toBe('profile-1');

    push(titleReq!.messageId, { type: 'text-delta', text: 'Capital of France' });
    push(titleReq!.messageId, FINISH);
    await flush();

    expect(container.store.chats.get(chatId)?.title).toBe('Capital of France');
  });

  it("records what the title call used, against the reply it titled, without replacing the reply's own usage", async () => {
    const chatId = (await createChat())['id'] as string;
    const { assistantMessageIds } = await postTurn(chatId, ['profile-1'], 'What is the capital of France?');
    const mainMessageId = assistantMessageIds[0] as string;
    push(mainMessageId, { type: 'text-delta', text: 'Paris.' });
    push(mainMessageId, FINISH);
    await flush();
    const titleReq = requests.find((r) => r.messageId !== mainMessageId)!;
    push(titleReq.messageId, { type: 'text-delta', text: 'Capital of France' });
    push(titleReq.messageId, { type: 'finish', usage: { tokensIn: 40, tokensOut: 4, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' });
    await flush();

    const row = container.store.usage.list(chatId).find((u) => u.purpose === 'title');
    expect(row).toMatchObject({ messageId: mainMessageId, profileId: 'profile-1', tokensIn: 40, tokensOut: 4 });
    const body = (await json(await app().request(`/api/chats/${chatId}/messages`))) as { usage: Record<string, { tokensIn: number }> };
    expect(body.usage[mainMessageId]?.tokensIn).toBe(1);
  });

  it('sends the title call only the start of a long exchange', async () => {
    const chatId = (await createChat())['id'] as string;
    const { assistantMessageIds } = await postTurn(chatId, ['profile-1'], `Q${'q'.repeat(50_000)}`);
    const mainMessageId = assistantMessageIds[0] as string;
    push(mainMessageId, { type: 'text-delta', text: `A${'a'.repeat(50_000)}` });
    push(mainMessageId, FINISH);
    await flush();

    const titleReq = requests.find((r) => r.messageId !== mainMessageId)!;
    const part = titleReq.messages[0]!.parts[0]!;
    const prompt = part.type === 'text' ? part.text : '';
    expect(prompt).toContain('User: Qqq');
    expect(prompt).toContain('Assistant: Aaa');
    expect(prompt.length).toBeLessThan(5_000);
  });

  it('truncates a generated title to 48 characters', async () => {
    const created = await createChat();
    const chatId = created['id'] as string;
    const { assistantMessageIds } = await postTurn(chatId, ['profile-1']);
    const mainMessageId = assistantMessageIds[0] as string;
    push(mainMessageId, FINISH);
    await flush();

    const titleReq = requests.find((r) => r.messageId !== mainMessageId);
    const longTitle = 'A'.repeat(80);
    push(titleReq!.messageId, { type: 'text-delta', text: longTitle });
    push(titleReq!.messageId, FINISH);
    await flush();

    const title = container.store.chats.get(chatId)?.title;
    expect(title).toHaveLength(48);
    expect(title).toBe(longTitle.slice(0, 48));
  });

  it('falls back to the first 48 characters of the user message when title generation errors', async () => {
    const created = await createChat();
    const chatId = created['id'] as string;
    const longUserText = 'Please explain quantum entanglement in simple terms suitable for a curious beginner';
    const { assistantMessageIds } = await postTurn(chatId, ['profile-1'], longUserText);
    const mainMessageId = assistantMessageIds[0] as string;
    push(mainMessageId, FINISH);
    await flush();

    const titleReq = requests.find((r) => r.messageId !== mainMessageId);
    push(titleReq!.messageId, { type: 'error', error: { kind: 'unknown', message: 'boom', retryable: false } });
    await flush();

    expect(container.store.chats.get(chatId)?.title).toBe(longUserText.slice(0, 48));
    // The turn itself is unaffected by the title-generation failure.
    expect(container.store.messages.get(mainMessageId)?.status).toBe('complete');
  });

  it('uses the fallback title when the 10s timer aborts a title generation that already streamed partial text (no finish, no error)', async () => {
    vi.useFakeTimers();
    try {
      const created = await createChat();
      const chatId = created['id'] as string;
      const userText = 'Please explain quantum entanglement in simple terms suitable for a curious beginner';
      const { assistantMessageIds } = await postTurn(chatId, ['profile-1'], userText);
      const mainMessageId = assistantMessageIds[0] as string;

      push(mainMessageId, FINISH);
      await vi.advanceTimersByTimeAsync(0);

      const titleReq = requests.find((r) => r.messageId !== mainMessageId);
      expect(titleReq).toBeDefined();

      // The title-generation stream produces some partial text, then just
      // hangs -- no `finish`, no `error` -- exactly like a slow/unresponsive
      // provider that the 10s watchdog is meant to catch.
      push(titleReq!.messageId, { type: 'text-delta', text: 'Quantum ent' });
      await vi.advanceTimersByTimeAsync(0);

      // The 10s timeout fires and aborts the stream. `manualEngine` ends the
      // stream cleanly on abort (no `error` event), mirroring every real
      // engine observed so far -- so the loop exits with `generated` holding
      // partial text. The documented behaviour (chats.ts:196-204) is that
      // ANY failure, including a timeout, uses the fallback -- never a
      // garbled partial title. (10_000 = chats.ts's private
      // TITLE_GENERATION_TIMEOUT_MS -- not exported, so duplicated here.)
      await vi.advanceTimersByTimeAsync(10_000);

      expect(container.store.chats.get(chatId)?.title).toBe(userText.slice(0, 48));
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a generated title whose finish arrived, even when the engine stream keeps running past the watchdog', async () => {
    // Claude Code's utility stream only ends when its process exits, which can
    // be well after `finish`. The title must be taken at `finish`, not lost to
    // the watchdog that fires while the stream lingers.
    hangAfterFinish = true;
    vi.useFakeTimers();
    try {
      const created = await createChat();
      const chatId = created['id'] as string;
      const { assistantMessageIds } = await postTurn(chatId, ['profile-1'], 'Please explain quantum entanglement in simple terms suitable for a curious beginner');
      const mainMessageId = assistantMessageIds[0] as string;
      push(mainMessageId, FINISH);
      await vi.advanceTimersByTimeAsync(0);

      const titleReq = requests.find((r) => r.messageId !== mainMessageId);
      push(titleReq!.messageId, { type: 'text-delta', text: 'Quantum Entanglement Basics' });
      push(titleReq!.messageId, FINISH);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(container.store.chats.get(chatId)?.title).toBe('Quantum Entanglement Basics');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a claude_code connection a 30s title budget instead of 10s', async () => {
    container.store.connections.update('conn-1', { kind: 'claude_code' });
    vi.useFakeTimers();
    try {
      const created = await createChat();
      const chatId = created['id'] as string;
      const { assistantMessageIds } = await postTurn(chatId, ['profile-1'], 'What is the capital of France?');
      const mainMessageId = assistantMessageIds[0] as string;
      push(mainMessageId, FINISH);
      await vi.advanceTimersByTimeAsync(0);

      const titleReq = requests.find((r) => r.messageId !== mainMessageId);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(titleReq!.signal.aborted).toBe(false);
      push(titleReq!.messageId, { type: 'text-delta', text: 'Capital of France' });
      push(titleReq!.messageId, FINISH);
      await vi.advanceTimersByTimeAsync(0);

      expect(container.store.chats.get(chatId)?.title).toBe('Capital of France');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never re-triggers on a second turn in the same chat', async () => {
    const created = await createChat();
    const chatId = created['id'] as string;

    const first = await postTurn(chatId, ['profile-1'], 'First question');
    push(first.assistantMessageIds[0] as string, FINISH);
    await flush();
    const firstTitleReq = requests.find((r) => r.messageId !== first.assistantMessageIds[0]);
    push(firstTitleReq!.messageId, { type: 'text-delta', text: 'First Title' });
    push(firstTitleReq!.messageId, FINISH);
    await flush();
    expect(container.store.chats.get(chatId)?.title).toBe('First Title');

    const requestCountBeforeSecondTurn = requests.length;
    const second = await postTurn(chatId, ['profile-1'], 'Second question');
    push(second.assistantMessageIds[0] as string, FINISH);
    await flush();

    // Only the second turn's own engine call happened -- no additional
    // title-generation call.
    expect(requests.length).toBe(requestCountBeforeSecondTurn + 1);
    expect(container.store.chats.get(chatId)?.title).toBe('First Title');
  });

  it('only titles once for a compare turn with multiple profiles', async () => {
    const created = await createChat();
    const chatId = created['id'] as string;
    container.store.profiles.create({
      id: 'profile-2',
      name: 'Profile Two',
      description: null,
      colour: null,
      connectionId: 'conn-1',
      modelId: 'model-1',
      systemPrompt: null,
      params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
      isDefault: false,
      archivedAt: null,
    });

    const { assistantMessageIds } = await postTurn(chatId, ['profile-1', 'profile-2']);
    push(assistantMessageIds[0] as string, FINISH);
    push(assistantMessageIds[1] as string, FINISH);
    await flush();

    const titleRequests = requests.filter((r) => !assistantMessageIds.includes(r.messageId));
    expect(titleRequests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Projects (spec 2026-10-03-projects-design §2)
// ---------------------------------------------------------------------------

describe('chats in projects', () => {
  const PROJECT_ROOT = process.platform === 'win32' ? 'C:\\Users\\Test\\project' : '/home/test/project';
  const OTHER_ROOT = process.platform === 'win32' ? 'D:\\elsewhere' : '/srv/elsewhere';

  function addProfile(id: string, over: { isDefault?: boolean; archivedAt?: number | null } = {}): void {
    container.store.profiles.create({
      id,
      name: id,
      description: null,
      colour: null,
      connectionId: 'conn-1',
      modelId: 'model-1',
      systemPrompt: null,
      params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
      isDefault: over.isDefault ?? false,
      archivedAt: over.archivedAt ?? null,
    });
  }

  beforeEach(() => {
    addProfile('profile-coder');
    addProfile('profile-app-default', { isDefault: true });
    container.store.projects.create({ id: 'proj-1', name: 'Alpha', workspaceRoot: PROJECT_ROOT, defaultProfileId: 'profile-coder' });
  });

  function post(body: Record<string, unknown>): Promise<Response> {
    return Promise.resolve(
      app().request('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    );
  }

  function patchChat(id: string, body: Record<string, unknown>): Promise<Response> {
    return Promise.resolve(
      app().request(`/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    );
  }

  it("a chat created with only projectId inherits the project's folder and default profile", async () => {
    const res = await post({ projectId: 'proj-1' });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ projectId: 'proj-1', workspaceRoot: PROJECT_ROOT, profileId: 'profile-coder' });
  });

  it("the request's own profileId and workspaceRoot win over the project's", async () => {
    const res = await post({ projectId: 'proj-1', profileId: 'profile-1', workspaceRoot: OTHER_ROOT });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ projectId: 'proj-1', profileId: 'profile-1', workspaceRoot: OTHER_ROOT });
  });

  it("an explicit workspaceRoot: null means no folder, not the project's", async () => {
    const res = await post({ projectId: 'proj-1', workspaceRoot: null });
    expect(await json(res)).toMatchObject({ projectId: 'proj-1', workspaceRoot: null });
  });

  it('falls back to the app default profile when the project has no default, or its default is archived', async () => {
    container.store.projects.update('proj-1', { defaultProfileId: null });
    expect(await json(await post({ projectId: 'proj-1' }))).toMatchObject({ profileId: 'profile-app-default' });

    // Archived without the route clearing it (e.g. by hand in the database).
    container.store.profiles.update('profile-coder', { archivedAt: 5 });
    container.store.projects.update('proj-1', { defaultProfileId: 'profile-coder' });
    expect(await json(await post({ projectId: 'proj-1' }))).toMatchObject({ profileId: 'profile-app-default' });
  });

  it("a chat in a sub-project with no folder or default profile of its own takes its parent's", async () => {
    container.store.projects.create({ id: 'sub', name: 'Desktop', workspaceRoot: null, defaultProfileId: null, parentId: 'proj-1' });
    expect(await json(await post({ projectId: 'sub' }))).toMatchObject({ projectId: 'sub', workspaceRoot: PROJECT_ROOT, profileId: 'profile-coder' });

    // Its own win over the parent's.
    container.store.projects.update('sub', { workspaceRoot: OTHER_ROOT, defaultProfileId: 'profile-1' });
    expect(await json(await post({ projectId: 'sub' }))).toMatchObject({ workspaceRoot: OTHER_ROOT, profileId: 'profile-1' });
  });

  it('still creates the chat when the project folder no longer exists on disk', async () => {
    const missing = join(dataDir, 'deleted-folder');
    container.store.projects.update('proj-1', { workspaceRoot: missing });

    const res = await post({ projectId: 'proj-1' });

    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ workspaceRoot: missing });
  });

  it('400s for an unknown projectId and creates nothing', async () => {
    const res = await post({ projectId: 'no-such-project', profileId: 'profile-1' });
    expect(res.status).toBe(400);
    expect(container.store.chats.list()).toEqual([]);
  });

  it('without a projectId, profileId is still required', async () => {
    expect((await post({})).status).toBe(400);
  });

  it('PATCH projectId moves the chat and null clears it, without changing its folder, profile or list position', async () => {
    const created = await json(await post({ profileId: 'profile-1', workspaceRoot: OTHER_ROOT }));
    const id = created['id'] as string;
    const updatedAt = container.store.chats.get(id)!.updatedAt;

    const moved = await patchChat(id, { projectId: 'proj-1' });
    expect(moved.status).toBe(200);
    expect(await json(moved)).toMatchObject({ projectId: 'proj-1', workspaceRoot: OTHER_ROOT, profileId: 'profile-1', updatedAt });

    const cleared = await patchChat(id, { projectId: null });
    expect(await json(cleared)).toMatchObject({ projectId: null, workspaceRoot: OTHER_ROOT, profileId: 'profile-1', updatedAt });
  });

  it('PATCH with an unknown projectId 400s and leaves the chat where it was', async () => {
    const created = await json(await post({ projectId: 'proj-1' }));
    const id = created['id'] as string;

    expect((await patchChat(id, { projectId: 'no-such-project' })).status).toBe(400);
    expect(container.store.chats.get(id)!.projectId).toBe('proj-1');
  });

  it('chat list responses include projectId', async () => {
    await post({ projectId: 'proj-1' });
    await post({ profileId: 'profile-1' });

    const list = (await (await app().request('/api/chats')).json()) as Record<string, unknown>[];

    expect(list.map((c) => c['projectId']).sort()).toEqual([null, 'proj-1'].sort());
  });

  it("PATCH memoryExcluded turns the chat's memory contribution off and on without moving it in the list", async () => {
    const created = await json(await post({ projectId: 'proj-1' }));
    const id = created['id'] as string;
    expect(created).toMatchObject({ memoryExcluded: false, memoryCursor: null });
    const updatedAt = container.store.chats.get(id)!.updatedAt;

    const off = await patchChat(id, { memoryExcluded: true });
    expect(off.status).toBe(200);
    expect(await json(off)).toMatchObject({ memoryExcluded: true, updatedAt });
    expect(await json(await patchChat(id, { memoryExcluded: false }))).toMatchObject({ memoryExcluded: false, updatedAt });
  });

  it('a new chat starts with sortOrder at its creation time; PATCH sortOrder reorders it without counting as activity', async () => {
    const created = await json(await post({ projectId: 'proj-1' }));
    const id = created['id'] as string;
    expect(created['sortOrder']).toBe(created['createdAt']);
    const updatedAt = container.store.chats.get(id)!.updatedAt;

    const res = await patchChat(id, { sortOrder: 12.5 });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ sortOrder: 12.5, updatedAt });
    // In one PATCH with a move between projects, as a drop onto another group sends it.
    expect(await json(await patchChat(id, { sortOrder: 3, projectId: null, pinned: false }))).toMatchObject({ sortOrder: 3, projectId: null });
  });

  it('rejects a sortOrder that is not a finite number with 400 and leaves the chat unchanged', async () => {
    const id = (await json(await post({ projectId: 'proj-1' })))['id'] as string;
    const before = container.store.chats.get(id)!.sortOrder;
    for (const bad of ['1', null, true]) {
      const res = await patchChat(id, { sortOrder: bad });
      expect(res.status).toBe(400);
      expect((await json(res))['error']).toBe('"sortOrder" must be a finite number.');
    }
    expect(container.store.chats.get(id)!.sortOrder).toBe(before);
  });

  it('PATCH projectPinned pins a chat within its project without counting as activity; a move clears it', async () => {
    container.store.projects.create({ id: 'proj-2', name: 'Beta', workspaceRoot: null, defaultProfileId: null });
    const created = await json(await post({ projectId: 'proj-1' }));
    const id = created['id'] as string;
    expect(created).toMatchObject({ projectPinned: false });
    const updatedAt = container.store.chats.get(id)!.updatedAt;

    const res = await patchChat(id, { projectPinned: true });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ projectPinned: true, updatedAt });
    expect(await json(await patchChat(id, { projectId: 'proj-2' }))).toMatchObject({ projectId: 'proj-2', projectPinned: false });
    // Dropped among another project's pinned chats: moved and pinned in one PATCH.
    expect(await json(await patchChat(id, { projectId: 'proj-1', projectPinned: true }))).toMatchObject({ projectId: 'proj-1', projectPinned: true });
  });

  it('PATCH unread marks a chat read or unread without counting as activity, and refuses a non-boolean', async () => {
    const id = (await json(await post({ projectId: 'proj-1' })))['id'] as string;
    container.store.chats.update(id, { unread: true });
    const updatedAt = container.store.chats.get(id)!.updatedAt;

    const res = await patchChat(id, { unread: false });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ unread: false, updatedAt });
    const bad = await patchChat(id, { unread: 'no' });
    expect(bad.status).toBe(400);
    expect((await json(bad))['error']).toBe('"unread" must be a boolean.');
  });

  it('refuses projectPinned on a chat with no project (after the patch), and a non-boolean, with 400', async () => {
    const loose = (await json(await post({ profileId: 'profile-1' })))['id'] as string;
    const res = await patchChat(loose, { projectPinned: true });
    expect(res.status).toBe(400);
    expect((await json(res))['error']).toBe('"projectPinned" needs the chat to be in a project.');
    const filed = (await json(await post({ projectId: 'proj-1' })))['id'] as string;
    expect((await patchChat(filed, { projectId: null, projectPinned: true })).status).toBe(400);
    expect((await patchChat(filed, { projectPinned: 'yes' })).status).toBe(400);
    expect(container.store.chats.get(filed)).toMatchObject({ projectId: 'proj-1', projectPinned: false });
    // Unpinning a loose chat is fine: it's already not pinned.
    expect((await patchChat(loose, { projectPinned: false })).status).toBe(200);
  });

  it('rejects a non-boolean memoryExcluded with 400 and leaves the chat unchanged', async () => {
    const id = (await json(await post({ projectId: 'proj-1' })))['id'] as string;
    for (const bad of ['yes', 1, null]) {
      const res = await patchChat(id, { memoryExcluded: bad });
      expect(res.status).toBe(400);
      expect((await json(res))['error']).toBe('"memoryExcluded" must be a boolean.');
    }
    expect(container.store.chats.get(id)!.memoryExcluded).toBe(false);
  });

  it("moving a chat to another project resets its memory cursor, and a client can't set the cursor", async () => {
    container.store.projects.create({ id: 'proj-2', name: 'Beta', workspaceRoot: null, defaultProfileId: null });
    const id = (await json(await post({ projectId: 'proj-1' })))['id'] as string;
    container.store.chats.update(id, { memoryCursor: 'msg-1' });

    expect(await json(await patchChat(id, { memoryCursor: 'msg-9' }))).toMatchObject({ memoryCursor: 'msg-1' });
    expect(await json(await patchChat(id, { projectId: 'proj-2' }))).toMatchObject({ projectId: 'proj-2', memoryCursor: null });
  });
});

describe('chats in apps (spec 2026-10-20-code-tab-design, "Data")', () => {
  const APP_ROOT = process.platform === 'win32' ? 'C:\\Users\\Test\\app' : '/home/test/app';
  const OTHER_ROOT = process.platform === 'win32' ? 'D:\\elsewhere' : '/srv/elsewhere';

  function addProfile(id: string, over: { isDefault?: boolean; archivedAt?: number | null } = {}): void {
    container.store.profiles.create({
      id,
      name: id,
      description: null,
      colour: null,
      connectionId: 'conn-1',
      modelId: 'model-1',
      systemPrompt: null,
      params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
      isDefault: over.isDefault ?? false,
      archivedAt: over.archivedAt ?? null,
    });
  }

  beforeEach(() => {
    addProfile('profile-coder');
    addProfile('profile-app-default', { isDefault: true });
    container.store.projects.create({ id: 'proj-1', name: 'Planning', workspaceRoot: OTHER_ROOT, defaultProfileId: null });
    container.store.apps.create({ id: 'app-1', name: 'OtherBench', workspaceRoot: APP_ROOT, defaultProfileId: 'profile-coder' });
    container.store.apps.create({ id: 'app-bare', name: 'Bare', workspaceRoot: APP_ROOT, defaultProfileId: null });
  });

  function post(body: Record<string, unknown>): Promise<Response> {
    return Promise.resolve(app().request('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  }

  function patchChat(id: string, body: Record<string, unknown>): Promise<Response> {
    return Promise.resolve(app().request(`/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  }

  it("a chat created in an app takes the app's folder and default profile", async () => {
    const res = await post({ appId: 'app-1' });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ appId: 'app-1', projectId: null, workspaceRoot: APP_ROOT, profileId: 'profile-coder' });
    // The app's default wins over the request's profile.
    expect(await json(await post({ appId: 'app-1', profileId: 'profile-1' }))).toMatchObject({ profileId: 'profile-coder' });
  });

  it("an app with no default profile uses the request's, else the usual default", async () => {
    expect(await json(await post({ appId: 'app-bare', profileId: 'profile-1' }))).toMatchObject({ appId: 'app-bare', profileId: 'profile-1' });
    expect(await json(await post({ appId: 'app-bare' }))).toMatchObject({ profileId: 'profile-app-default' });
    // An archived app default is passed over.
    container.store.profiles.update('profile-coder', { archivedAt: 5 });
    expect(await json(await post({ appId: 'app-1' }))).toMatchObject({ profileId: 'profile-app-default' });
  });

  it('refuses an unknown app, a folder of its own, or a project as well, with 400', async () => {
    expect((await post({ appId: 'nope' })).status).toBe(400);
    expect((await post({ appId: 'app-1', workspaceRoot: OTHER_ROOT })).status).toBe(400);
    expect((await post({ appId: 'app-1', projectId: 'proj-1' })).status).toBe(400);
    expect(container.store.chats.list()).toEqual([]);
  });

  it("PATCH appId moves the chat into the app: no project, the app's folder and profile", async () => {
    const id = (await json(await post({ projectId: 'proj-1', profileId: 'profile-1' })))['id'] as string;
    const res = await patchChat(id, { appId: 'app-1' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ appId: 'app-1', projectId: null, workspaceRoot: APP_ROOT, profileId: 'profile-coder' });
    // An app with no default profile leaves the chat's profile alone.
    expect(await json(await patchChat(id, { appId: 'app-bare' }))).toMatchObject({ appId: 'app-bare', profileId: 'profile-coder' });
    expect((await patchChat(id, { appId: 'nope' })).status).toBe(400);
    expect((await patchChat(id, { appId: 'app-1', projectId: 'proj-1' })).status).toBe(400);
  });

  it('PATCH appId: null leaves the app and keeps the folder', async () => {
    const id = (await json(await post({ appId: 'app-1' })))['id'] as string;
    expect(await json(await patchChat(id, { appId: null }))).toMatchObject({ appId: null, workspaceRoot: APP_ROOT });
  });

  it('PATCH projectId clears appId', async () => {
    const id = (await json(await post({ appId: 'app-1' })))['id'] as string;
    expect(await json(await patchChat(id, { projectId: 'proj-1' }))).toMatchObject({ projectId: 'proj-1', appId: null, workspaceRoot: APP_ROOT });
  });

  it("an app chat's folder is its app's: a workspace PATCH is a 400", async () => {
    const id = (await json(await post({ appId: 'app-1' })))['id'] as string;
    for (const body of [{ workspaceRoot: OTHER_ROOT }, { workspacePath: OTHER_ROOT }, { workspace: null }]) {
      const res = await patchChat(id, body);
      expect(res.status).toBe(400);
      expect((await json(res))['error']).toBe("An app chat uses its app's folder.");
    }
    expect(container.store.chats.get(id)).toMatchObject({ workspace: { kind: 'machine', root: APP_ROOT } });
    // Leaving the app in the same PATCH frees the folder.
    expect(await json(await patchChat(id, { appId: null, workspaceRoot: OTHER_ROOT }))).toMatchObject({ appId: null, workspaceRoot: OTHER_ROOT });
  });
});
