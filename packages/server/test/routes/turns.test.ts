import { describe, it, expect, beforeEach } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore } from '@grunt/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

// ---------------------------------------------------------------------------
// A hand-controllable ChatEngine, keyed by EngineRequest.messageId, so tests
// can interleave HTTP calls with individual stream events (needed for the
// SSE hello/replay/live and cancel-isolation tests below) without real
// delays. Same technique as packages/core/test/turn.test.ts and
// packages/server/test/stream/registry.test.ts.
// ---------------------------------------------------------------------------

function manualEngine(): { engine: ChatEngine; push: (messageId: string, event: EngineEvent | null) => void } {
  interface Channel {
    queued: (EngineEvent | null)[];
    waiters: ((event: EngineEvent | null) => void)[];
  }
  const channels = new Map<string, Channel>();

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

  return { engine, push };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const FINISH: EngineEvent = {
  type: 'finish',
  usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 },
  finishReason: 'stop',
};

/** Reads one complete `event: ...\ndata: ...\n\n` SSE record at a time from a Response body. */
function sseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function parseRecord(record: string): { event: string | null; data: unknown } {
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of record.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
    }
    return { event, data: JSON.parse(dataLines.join('\n')) };
  }

  async function next(timeoutMs = 200): Promise<{ event: string | null; data: unknown } | null> {
    for (;;) {
      const recordEnd = buffer.indexOf('\n\n');
      if (recordEnd !== -1) {
        const record = buffer.slice(0, recordEnd);
        buffer = buffer.slice(recordEnd + 2);
        return parseRecord(record);
      }
      const outcome = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
      ]);
      if (outcome === 'timeout') return null;
      const { value, done } = outcome;
      if (done) return null;
      if (value) buffer += decoder.decode(value, { stream: true });
    }
  }

  return { next, cancel: () => reader.cancel() };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let container: Container;
let push: (messageId: string, event: EngineEvent | null) => void;

beforeEach(() => {
  const store = new InMemoryStore();
  const manual = manualEngine();
  push = manual.push;
  const turnRunner = new TurnRunner(store, manual.engine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine: manual.engine,
    registry: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    close: () => {},
  };
});

function app() {
  return createApp(container);
}

/** Seeds `profileCount` connection+profile pairs and one chat headed by the first, returning their ids. */
function seedChat(profileCount = 1): { chatId: string; profileIds: string[] } {
  const chatId = 'chat-1';
  const profileIds: string[] = [];
  for (let i = 0; i < profileCount; i++) {
    const connectionId = `conn-${i}`;
    const profileId = `profile-${i}`;
    container.store.connections.create({
      id: connectionId,
      name: `Conn ${i}`,
      kind: 'mock',
      baseUrl: null,
      secretRef: null,
      extraHeaders: {},
      status: 'unknown',
      statusMessage: null,
      checkedAt: null,
    });
    container.store.profiles.create({
      id: profileId,
      name: `Profile ${i}`,
      description: null,
      colour: null,
      connectionId,
      modelId: 'model-x',
      systemPrompt: null,
      params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
      isDefault: false,
      archivedAt: null,
    });
    profileIds.push(profileId);
  }
  container.store.chats.create({
    id: chatId,
    title: 'Test Chat',
    profileId: profileIds[0] as string,
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
  });
  return { chatId, profileIds };
}

async function postTurn(chatId: string, profileIds: string[], parts: unknown = [{ type: 'text', text: 'Hi' }]) {
  return app().request(`/api/chats/${chatId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts, profileIds }),
  });
}

// ---------------------------------------------------------------------------
// POST /api/chats/:id/turns
// ---------------------------------------------------------------------------

describe('POST /api/chats/:id/turns', () => {
  it('persists a user message and one streaming assistant message per profile, returning 202 immediately', async () => {
    const { chatId, profileIds } = seedChat(2);

    const res = await postTurn(chatId, profileIds, [{ type: 'text', text: 'Hello' }]);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };
    expect(body.assistantMessageIds).toHaveLength(2);

    const userMessage = container.store.messages.get(body.userMessageId);
    expect(userMessage).toMatchObject({ chatId, role: 'user', status: 'complete' });
    for (const id of body.assistantMessageIds) {
      expect(container.store.messages.get(id)).toMatchObject({ chatId, role: 'assistant', status: 'streaming' });
    }
  });

  it('404s for an unknown chat', async () => {
    const res = await postTurn('no-such-chat', ['profile-0']);
    expect(res.status).toBe(404);
  });

  it('400s when parts is missing or empty', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds, []);
    expect(res.status).toBe(400);
  });

  it('400s when profileIds is missing or empty', async () => {
    const { chatId } = seedChat();
    const res = await postTurn(chatId, []);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/messages/:id/cancel
// ---------------------------------------------------------------------------

describe('POST /api/messages/:id/cancel', () => {
  it('cancels a streaming variant', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0] as string;

    const cancelRes = await app().request(`/api/messages/${messageId}/cancel`, { method: 'POST' });
    await flush();

    expect(cancelRes.status).toBe(204);
    expect(container.store.messages.get(messageId)?.status).toBe('cancelled');
  });

  it('404s for an unknown message', async () => {
    const res = await app().request('/api/messages/no-such-message/cancel', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/messages/:id/retry
// ---------------------------------------------------------------------------

describe('POST /api/messages/:id/retry', () => {
  it('re-streams a failed variant in place: same message id, reset parts/status/error, fresh events', async () => {
    const { chatId, profileIds } = seedChat(2);
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const [failingId, otherId] = assistantMessageIds as [string, string];

    push(failingId, { type: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } });
    await flush();
    expect(container.store.messages.get(failingId)?.status).toBe('error');

    const streamRes = await app().request(`/api/chats/${chatId}/stream`);
    const reader = sseReader(streamRes);
    await reader.next(); // hello

    const retryRes = await app().request(`/api/messages/${failingId}/retry`, { method: 'POST' });
    expect(retryRes.status).toBe(202);
    expect((await retryRes.json()) as { messageId: string }).toEqual({ messageId: failingId });

    // The reset is visible immediately (synchronous, before the retry's own await).
    expect(container.store.messages.get(failingId)).toMatchObject({ status: 'streaming', error: null, parts: [] });

    const resetEvent = await reader.next();
    expect(resetEvent?.data).toEqual({ messageId: failingId, type: 'status', status: 'streaming' });

    push(failingId, { type: 'text-delta', text: 'Second attempt' });
    const deltaEvent = await reader.next();
    expect(deltaEvent?.data).toEqual({ messageId: failingId, type: 'text-delta', text: 'Second attempt' });

    push(failingId, FINISH);
    await reader.next(); // finish
    const statusEvent = await reader.next();
    expect(statusEvent?.data).toEqual({ messageId: failingId, type: 'status', status: 'complete' });

    expect(container.store.messages.get(failingId)).toMatchObject({ status: 'complete', error: null });
    // The sibling was never touched by the retry.
    expect(container.store.messages.get(otherId)?.status).toBe('streaming');

    await reader.cancel();
  });

  it('a client reconnecting after a retry sees only the retried attempt in the hello replay, not the failed one', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0] as string;

    push(messageId, { type: 'text-delta', text: 'Before the failure' });
    push(messageId, { type: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } });
    await flush();

    await app().request(`/api/messages/${messageId}/retry`, { method: 'POST' });
    push(messageId, { type: 'text-delta', text: 'After the retry' });
    await flush();

    const streamRes = await app().request(`/api/chats/${chatId}/stream`);
    const reader = sseReader(streamRes);
    const hello = await reader.next();
    const events = (hello?.data as { inFlight: { messageId: string; events: { type: string; text?: string }[] }[] }).inFlight.find(
      (b) => b.messageId === messageId
    )?.events;

    expect(events?.map((e) => e.type)).toEqual(['status', 'text-delta']);
    expect(events?.find((e) => e.type === 'text-delta')?.text).toBe('After the retry');
    await reader.cancel();
  });

  it('404s for an unknown message', async () => {
    const res = await app().request('/api/messages/no-such-message/retry', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('409s when the message is currently streaming', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0] as string;

    const retryRes = await app().request(`/api/messages/${messageId}/retry`, { method: 'POST' });
    expect(retryRes.status).toBe(409);
  });

  it('400s for a user message', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { userMessageId } = (await res.json()) as { userMessageId: string };

    const retryRes = await app().request(`/api/messages/${userMessageId}/retry`, { method: 'POST' });
    expect(retryRes.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/chats/:id/head
// ---------------------------------------------------------------------------

describe('POST /api/chats/:id/head', () => {
  it('moves head_message_id to the given message', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0] as string;

    const headRes = await app().request(`/api/chats/${chatId}/head`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });

    expect(headRes.status).toBe(200);
    expect(container.store.chats.get(chatId)?.headMessageId).toBe(messageId);
  });

  it('400s when the message does not belong to this chat', async () => {
    const { chatId, profileIds } = seedChat();
    container.store.chats.create({
      id: 'other-chat',
      title: 'Other',
      profileId: profileIds[0] as string,
      headMessageId: null,
      workspaceRoot: null,
      pinned: false,
      archivedAt: null,
    });
    const res = await postTurn('other-chat', profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };

    const headRes = await app().request(`/api/chats/${chatId}/head`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: assistantMessageIds[0] }),
    });
    expect(headRes.status).toBe(400);
  });

  it('404s for an unknown chat', async () => {
    const res = await app().request('/api/chats/no-such-chat/head', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'irrelevant' }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/chats/:id/stream
// ---------------------------------------------------------------------------

describe('GET /api/chats/:id/stream', () => {
  it('the hello event replays in-flight state right after a turn is posted', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };

    const streamRes = await app().request(`/api/chats/${chatId}/stream`);
    const reader = sseReader(streamRes);
    const hello = await reader.next();

    expect(hello?.event).toBe('hello');
    expect(hello?.data).toMatchObject({
      inFlight: [{ messageId: assistantMessageIds[0], status: 'streaming', events: [] }],
    });
    await reader.cancel();
  });

  it('delivers live events tagged with the message id they belong to', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0] as string;

    const streamRes = await app().request(`/api/chats/${chatId}/stream`);
    const reader = sseReader(streamRes);
    await reader.next(); // hello

    push(messageId, { type: 'text-delta', text: 'Hello there' });
    const event = await reader.next();

    expect(event?.event).toBeNull();
    expect(event?.data).toEqual({ messageId, type: 'text-delta', text: 'Hello there' });
    await reader.cancel();
  });

  it('two subscribers to one turn both receive every event', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0] as string;

    const readerA = sseReader(await app().request(`/api/chats/${chatId}/stream`));
    const readerB = sseReader(await app().request(`/api/chats/${chatId}/stream`));
    await readerA.next(); // hello
    await readerB.next(); // hello

    push(messageId, { type: 'text-delta', text: 'Broadcast' });
    const eventA = await readerA.next();
    const eventB = await readerB.next();

    expect(eventA?.data).toEqual({ messageId, type: 'text-delta', text: 'Broadcast' });
    expect(eventB?.data).toEqual(eventA?.data);
    await readerA.cancel();
    await readerB.cancel();
  });

  it('a subscriber attaching mid-stream sees the events-so-far in hello, then live events, with no duplication', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0] as string;

    push(messageId, { type: 'text-delta', text: 'Early ' });
    await flush();

    const streamRes = await app().request(`/api/chats/${chatId}/stream`);
    const reader = sseReader(streamRes);
    const hello = await reader.next();
    const helloEvents = (hello?.data as { inFlight: { events: unknown[] }[] }).inFlight[0]?.events ?? [];
    expect(helloEvents).toEqual([{ messageId, type: 'text-delta', text: 'Early ' }]);

    push(messageId, { type: 'text-delta', text: 'Late' });
    const live = await reader.next();
    expect(live?.data).toEqual({ messageId, type: 'text-delta', text: 'Late' });

    // No third event shows up -- the 'Early ' delta was only ever delivered once (in hello).
    const extra = await reader.next(50);
    expect(extra).toBeNull();
    await reader.cancel();
  });

  it('cancelling one message leaves the SSE connection open and the sibling still streaming', async () => {
    const { chatId, profileIds } = seedChat(2);
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const [cancelledId, otherId] = assistantMessageIds as [string, string];

    const streamRes = await app().request(`/api/chats/${chatId}/stream`);
    const reader = sseReader(streamRes);
    await reader.next(); // hello

    await app().request(`/api/messages/${cancelledId}/cancel`, { method: 'POST' });
    const cancelEvent = await reader.next();
    expect(cancelEvent?.data).toEqual({ messageId: cancelledId, type: 'status', status: 'cancelled' });

    push(otherId, { type: 'text-delta', text: 'Still alive' });
    const liveEvent = await reader.next();
    expect(liveEvent?.data).toEqual({ messageId: otherId, type: 'text-delta', text: 'Still alive' });

    push(otherId, FINISH);
    const finishEvent = await reader.next();
    expect(finishEvent?.data).toMatchObject({ messageId: otherId, type: 'finish' });
    const statusEvent = await reader.next();
    expect(statusEvent?.data).toEqual({ messageId: otherId, type: 'status', status: 'complete' });

    await reader.cancel();
  });

  it('404s for an unknown chat', async () => {
    const res = await app().request('/api/chats/no-such-chat/stream');
    expect(res.status).toBe(404);
  });
});
