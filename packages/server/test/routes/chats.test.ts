import { describe, it, expect, beforeEach } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore } from '@grunt/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
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

beforeEach(() => {
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
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner),
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
