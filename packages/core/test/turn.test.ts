import { describe, it, expect, vi } from 'vitest';
import type { ChatEngine, EngineEvent, EngineRequest } from '../src/ports/chat-engine.js';
import type { Connection, ResolvedProfile } from '../src/types/config.js';
import type { Part } from '../src/types/messages.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import { TurnRunner, type TurnEvent } from '../src/domain/turn.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'Test Connection',
    kind: 'mock',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
    ...overrides,
  };
}

function makeResolvedProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
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
    connection: makeConnection(),
    apiKey: null,
    model: null,
    ...overrides,
  };
}

/**
 * A `ChatEngine` whose stream for each request is driven entirely by hand
 * via `push(messageId, event | null)`, keyed by `EngineRequest.messageId`
 * (which the TurnRunner allocates and persists before calling `stream()`,
 * so it is a stable per-variant key). Unlike `FakeChatEngine`
 * (packages/core/src/testing/fakes.ts), which replays a fixed script with
 * no way to pause mid-stream, this lets a test interleave assertions
 * *between* individual events -- needed to test the 500ms checkpoint
 * throttle and per-variant isolation deterministically, without real
 * delays or timing flakiness.
 *
 * `push(messageId, null)` ends that variant's stream cleanly (as if the
 * engine returned with no further events -- e.g. after an abort).
 */
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
        // Mirrors real engines (and FakeChatEngine): the stream ends itself
        // after a terminal event, it does not wait to be asked for more.
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

/** Waits for pending microtasks (promise chains already scheduled) to settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** A step-controllable clock for deterministic checkpoint-throttle tests. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
}

function textParts(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TurnRunner.run', () => {
  it('persists the user message beneath parentId, then creates one streaming assistant row per profile, and returns immediately', async () => {
    const store = new InMemoryStore();
    const { engine } = manualEngine();
    const runner = new TurnRunner(store, engine);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hello' }],
      profiles: [makeResolvedProfile({ id: 'profile-a' }), makeResolvedProfile({ id: 'profile-b' })],
    });

    const userMessage = store.messages.get(result.userMessageId);
    expect(userMessage).toMatchObject({ chatId: 'chat-1', parentId: null, role: 'user', status: 'complete' });
    expect(textParts(userMessage!.parts)).toBe('Hello');

    expect(result.assistantMessageIds).toHaveLength(2);
    for (const id of result.assistantMessageIds) {
      const assistantMessage = store.messages.get(id);
      expect(assistantMessage).toMatchObject({
        chatId: 'chat-1',
        parentId: result.userMessageId,
        role: 'assistant',
        status: 'streaming',
      });
    }
  });

  it('runs each profile concurrently with its own AbortController, and does not move head_message_id', async () => {
    const store = new InMemoryStore();
    const chat = store.chats.create({
      id: 'chat-1',
      title: 'Test',
      profileId: 'profile-a',
      headMessageId: 'some-earlier-message',
      workspaceRoot: null,
      pinned: false,
      archivedAt: null,
    });
    const { engine, push, requests } = manualEngine();
    const runner = new TurnRunner(store, engine);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Compare these' }],
      profiles: [makeResolvedProfile({ id: 'profile-a' }), makeResolvedProfile({ id: 'profile-b' })],
    });
    await flush();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.signal).not.toBe(requests[1]?.signal);

    push(result.assistantMessageIds[0] as string, { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' });
    push(result.assistantMessageIds[1] as string, { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' });
    await flush();

    expect(store.chats.get(chat.id)?.headMessageId).toBe('some-earlier-message');
  });

  it('checkpoints partial parts to the store at most every 500ms while streaming', async () => {
    const store = new InMemoryStore();
    const spy = vi.spyOn(store.messages, 'updateParts');
    const { engine, push } = manualEngine();
    const clock = fakeClock();
    const runner = new TurnRunner(store, engine, { now: clock.now, checkpointIntervalMs: 500 });

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Go' }],
      profiles: [makeResolvedProfile()],
    });
    await flush();
    const messageId = result.assistantMessageIds[0] as string;
    spy.mockClear();

    // Five deltas, all within one 500ms window: the throttle should collapse
    // these into far fewer store writes than events.
    for (let i = 0; i < 5; i++) {
      push(messageId, { type: 'text-delta', text: `chunk${i} ` });
      await flush();
    }
    const callsWithinWindow = spy.mock.calls.length;
    expect(callsWithinWindow).toBeLessThan(5);

    // Advance the clock past the throttle window and deliver one more delta:
    // this one must be written (a fresh window has opened).
    clock.advance(600);
    push(messageId, { type: 'text-delta', text: 'chunk5' });
    await flush();
    expect(spy.mock.calls.length).toBeGreaterThan(callsWithinWindow);

    // No content is lost regardless of throttling: the final flush on
    // completion always reflects every delta received.
    push(messageId, { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' });
    await flush();
    const final = store.messages.get(messageId);
    expect(textParts(final!.parts)).toBe('chunk0 chunk1 chunk2 chunk3 chunk4 chunk5');
  });

  it('on finish: writes final parts, sets complete, and writes a usage row with a pricing_snapshot taken from the model row at that moment', async () => {
    const store = new InMemoryStore();
    store.connections.create(makeConnection());
    const model = store.models.create({
      id: 'model-row-1',
      connectionId: 'conn-1',
      modelId: 'model-1',
      displayName: 'Test Model',
      source: 'manual',
      supportsVision: false,
      supportsTools: false,
      supportsReasoning: false,
      contextWindow: null,
      maxOutput: null,
      priceInPer1m: 10,
      priceOutPer1m: 30,
      priceCachedPer1m: 1,
      currency: 'USD',
    });
    const profile = makeResolvedProfile({ model });
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hi' }],
      profiles: [profile],
    });
    await flush();
    const messageId = result.assistantMessageIds[0] as string;

    push(messageId, { type: 'text-delta', text: 'Hello there' });
    await flush();
    push(messageId, {
      type: 'finish',
      usage: { tokensIn: 100, tokensOut: 50, tokensCached: 10, tokensReasoning: 0 },
      finishReason: 'stop',
    });
    await flush();

    const finalMessage = store.messages.get(messageId);
    expect(finalMessage?.status).toBe('complete');
    expect(textParts(finalMessage!.parts)).toBe('Hello there');

    const usageRows = store.usage.list('chat-1');
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      chatId: 'chat-1',
      messageId,
      profileId: profile.id,
      tokensIn: 100,
      tokensOut: 50,
      tokensCached: 10,
      pricingSnapshot: { priceInPer1m: 10, priceOutPer1m: 30, priceCachedPer1m: 1, currency: 'USD' },
    });
    expect(usageRows[0]?.costEstimate).not.toBeNull();
  });

  it('one variant failing leaves siblings running (per-variant isolation)', async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);
    const events: TurnEvent[] = [];
    runner.on((e) => events.push(e));

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Compare' }],
      profiles: [makeResolvedProfile({ id: 'profile-a' }), makeResolvedProfile({ id: 'profile-b' })],
    });
    await flush();
    const [failingId, survivorId] = result.assistantMessageIds as [string, string];

    // The failing variant errors out immediately.
    push(failingId, { type: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } });
    await flush();

    expect(store.messages.get(failingId)?.status).toBe('error');
    // The sibling is completely unaffected: still streaming, and can go on
    // to receive further events and complete normally.
    expect(store.messages.get(survivorId)?.status).toBe('streaming');

    push(survivorId, { type: 'text-delta', text: 'Still going' });
    await flush();
    expect(store.messages.get(survivorId)?.status).toBe('streaming');
    // The delta itself was observed live (checkpointing to the store is
    // throttled -- covered by its own test -- but the event still fires).
    expect(events).toContainEqual({ messageId: survivorId, type: 'text-delta', text: 'Still going' });

    push(survivorId, { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' });
    await flush();
    expect(store.messages.get(survivorId)?.status).toBe('complete');
    // The final flush on completion always reflects the accumulated content.
    expect(textParts(store.messages.get(survivorId)!.parts)).toBe('Still going');

    const statusEvents = events.filter((e): e is TurnEvent & { type: 'status' } => e.type === 'status');
    expect(statusEvents).toContainEqual({ messageId: failingId, type: 'status', status: 'error' });
    expect(statusEvents).toContainEqual({ messageId: survivorId, type: 'status', status: 'complete' });
  });

  it('cancel(messageId) aborts one variant, marks it cancelled, and retains partial content and usage so far', async () => {
    const store = new InMemoryStore();
    const { engine, push, requests } = manualEngine();
    const runner = new TurnRunner(store, engine);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Go' }],
      profiles: [makeResolvedProfile({ id: 'profile-a' }), makeResolvedProfile({ id: 'profile-b' })],
    });
    await flush();
    const [cancelledId, otherId] = result.assistantMessageIds as [string, string];

    push(cancelledId, { type: 'text-delta', text: 'Partial answer' });
    await flush();

    runner.cancel(cancelledId);
    await flush();

    const cancelledReq = requests.find((r) => r.messageId === cancelledId);
    expect(cancelledReq?.signal.aborted).toBe(true);
    const otherReq = requests.find((r) => r.messageId === otherId);
    expect(otherReq?.signal.aborted).toBe(false);

    const cancelledMessage = store.messages.get(cancelledId);
    expect(cancelledMessage?.status).toBe('cancelled');
    expect(textParts(cancelledMessage!.parts)).toBe('Partial answer');

    // The sibling is untouched by the cancellation.
    expect(store.messages.get(otherId)?.status).toBe('streaming');

    // Usage is retained too: the engine never emitted a `finish` for the
    // cancelled variant (manualEngine ends the stream cleanly on abort, like
    // every real engine observed so far -- see the comment in turn.ts), so
    // there is no source of partial token counts. A zeroed usage row is
    // written anyway so the cancellation is never invisible to
    // usage.list()/billing views -- this is a documented limitation of the
    // current ChatEngine port (no incremental-usage event), not an estimate.
    const usageRows = store.usage.list('chat-1');
    const cancelledUsage = usageRows.find((u) => u.messageId === cancelledId);
    expect(cancelledUsage).toBeDefined();
    expect(cancelledUsage).toMatchObject({
      chatId: 'chat-1',
      messageId: cancelledId,
      profileId: 'profile-a',
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      tokensReasoning: 0,
    });
    // The still-streaming sibling has no usage row yet -- it hasn't finished
    // or been cancelled, so nothing should have been written for it.
    expect(usageRows.some((u) => u.messageId === otherId)).toBe(false);
  });

  it('a throwing listener does not corrupt the variant or block other listeners from receiving every event', async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);

    // Registered first, so (if unwrapped) its throw would abort `emit`'s
    // loop before the healthy listener below ever runs -- and, because
    // `emit()` is called from inside `runVariant`'s own try block, the
    // synchronous throw would propagate out and be misclassified as a
    // provider error via `classifyProviderError`.
    runner.on(() => {
      throw new Error('listener boom');
    });
    const healthyEvents: TurnEvent[] = [];
    runner.on((e) => healthyEvents.push(e));

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hi' }],
      profiles: [makeResolvedProfile()],
    });
    await flush();
    const messageId = result.assistantMessageIds[0] as string;

    push(messageId, { type: 'text-delta', text: 'Hello' });
    await flush();
    push(messageId, { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' });
    await flush();

    // The variant completed normally -- the throwing listener never leaked
    // into runVariant's own error handling.
    const finalMessage = store.messages.get(messageId);
    expect(finalMessage?.status).toBe('complete');
    expect(textParts(finalMessage!.parts)).toBe('Hello');

    // The healthy listener still received every event, in order.
    expect(healthyEvents.map((e) => e.type)).toEqual(['text-delta', 'finish', 'status']);
  });

  it('does not move head_message_id even after every variant completes', async () => {
    const store = new InMemoryStore();
    const chat = store.chats.create({
      id: 'chat-1',
      title: 'Test',
      profileId: 'profile-a',
      headMessageId: null,
      workspaceRoot: null,
      pinned: false,
      archivedAt: null,
    });
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hi' }],
      profiles: [makeResolvedProfile()],
    });
    await flush();
    const messageId = result.assistantMessageIds[0] as string;

    push(messageId, { type: 'text-delta', text: 'Done' });
    push(messageId, { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' });
    await flush();

    expect(store.messages.get(messageId)?.status).toBe('complete');
    expect(store.chats.get(chat.id)?.headMessageId).toBeNull();
  });
});
