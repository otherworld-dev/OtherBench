import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HelperStopError } from '@otherbench/core/ports/chat-engine.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore } from '@otherbench/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import { NOTHING_TO_COMPACT } from '@otherbench/core/domain/context-lines.js';
import type { Part } from '@otherbench/core/types/messages.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { createApp } from '../../src/app.js';
import { CLEAR_MID_REPLY, CLEAR_ON_ITS_OWN } from '../../src/routes/turns.js';
import type { Container } from '../../src/container.js';
import { AppEventBus } from '../../src/stream/events.js';
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
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
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

  // Task 32 fix round 2, Minor #1: a malformed part used to sail through
  // `parseParts` untouched ("trust the element shape") and only fail once
  // `TurnRunner.run` handed it to `store.attachments.get(id)`, where
  // SQLite's own parameter binding rejects a non-string/number/null value
  // with an opaque driver error -- a generic 500, not a 400 naming what
  // was actually wrong with the request. Fails against 22cee46: both
  // cases below 500 there instead of 400.
  describe('malformed parts are rejected with 400, not a generic 500', () => {
    it('an image part with attachmentId missing entirely', async () => {
      const { chatId, profileIds } = seedChat();
      const res = await postTurn(chatId, profileIds, [{ type: 'image', mime: 'image/png' }]);
      expect(res.status).toBe(400);
    });

    it('a file part whose attachmentId is an object, not a string', async () => {
      const { chatId, profileIds } = seedChat();
      const res = await postTurn(chatId, profileIds, [
        { type: 'file', attachmentId: { nested: 'object' }, mime: 'text/plain', filename: 'a.txt' },
      ]);
      expect(res.status).toBe(400);
    });

    it('a part with an unrecognised "type"', async () => {
      const { chatId, profileIds } = seedChat();
      const res = await postTurn(chatId, profileIds, [{ type: 'bogus' }]);
      expect(res.status).toBe(400);
    });

    it('a part that is not even an object (a bare string)', async () => {
      const { chatId, profileIds } = seedChat();
      const res = await postTurn(chatId, profileIds, ['just a string']);
      expect(res.status).toBe(400);
    });
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

  // CRITICAL fix: retry used to accept 'complete' (and 'cancelled') too,
  // which silently discarded a finished answer and wrote a second usage row
  // for the same variant -- an exact doubling of measuredCost/tokens for one
  // logical call. These assert on GET /api/usage's totals before and after
  // the rejected retry, not just the response status, since the doubling
  // (not the status code) is the actual harm being closed here.
  it('409s when retrying a complete message, leaving content and GET /api/usage totals unchanged', async () => {
    const { chatId, profileIds } = seedChat();
    container.store.models.create({
      id: 'model-row-0',
      connectionId: 'conn-0',
      modelId: 'model-x',
      displayName: 'Model X',
      source: 'manual',
      supportsVision: false,
      supportsTools: false,
      supportsReasoning: false,
      contextWindow: null,
      maxOutput: null,
      priceInPer1m: 3,
      priceOutPer1m: 15,
      priceCachedPer1m: 0,
      currency: 'USD',
    });

    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0] as string;

    push(messageId, { type: 'text-delta', text: 'The finished answer' });
    push(messageId, { type: 'finish', usage: { tokensIn: 2, tokensOut: 32, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' });
    await flush();
    expect(container.store.messages.get(messageId)?.status).toBe('complete');

    const usageBefore = await (await app().request(`/api/usage?chatId=${chatId}`)).json();
    expect((usageBefore as { totalMeasuredCost: number }).totalMeasuredCost).toBeGreaterThan(0);

    const retryRes = await app().request(`/api/messages/${messageId}/retry`, { method: 'POST' });
    expect(retryRes.status).toBe(409);
    expect(await retryRes.text()).toMatch(/complete/i);

    // The completed content is untouched -- not reset, not re-streamed.
    expect(container.store.messages.get(messageId)).toMatchObject({
      status: 'complete',
      parts: [{ type: 'text', text: 'The finished answer' }],
    });

    // No second usage row was written: the rollup is byte-for-byte the same,
    // in particular no doubling of measuredCost/tokensIn/tokensOut/completeCount.
    const usageAfter = await (await app().request(`/api/usage?chatId=${chatId}`)).json();
    expect(usageAfter).toEqual(usageBefore);
  });

  it('409s when retrying a cancelled message, leaving its zeroed usage row as the only one', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0] as string;

    push(messageId, { type: 'text-delta', text: 'Partial before cancel' });
    await flush();
    const cancelRes = await app().request(`/api/messages/${messageId}/cancel`, { method: 'POST' });
    await flush();
    expect(cancelRes.status).toBe(204);
    expect(container.store.messages.get(messageId)?.status).toBe('cancelled');

    const usageBefore = await (await app().request(`/api/usage?chatId=${chatId}`)).json();

    // Deliberately disallowed -- a user is free to re-run a cancelled turn,
    // but not via retry() on this same message id: see TurnRunner.retry's
    // doc comment for why that would leave the cancellation's zeroed usage
    // row stranded (misattributed) once the retry finished.
    const retryRes = await app().request(`/api/messages/${messageId}/retry`, { method: 'POST' });
    expect(retryRes.status).toBe(409);
    expect(await retryRes.text()).toMatch(/cancelled/i);

    expect(container.store.messages.get(messageId)).toMatchObject({
      status: 'cancelled',
      parts: [{ type: 'text', text: 'Partial before cancel' }],
    });

    const usageAfter = await (await app().request(`/api/usage?chatId=${chatId}`)).json();
    expect(usageAfter).toEqual(usageBefore);
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

describe('POST /api/chats/:id/regenerate', () => {
  async function finishedTurn(profileCount = 1) {
    const { chatId, profileIds } = seedChat(profileCount);
    const res = await postTurn(chatId, [profileIds[0] as string]);
    const { userMessageId, assistantMessageIds } = (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };
    const assistantId = assistantMessageIds[0] as string;
    push(assistantId, { type: 'text-delta', text: 'first' });
    push(assistantId, FINISH);
    await flush();
    return { chatId, profileIds, userMessageId, assistantId };
  }
  function regenerate(chatId: string, body: unknown) {
    return app().request(`/api/chats/${chatId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('adds an assistant sibling under the same user message with the same profile, moves head to it, and 202s', async () => {
    const { chatId, userMessageId, assistantId } = await finishedTurn();
    const res = await regenerate(chatId, { messageId: assistantId });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { userMessageId: string; assistantMessageId: string };
    expect(body.userMessageId).toBe(userMessageId);

    const created = container.store.messages.get(body.assistantMessageId)!;
    expect(created).toMatchObject({ parentId: userMessageId, role: 'assistant', status: 'streaming' });
    expect(created.producedBy).toMatchObject({ profileId: 'profile-0', regenerated: true });
    expect(container.store.messages.children(userMessageId).map((m) => m.id)).toEqual([assistantId, body.assistantMessageId]);
    expect(container.store.chats.get(chatId)!.headMessageId).toBe(body.assistantMessageId);

    // Events for the new reply reach SSE subscribers (its buffer was registered).
    const reader = sseReader(await app().request(`/api/chats/${chatId}/stream`));
    await reader.next(); // hello
    push(body.assistantMessageId, { type: 'text-delta', text: 'second' });
    expect((await reader.next())?.data).toEqual({ messageId: body.assistantMessageId, type: 'text-delta', text: 'second' });
    await reader.cancel();
  });

  it('writes its own usage row for the new reply', async () => {
    const { chatId, assistantId } = await finishedTurn();
    const body = (await (await regenerate(chatId, { messageId: assistantId })).json()) as { assistantMessageId: string };
    await flush();
    push(body.assistantMessageId, FINISH);
    await flush();
    const rows = container.store.usage.list(chatId);
    expect(rows.map((r) => r.messageId).sort()).toEqual([assistantId, body.assistantMessageId].sort());
  });

  it('uses profileId from the body when given', async () => {
    const { chatId, profileIds, assistantId } = await finishedTurn(2);
    const body = (await (await regenerate(chatId, { messageId: assistantId, profileId: profileIds[1] })).json()) as { assistantMessageId: string };
    expect(container.store.messages.get(body.assistantMessageId)!.producedBy?.profileId).toBe(profileIds[1]);
  });

  it('skips a reply profile that has since been archived, falling back to a live one', async () => {
    const { chatId, profileIds, assistantId } = await finishedTurn(2);
    container.store.profiles.update(profileIds[0] as string, { archivedAt: Date.now() });
    const body = (await (await regenerate(chatId, { messageId: assistantId })).json()) as { assistantMessageId: string };
    expect(container.store.messages.get(body.assistantMessageId)!.producedBy?.profileId).toBe(profileIds[1]);
  });

  it('404s for an unknown chat or message', async () => {
    const { chatId } = await finishedTurn();
    expect((await regenerate('nope', { messageId: 'x' })).status).toBe(404);
    const res = await regenerate(chatId, { messageId: 'nope' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: unknown }).error).toBeTruthy();
  });

  it('400s without a messageId, for a user message, and for a message from another chat', async () => {
    const { chatId, userMessageId, assistantId } = await finishedTurn();
    expect((await regenerate(chatId, {})).status).toBe(400);
    const userRes = await regenerate(chatId, { messageId: userMessageId });
    expect(userRes.status).toBe(400);
    expect(JSON.stringify(await userRes.json())).toMatch(/assistant/i);

    container.store.chats.create({ id: 'chat-2', title: 'Other', profileId: 'profile-0', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const otherRes = await regenerate('chat-2', { messageId: assistantId });
    expect(otherRes.status).toBe(400);
    expect(JSON.stringify(await otherRes.json())).toMatch(/does not belong/i);
  });

  it('409s for a variant of a compare turn, creating nothing and leaving head alone', async () => {
    const { chatId, profileIds } = seedChat(2);
    const res = await postTurn(chatId, profileIds);
    const { userMessageId, assistantMessageIds } = (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };
    for (const id of assistantMessageIds) push(id, FINISH);
    await flush();
    const out = await regenerate(chatId, { messageId: assistantMessageIds[0] });
    expect(out.status).toBe(409);
    expect(JSON.stringify(await out.json())).toMatch(/compare/i);
    expect(container.store.messages.children(userMessageId)).toHaveLength(2);
    // Head stays where posting the turn put it: on the user message.
    expect(container.store.chats.get(chatId)!.headMessageId).toBe(userMessageId);
  });

  it('409s for a streaming message and creates nothing', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { userMessageId, assistantMessageIds } = (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };
    const out = await regenerate(chatId, { messageId: assistantMessageIds[0] });
    expect(out.status).toBe(409);
    expect(container.store.messages.children(userMessageId)).toHaveLength(1);
  });
});

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

  function setHead(chatId: string, messageId: string) {
    return app().request(`/api/chats/${chatId}/head`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
  }

  it('records a keep on a compare variant it lands on, and only there', async () => {
    const { chatId, profileIds } = seedChat(2);
    const { userMessageId, assistantMessageIds } = (await (await postTurn(chatId, profileIds)).json()) as { userMessageId: string; assistantMessageIds: string[] };
    for (const id of assistantMessageIds) push(id, FINISH);
    await flush();
    const [first, second] = assistantMessageIds as [string, string];

    expect((await setHead(chatId, userMessageId)).status).toBe(200);
    expect('keptAt' in container.store.messages.get(userMessageId)!).toBe(false);

    expect((await setHead(chatId, second)).status).toBe(200);
    expect(container.store.messages.get(second)!.keptAt).toEqual(expect.any(Number));
    expect('keptAt' in container.store.messages.get(first)!).toBe(false);
  });

  it('does not mark a single reply as kept', async () => {
    const { chatId, profileIds } = seedChat();
    const { assistantMessageIds } = (await (await postTurn(chatId, profileIds)).json()) as { assistantMessageIds: string[] };
    push(assistantMessageIds[0] as string, FINISH);
    await flush();
    expect((await setHead(chatId, assistantMessageIds[0] as string)).status).toBe(200);
    expect('keptAt' in container.store.messages.get(assistantMessageIds[0] as string)!).toBe(false);
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

// ---------------------------------------------------------------------------
// Project memory timer: a turn that never started must not leave the chat unarmed
// ---------------------------------------------------------------------------

describe('project memory re-arm when a turn fails to start', () => {
  function stubMemory() {
    const memory = { noteTurnStarted: vi.fn(), noteTurnCompleted: vi.fn() };
    container.memory = memory as never;
    return memory;
  }

  it('POST /chats/:id/turns re-arms the quiet timer when run() throws', async () => {
    const { chatId, profileIds } = seedChat();
    const memory = stubMemory();
    vi.spyOn(container.turnRunner, 'run').mockRejectedValue(new Error('store exploded'));
    const res = await postTurn(chatId, profileIds);
    expect(res.status).toBe(500);
    expect(memory.noteTurnStarted).toHaveBeenCalledWith(chatId);
    expect(memory.noteTurnCompleted).toHaveBeenCalledWith(chatId);
  });

  it('POST /messages/:id/retry re-arms the quiet timer when retry() rejects', async () => {
    const { chatId, profileIds } = seedChat();
    const res = await postTurn(chatId, profileIds);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const failingId = assistantMessageIds[0]!;
    push(failingId, { type: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } });
    await flush();
    const memory = stubMemory();
    vi.spyOn(container.turnRunner, 'retry').mockRejectedValue(new Error('retry exploded'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const retryRes = await app().request(`/api/messages/${failingId}/retry`, { method: 'POST' });
    expect(retryRes.status).toBe(202);
    await flush();
    expect(memory.noteTurnStarted).toHaveBeenCalledWith(chatId);
    expect(memory.noteTurnCompleted).toHaveBeenCalledWith(chatId);
  });
});

describe('POST /api/chats/:id/helpers/:taskId/stop', () => {
  it('stops a helper, and 404s an unknown one', async () => {
    container.store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const stopHelper = vi.fn(async (_chat: string, taskId: string) => taskId === 'k1');
    container.engine = { ...container.engine, stopHelper } as typeof container.engine;
    const ok = await app().request('/api/chats/chat-1/helpers/k1/stop', { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(stopHelper).toHaveBeenCalledWith('chat-1', 'k1');
    const missing = await app().request('/api/chats/chat-1/helpers/k2/stop', { method: 'POST' });
    expect(missing.status).toBe(404);
  });

  it("passes on why a helper couldn't be stopped", async () => {
    container.store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const stopHelper = vi.fn(async () => {
      throw new HelperStopError("This version of Claude Code can't stop one background task.");
    });
    container.engine = { ...container.engine, stopHelper } as typeof container.engine;
    const res = await app().request('/api/chats/chat-1/helpers/k1/stop', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This version of Claude Code can't stop one background task." });
  });
});

// ---------------------------------------------------------------------------
// /clear and /compact (spec 2026-10-17-claude-slash-commands)
// ---------------------------------------------------------------------------

describe('context commands in POST /api/chats/:id/turns', () => {
  const ATTACHMENTS = "A command can't carry attachments. Send /clear or /compact on its own.";

  /** Makes `profile-<i>` a Claude Code profile. */
  function claudeCode(i: number): void {
    container.store.connections.update(`conn-${i}`, { kind: 'claude_code' });
  }

  function useEvents(): AppEvent[] {
    const bus = new AppEventBus();
    const seen: AppEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    container.events = bus;
    return seen;
  }

  /** A finished Claude Code reply by `profileId` under a user message, returning its id. */
  function claudeReply(chatId: string, profileId: string, parts: Part[] = [{ type: 'text', text: 'Done.' }]): string {
    container.store.messages.create({ id: 'u0', chatId, parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null });
    const profile = container.store.profiles.get(profileId)!;
    container.store.messages.create({
      id: 'a0', chatId, parentId: 'u0', role: 'assistant', parts, status: 'complete', error: null,
      producedBy: { profileId, profileName: profile.name, connectionId: profile.connectionId, modelId: profile.modelId },
      engineMeta: { engine: 'claude_code', sessionId: 's1', backend: 'claude', cwd: 'E:\\x' },
    });
    return 'a0';
  }

  async function post(chatId: string, body: Record<string, unknown>) {
    return app().request(`/api/chats/${chatId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('typed /clear writes a line with no reply', async () => {
    const { chatId, profileIds } = seedChat(1);
    claudeCode(0);
    const parentId = claudeReply(chatId, profileIds[0]!);
    const closeChats = vi.fn();
    container.engine = { ...container.engine, closeChats };
    const seen = useEvents();
    const run = vi.spyOn(container.turnRunner, 'run');

    const res = await post(chatId, { parentId, parts: [{ type: 'text', text: ' /clear ' }], profileIds });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { userMessageId: string; assistantMessageIds: string[]; profileIds: string[]; userParts: Part[] };
    expect(body).toMatchObject({ assistantMessageIds: [], profileIds: [], userParts: [{ type: 'context', kind: 'clear' }] });
    expect(container.store.messages.get(body.userMessageId)).toMatchObject({ chatId, parentId, role: 'user', status: 'complete', parts: [{ type: 'context', kind: 'clear' }] });
    expect(container.store.chats.get(chatId)!.headMessageId).toBe(body.userMessageId);
    expect(closeChats).toHaveBeenCalledTimes(1);
    const gone = closeChats.mock.calls[0]![0] as (id: string) => boolean;
    expect(gone(chatId)).toBe(true);
    expect(gone('chat-other')).toBe(false);
    expect(seen).toContainEqual({ type: 'turn-started', chatId, messageIds: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it('/clear while a reply in the chat is streaming is refused, writing nothing', async () => {
    const { chatId, profileIds } = seedChat(1);
    claudeCode(0);
    const first = await post(chatId, { parts: [{ type: 'text', text: 'Hi' }], profileIds });
    const { userMessageId: asked, assistantMessageIds } = (await first.json()) as { userMessageId: string; assistantMessageIds: string[] };
    expect(container.store.messages.get(assistantMessageIds[0]!)!.status).toBe('streaming');
    const closeChats = vi.fn();
    container.engine = { ...container.engine, closeChats };

    const res = await post(chatId, { parentId: asked, parts: [{ type: 'text', text: '/clear' }], profileIds });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CLEAR_MID_REPLY });
    expect(CLEAR_MID_REPLY).toBe('Wait for the reply to finish, or stop it, before clearing.');
    expect(container.store.messages.children(asked).map((m) => m.id)).toEqual(assistantMessageIds);
    expect(container.store.chats.get(chatId)!.headMessageId).toBe(asked);
    expect(closeChats).not.toHaveBeenCalled();
  });

  it('/clear text with only API profiles is an ordinary message', async () => {
    const { chatId, profileIds } = seedChat(1);

    const res = await post(chatId, { parts: [{ type: 'text', text: '/clear' }], profileIds });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { userMessageId: string; assistantMessageIds: string[]; profileIds: string[]; userParts: Part[] };
    expect(body.assistantMessageIds).toHaveLength(1);
    expect(body.profileIds).toEqual(profileIds);
    expect(body.userParts).toEqual([{ type: 'text', text: '/clear' }]);
    expect(container.store.messages.get(body.userMessageId)!.parts).toEqual([{ type: 'text', text: '/clear' }]);
  });

  it('a clear name in any case is a clear', async () => {
    const { chatId, profileIds } = seedChat(1);
    claudeCode(0);
    const parentId = claudeReply(chatId, profileIds[0]!);

    const res = await post(chatId, { parentId, parts: [{ type: 'text', text: '/Clear' }], profileIds });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { assistantMessageIds: string[]; userParts: Part[] };
    expect(body).toMatchObject({ assistantMessageIds: [], userParts: [{ type: 'context', kind: 'clear' }] });
  });

  it('a clear name with text after it is refused in a Claude Code chat, writing nothing', async () => {
    const { chatId, profileIds } = seedChat(1);
    claudeCode(0);
    const parentId = claudeReply(chatId, profileIds[0]!);
    const run = vi.spyOn(container.turnRunner, 'run');

    for (const text of ['/clear now', '/Reset everything', '/NEW chat']) {
      const res = await post(chatId, { parentId, parts: [{ type: 'text', text }], profileIds });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: CLEAR_ON_ITS_OWN });
    }
    expect(CLEAR_ON_ITS_OWN).toBe('Send /clear on its own.');
    expect(container.store.messages.children(parentId)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('/clear now with only API profiles is an ordinary message', async () => {
    const { chatId, profileIds } = seedChat(1);

    const res = await post(chatId, { parts: [{ type: 'text', text: '/clear now' }], profileIds });

    expect(res.status).toBe(202);
    expect(((await res.json()) as { userParts: Part[] }).userParts).toEqual([{ type: 'text', text: '/clear now' }]);
  });

  it('/clear with an attachment is refused', async () => {
    const { chatId, profileIds } = seedChat(1);
    claudeCode(0);

    const res = await post(chatId, { parts: [{ type: 'text', text: '/clear' }, { type: 'image', attachmentId: 'att-1', mime: 'image/png' }], profileIds });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(ATTACHMENTS);
    expect(container.store.messages.roots(chatId)).toEqual([]);
  });

  it('an explicit clear part is a line whatever the profiles', async () => {
    const { chatId, profileIds } = seedChat(1);

    const res = await post(chatId, { parts: [{ type: 'context', kind: 'clear' }], profileIds });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };
    expect(body.assistantMessageIds).toEqual([]);
    expect(container.store.messages.get(body.userMessageId)!.parts).toEqual([{ type: 'context', kind: 'clear' }]);
  });

  it("/compact runs on the reply above's profile", async () => {
    const { chatId, profileIds } = seedChat(2);
    claudeCode(0);
    claudeCode(1);
    const parentId = claudeReply(chatId, 'profile-1');

    const res = await post(chatId, { parentId, parts: [{ type: 'text', text: '/compact  the API work ' }], profileIds });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { userMessageId: string; assistantMessageIds: string[]; profileIds: string[]; userParts: Part[] };
    expect(body.profileIds).toEqual(['profile-1']);
    expect(body.assistantMessageIds).toHaveLength(1);
    expect(body.userParts).toEqual([{ type: 'context', kind: 'compact', focus: 'the API work' }]);
    expect(container.store.messages.get(body.userMessageId)!.parts).toEqual([{ type: 'context', kind: 'compact', focus: 'the API work' }]);
    expect(container.store.messages.get(body.assistantMessageIds[0]!)!.producedBy!.profileId).toBe('profile-1');
  });

  it('/compact with nothing to compact', async () => {
    const { chatId, profileIds } = seedChat(2);
    claudeCode(0);
    container.store.messages.create({ id: 'u1', chatId, parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null });
    container.store.messages.create({
      id: 'api-reply', chatId, parentId: 'u1', role: 'assistant', parts: [{ type: 'text', text: 'Hello' }], status: 'complete', error: null,
      producedBy: { profileId: 'profile-1', profileName: 'Profile 1', connectionId: 'conn-1', modelId: 'model-x' },
    });

    for (const parentId of [null, 'u1', 'api-reply']) {
      const res = await post(chatId, { parentId, parts: [{ type: 'text', text: '/compact' }], profileIds });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: NOTHING_TO_COMPACT });
    }
    expect(container.store.messages.roots(chatId).map((m) => m.id)).toEqual(['u1']);
    expect(container.store.messages.children('u1').map((m) => m.id)).toEqual(['api-reply']);
    expect(container.store.messages.children('api-reply')).toEqual([]);
  });

  it("a client can't send a context-summary part", async () => {
    const { chatId, profileIds } = seedChat(1);
    const res = await post(chatId, { parts: [{ type: 'context-summary', text: 'All of it.' }], profileIds });
    expect(res.status).toBe(400);
  });

  it('a context part must name clear or compact, with a string focus', async () => {
    const { chatId, profileIds } = seedChat(1);
    for (const part of [{ type: 'context', kind: 'forget' }, { type: 'context' }, { type: 'context', kind: 'compact', focus: 7 }]) {
      const res = await post(chatId, { parts: [part], profileIds });
      expect(res.status).toBe(400);
    }
  });

  it('helper cards end as stopped after /clear', async () => {
    const { chatId, profileIds } = seedChat(1);
    claudeCode(0);
    const card: Part = {
      type: 'subagent', callId: 'call-1', label: 'implementer', prompt: 'do it', profileId: 'profile-0', profileName: 'Profile 0', modelId: 'model-x',
      status: 'background', parts: [],
    };
    const parentId = claudeReply(chatId, profileIds[0]!, [{ type: 'text', text: 'Started a helper.' }, card]);
    const changed: string[] = [];
    container.streamRegistry.subscribe(chatId, (e) => changed.push(e.type));

    const res = await post(chatId, { parentId, parts: [{ type: 'text', text: '/clear' }], profileIds });

    expect(res.status).toBe(202);
    const stored = container.store.messages.get(parentId)!.parts.find((p) => p.type === 'subagent');
    expect(stored).toMatchObject({ type: 'subagent', status: 'cancelled' });
    expect(changed).toContain('messages-changed');
  });
});
