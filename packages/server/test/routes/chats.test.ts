import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore } from '@grunt/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
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
  dataDir = await mkdtemp(join(tmpdir(), 'grunt-chats-route-test-'));
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

  it('turns auto mode on and off via PATCH autoMode, without moving the chat in the list', async () => {
    const created = await createChat();
    const id = created['id'] as string;
    expect(created['autoMode']).toBe(false);
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
    expect(container.store.chats.get(id)!.autoMode).toBe(false);
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
    // Nothing was written -- the chat's workspaceRoot is unchanged.
    expect(container.store.chats.get(created['id'] as string)?.workspaceRoot).toBeNull();
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
        body: JSON.stringify({ profileId: 'profile-1', workspaceRoot: 'E:\\Git\\Grunt' }),
      });
      expect(res.status).toBe(400);
    }
  );
});

// ---------------------------------------------------------------------------
// GET /:id/messages
// ---------------------------------------------------------------------------

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

    expect(body.headMessageId).toBeNull();
    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain(userMessageId);
    for (const id of assistantMessageIds) expect(ids).toContain(id);
    expect(body.messages).toHaveLength(1 + assistantMessageIds.length);
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
});

// ---------------------------------------------------------------------------
// Auto-title
// ---------------------------------------------------------------------------

describe('auto-title', () => {
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
