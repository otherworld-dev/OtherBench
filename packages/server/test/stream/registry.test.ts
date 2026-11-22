import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeToolProvider, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { TurnRunner, type TurnEvent } from '@otherbench/core/domain/turn.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { ToolApprovalEvent, ToolProvider } from '@otherbench/core/ports/tool-provider.js';
import type { Connection, ModelInfo, ResolvedProfile } from '@otherbench/core/types/config.js';
import { applySubagentEvent, type SubagentEvent } from '@otherbench/core/domain/parts.js';
import type { Part } from '@otherbench/core/types/messages.js';
import { withEvent } from '../../src/peer/forward.js';
import { StreamRegistry, type ChatStreamEvent } from '../../src/stream/registry.js';

// ---------------------------------------------------------------------------
// Fixtures -- same "manual" engine technique as packages/core/test/turn.test.ts:
// a per-messageId gated stream, so a test can interleave assertions between
// individual events without real delays.
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

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'model-1',
    connectionId: 'conn-1',
    modelId: 'test-model',
    displayName: 'Test Model',
    source: 'manual',
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    contextWindow: null,
    maxOutput: null,
    priceInPer1m: null,
    priceOutPer1m: null,
    priceCachedPer1m: null,
    currency: 'USD',
    ...overrides,
  };
}

function manualEngine(): {
  engine: ChatEngine;
  push: (messageId: string, event: EngineEvent | null) => void;
} {
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

const FINISH: EngineEvent = { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamRegistry', () => {
  it('registerTurn seeds an empty streaming buffer per message before any event arrives', async () => {
    const store = new InMemoryStore();
    const { engine } = manualEngine();
    const runner = new TurnRunner(store, engine);
    const registry = new StreamRegistry(runner, store);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hi' }],
      profiles: [makeResolvedProfile()],
    });
    registry.registerTurn('chat-1', result.assistantMessageIds);

    const snapshot = registry.snapshot('chat-1');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ messageId: result.assistantMessageIds[0], status: 'streaming', events: [] });
  });

  it('two subscribers to one turn both receive every event, in order', async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);
    const registry = new StreamRegistry(runner, store);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hi' }],
      profiles: [makeResolvedProfile()],
    });
    registry.registerTurn('chat-1', result.assistantMessageIds);
    const messageId = result.assistantMessageIds[0] as string;

    const receivedA: ChatStreamEvent[] = [];
    const receivedB: ChatStreamEvent[] = [];
    registry.subscribe('chat-1', (e) => receivedA.push(e));
    registry.subscribe('chat-1', (e) => receivedB.push(e));

    push(messageId, { type: 'text-delta', text: 'Hello' });
    await flush();
    push(messageId, FINISH);
    await flush();

    expect(receivedA).toEqual(receivedB);
    expect(receivedA.map((e) => e.type)).toEqual(['text-delta', 'finish', 'status']);
  });

  it('a subscriber attaching mid-stream gets replay (from the snapshot) then live events, with no gap and no duplication', async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);
    const registry = new StreamRegistry(runner, store);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hi' }],
      profiles: [makeResolvedProfile()],
    });
    registry.registerTurn('chat-1', result.assistantMessageIds);
    const messageId = result.assistantMessageIds[0] as string;

    push(messageId, { type: 'text-delta', text: 'First ' });
    await flush();
    push(messageId, { type: 'text-delta', text: 'second ' });
    await flush();

    // A late subscriber attaches here -- exactly as the SSE route does:
    // read the snapshot, THEN subscribe, synchronously back to back.
    const replay = registry.snapshot('chat-1').flatMap((b) => b.events);
    const live: ChatStreamEvent[] = [];
    registry.subscribe('chat-1', (e) => live.push(e));

    push(messageId, { type: 'text-delta', text: 'third' });
    await flush();
    push(messageId, FINISH);
    await flush();

    const combined = [...replay, ...live];
    const textDeltas = combined.filter((e): e is TurnEvent & { type: 'text-delta' } => e.type === 'text-delta');
    // The replay holds the two it missed as one delta (a run of text is kept joined): the same text, in order.
    expect(textDeltas.map((e) => e.text)).toEqual(['First second ', 'third']);
    // No duplication: the two events already in the replay must not also
    // appear in what the live subscription delivered.
    expect(live.filter((e) => e.type === 'text-delta')).toHaveLength(1);
  });

  it('cancelling one message leaves the chat subscription open and the other message streaming', async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);
    const registry = new StreamRegistry(runner, store);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Compare' }],
      profiles: [makeResolvedProfile({ id: 'profile-a' }), makeResolvedProfile({ id: 'profile-b' })],
    });
    registry.registerTurn('chat-1', result.assistantMessageIds);
    const [cancelledId, otherId] = result.assistantMessageIds as [string, string];

    const received: ChatStreamEvent[] = [];
    const unsubscribe = registry.subscribe('chat-1', (e) => received.push(e));

    runner.cancel(cancelledId);
    await flush();

    push(otherId, { type: 'text-delta', text: 'still streaming' });
    await flush();
    push(otherId, FINISH);
    await flush();

    expect(received).toContainEqual({ messageId: cancelledId, type: 'status', status: 'cancelled' });
    expect(received).toContainEqual({ messageId: otherId, type: 'text-delta', text: 'still streaming' });
    expect(received).toContainEqual({ messageId: otherId, type: 'status', status: 'complete' });

    unsubscribe();
  });

  it('a throwing subscriber does not stop fan-out or block the other subscriber from receiving every event', async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);
    const registry = new StreamRegistry(runner, store);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hi' }],
      profiles: [makeResolvedProfile()],
    });
    registry.registerTurn('chat-1', result.assistantMessageIds);
    const messageId = result.assistantMessageIds[0] as string;

    // Registered first, so (if unwrapped) its throw would abort the fan-out
    // loop in `handleEvent` before the healthy subscriber below ever runs.
    registry.subscribe('chat-1', () => {
      throw new Error('subscriber boom');
    });
    const received: ChatStreamEvent[] = [];
    registry.subscribe('chat-1', (e) => received.push(e));

    push(messageId, { type: 'text-delta', text: 'Hello' });
    await flush();
    push(messageId, FINISH);
    await flush();

    expect(received.map((e) => e.type)).toEqual(['text-delta', 'finish', 'status']);
    // The variant's own persisted state is unaffected by the throwing subscriber.
    expect(store.messages.get(messageId)?.status).toBe('complete');
  });

  it('leaves a finished reply to the stored messages when the in-memory log is lost (a server restart), and still gives one the store says is being written', async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);
    const registry = new StreamRegistry(runner, store);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hi' }],
      profiles: [makeResolvedProfile()],
    });
    registry.registerTurn('chat-1', result.assistantMessageIds);
    const messageId = result.assistantMessageIds[0] as string;

    push(messageId, { type: 'text-delta', text: 'Hello ' });
    await flush();
    push(messageId, { type: 'text-delta', text: 'world' });
    await flush();
    push(messageId, FINISH);
    await flush();

    // Simulate a server restart: a brand-new registry over the SAME store, with no buffer for this message id.
    const freshRegistry = new StreamRegistry(new TurnRunner(store, engine), store);
    // The reply is finished and stored: `GET /chats/:id/messages` has all of it, so the hello says nothing of it.
    expect(freshRegistry.snapshot('chat-1')).toEqual([]);

    // A row still marked as being written, with no buffer (nothing does this today: startup closes such rows): the
    // hello still says so, from its last checkpoint, rather than leave a client showing it with no way to hear more.
    store.messages.create({ id: 'stuck', chatId: 'chat-1', parentId: null, role: 'assistant', parts: [{ type: 'text', text: 'Half' }], status: 'streaming', error: null, producedBy: null });
    expect(freshRegistry.snapshot('chat-1')).toEqual([
      { chatId: 'chat-1', messageId: 'stuck', status: 'streaming', events: [{ messageId: 'stuck', type: 'text-delta', text: 'Half' }, { messageId: 'stuck', type: 'status', status: 'streaming' }] },
    ]);
  });

  it("the hello holds the chat's replies being written and those just finished, never its history", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const { engine, push } = manualEngine();
      const runner = new TurnRunner(store, engine);
      const registry = new StreamRegistry(runner, store, { retentionMs: 60_000 });
      const reply = async (chatId: string, parentId: string | null): Promise<string> => {
        const result = await runner.run({ chatId, parentId, userParts: [{ type: 'text', text: 'Hi' }], profiles: [makeResolvedProfile()] });
        registry.registerTurn(chatId, result.assistantMessageIds);
        return result.assistantMessageIds[0] as string;
      };
      const finish = async (id: string, text: string): Promise<void> => {
        push(id, { type: 'text-delta', text });
        await vi.advanceTimersByTimeAsync(0);
        push(id, FINISH);
        await vi.advanceTimersByTimeAsync(0);
      };

      // Long finished: out of the buffer's keeping.
      const old = await reply('chat-1', null);
      await finish(old, 'An old answer.');
      await vi.advanceTimersByTimeAsync(61_000);
      // Just finished: a client that loaded the messages a moment ago may have it as still being written.
      const recent = await reply('chat-1', old);
      await finish(recent, 'A fresh answer.');
      // Being written.
      const writing = await reply('chat-1', recent);
      push(writing, { type: 'text-delta', text: 'So far' });
      await vi.advanceTimersByTimeAsync(0);
      // Another chat's reply is its own chat's business.
      const elsewhere = await reply('chat-2', null);

      const hello = registry.snapshot('chat-1');
      expect(hello.map((b) => [b.messageId, b.status])).toEqual([[recent, 'complete'], [writing, 'streaming']]);
      expect(hello.map((b) => b.messageId)).not.toContain(old);
      expect(hello.map((b) => b.messageId)).not.toContain(elsewhere);
      // Each is whole: replaying the finished one gives the reply as stored, and the other all of it so far
      // (its row only has its last checkpoint).
      expect(hello[0]!.events.reduce(withEvent, [])).toEqual(store.messages.get(recent)!.parts);
      expect(hello[1]!.events.reduce(withEvent, [])).toEqual([{ type: 'text', text: 'So far' }]);
      expect(store.messages.get(old)).toMatchObject({ status: 'complete', parts: [{ type: 'text', text: 'An old answer.' }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconstructs a notice event (task 21 capability-fallback disclosure) from a persisted notice part -- not silently dropped in the DB-fallback path', () => {
    const store = new InMemoryStore();
    store.chats.create({
      id: 'chat-1', title: 'Test', profileId: 'profile-a', headMessageId: null,
      workspaceRoot: null, pinned: false, archivedAt: null,
    });
    store.messages.create({
      id: 'assistant-1',
      chatId: 'chat-1',
      parentId: null,
      role: 'assistant',
      parts: [
        { type: 'notice', text: '1 image attachment ("photo.png") sent as text because this model does not support image input.' },
        { type: 'text', text: 'Based on the description, it looks like a sunset.' },
      ],
      status: 'streaming',
      error: null,
      producedBy: null,
    });
    const { engine } = manualEngine();
    const runner = new TurnRunner(store, engine);
    // No live buffer at all for 'assistant-1' -- this registry never saw a
    // `run()`/`registerTurn()` for it, forcing `snapshot()` down the
    // DB-fallback (`reconstructEvents`) path exclusively, same as the
    // "falls back to the persisted message row" test above.
    const registry = new StreamRegistry(runner, store);

    const buffer = registry.snapshot('chat-1').find((b) => b.messageId === 'assistant-1');

    expect(buffer).toBeDefined();
    // Order preserved: the notice comes before the text, matching `parts`.
    expect(buffer!.events.map((e) => e.type)).toEqual(['notice', 'text-delta', 'status']);
    const notice = buffer!.events.find((e): e is TurnEvent & { type: 'notice' } => e.type === 'notice');
    expect(notice?.text).toContain('does not support image input');
  });

  it('rebuilds a stored context-summary part into a context-summary event', () => {
    const store = new InMemoryStore();
    store.chats.create({ id: 'chat-1', title: 'Test', profileId: 'profile-a', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    store.messages.create({
      id: 'assistant-1', chatId: 'chat-1', parentId: null, role: 'assistant', status: 'streaming', error: null, producedBy: null,
      parts: [{ type: 'context-summary', text: 'S', preTokens: 100, postTokens: 10 }],
    });
    const { engine } = manualEngine();
    const registry = new StreamRegistry(new TurnRunner(store, engine), store);

    const buffer = registry.snapshot('chat-1').find((b) => b.messageId === 'assistant-1')!;
    expect(buffer.events).toContainEqual({ messageId: 'assistant-1', type: 'context-summary', text: 'S', preTokens: 100, postTokens: 10 });
  });

  it('rebuilds a stored history-summary part into a history-summary event', () => {
    const store = new InMemoryStore();
    store.chats.create({ id: 'chat-1', title: 'Test', profileId: 'profile-a', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const part: Part = { type: 'history-summary', uptoMessageId: 'a4', covered: 'hash', text: 'What came before.' };
    store.messages.create({ id: 'assistant-1', chatId: 'chat-1', parentId: null, role: 'assistant', status: 'streaming', error: null, producedBy: null, parts: [part, { type: 'text', text: 'Hi' }] });
    const { engine } = manualEngine();
    const registry = new StreamRegistry(new TurnRunner(store, engine), store);

    const buffer = registry.snapshot('chat-1').find((b) => b.messageId === 'assistant-1')!;
    expect(buffer.events).toContainEqual({ messageId: 'assistant-1', type: 'history-summary', part });
  });

  it('rebuilds a user-note part as a user-note event', () => {
    const store = new InMemoryStore();
    store.chats.create({ id: 'chat-1', title: 'Test', profileId: 'profile-a', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const note: Part = { type: 'user-note', noteId: 'note-1', text: 'also check the tests', attachments: [{ attachmentId: 'att-1', mime: 'image/png', filename: 'shot.png' }] };
    store.messages.create({
      id: 'assistant-1', chatId: 'chat-1', parentId: null, role: 'assistant', status: 'streaming', error: null, producedBy: null,
      parts: [{ type: 'text', text: 'Looking.' }, note, { type: 'text', text: 'Checked them too.' }],
    });
    const { engine } = manualEngine();
    const registry = new StreamRegistry(new TurnRunner(store, engine), store);

    const buffer = registry.snapshot('chat-1').find((b) => b.messageId === 'assistant-1')!;
    expect(buffer.events).toEqual([
      { messageId: 'assistant-1', type: 'text-delta', text: 'Looking.' },
      { messageId: 'assistant-1', type: 'user-note', part: note },
      { messageId: 'assistant-1', type: 'text-delta', text: 'Checked them too.' },
      { messageId: 'assistant-1', type: 'status', status: 'streaming' },
    ]);
  });

  it('rebuilds a stored subagent part into subagent events that fold back to the same part', () => {
    const store = new InMemoryStore();
    store.chats.create({ id: 'chat-1', title: 'Test', profileId: 'profile-a', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const part: Part = {
      type: 'subagent', callId: 'call-1', label: 'Helper', prompt: 'Look.', profileId: 'p', profileName: 'P', modelId: 'm', status: 'complete',
      usage: { tokensIn: 3, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 },
      parts: [{ type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'a' } }, { type: 'text', text: 'Found.' }],
    };
    store.messages.create({ id: 'assistant-1', chatId: 'chat-1', parentId: null, role: 'assistant', parts: [{ type: 'text', text: 'Asking.' }, part], status: 'streaming', error: null, producedBy: null });
    const { engine } = manualEngine();
    const registry = new StreamRegistry(new TurnRunner(store, engine), store);

    const buffer = registry.snapshot('chat-1').find((b) => b.messageId === 'assistant-1')!;
    expect(buffer.events.map((e) => e.type)).toEqual(['text-delta', 'subagent', 'subagent', 'subagent', 'subagent', 'subagent', 'status']);
    const rebuilt = buffer.events
      .filter((e): e is TurnEvent & { type: 'subagent' } => e.type === 'subagent')
      .reduce<Part[]>((parts, e) => applySubagentEvent(parts, e.callId, e.event), []);
    expect(rebuilt).toEqual([part]);
  });

  it('the LIVE capability-fallback notice reaches StreamRegistry through a toolProvider-bearing TurnRunner, in the same run()-then-registerTurn() sequence routes/turns.ts uses', async () => {
    // NOTE ON WHAT THIS TEST DOES AND DOES NOT PROVE: building task 21
    // surfaced a real bug where this notice was silently dropped in
    // production -- `runVariant` emitted it eagerly, immediately after
    // `toolProvider.listTools()` resolved, which could beat
    // `routes/turns.ts`'s `registerTurn()` call in the real server
    // (`StreamRegistry.handleEvent` silently drops an event for a message
    // id it has no buffer for yet). That race depends on genuine
    // event-loop/I/O timing (a real `@hono/node-server` HTTP round trip) that
    // this in-process test -- and an equivalent one added directly against
    // `createApp()`'s real routes -- both turned out NOT to reproduce even
    // WITH the eager-emit bug deliberately reintroduced while verifying this
    // test (confirmed by hand, not left as an assertion here, since a test
    // that cannot fail is worse than none). The ONLY reproduction that
    // reliably catches this class of bug is a real browser against a real
    // running server: packages/web/e2e/attachments.spec.ts. This test still
    // has standalone value -- it exercises the deferred-emit code path
    // (TurnRunner.runVariant) end to end through a real `ToolProvider` shape
    // and a real `StreamRegistry`, verifying the notice is delivered
    // correctly under normal conditions -- it is just not a regression
    // guard for the specific timing bug.
    const store = new InMemoryStore();
    store.chats.create({
      id: 'chat-1', title: 'Test', profileId: 'profile-a', headMessageId: null,
      workspaceRoot: null, pinned: false, archivedAt: null,
    });
    store.attachments.create({
      id: 'att-1', chatId: 'chat-1', messageId: null, filename: 'photo.png',
      mime: 'image/png', size: 10, sha256: 'x', storagePath: '/x', extractedText: null,
    });
    const { engine, push } = manualEngine();
    const toolProvider = new FakeToolProvider();
    const runner = new TurnRunner(store, engine, { toolProvider });
    const registry = new StreamRegistry(runner, store);
    const profile = makeResolvedProfile({ model: makeModel({ supportsVision: false }) });

    // Mirrors routes/turns.ts EXACTLY -- `await run()`, THEN
    // `registerTurn()` -- since that ordering (not test setup timing) is
    // what the real bug depended on.
    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'image', attachmentId: 'att-1', mime: 'image/png' }],
      profiles: [profile],
    });
    registry.registerTurn('chat-1', result.assistantMessageIds);
    const messageId = result.assistantMessageIds[0] as string;

    push(messageId, FINISH);
    await flush();

    const buffer = registry.snapshot('chat-1').find((b) => b.messageId === messageId);
    expect(buffer?.events.map((e) => e.type)).toContain('notice');
  });

  it('prefers the in-memory buffer over the DB fallback when both exist, so a message is never served from both at once', async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);
    const registry = new StreamRegistry(runner, store);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hi' }],
      profiles: [makeResolvedProfile()],
    });
    registry.registerTurn('chat-1', result.assistantMessageIds);
    const messageId = result.assistantMessageIds[0] as string;

    // Two deltas within one checkpoint window: the DB row's `parts` reflects
    // only what's been checkpointed, but the in-memory buffer has both raw
    // events.
    push(messageId, { type: 'text-delta', text: 'One ' });
    await flush();
    push(messageId, { type: 'text-delta', text: 'Two' });
    await flush();

    const snapshot = registry.snapshot('chat-1');
    expect(snapshot).toHaveLength(1); // not duplicated across both sources
    expect(snapshot[0]?.status).toBe('streaming');
  });

  it('evicts a completed buffer from memory after the retention window; the hello then leaves it to the stored messages', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const { engine, push } = manualEngine();
      const runner = new TurnRunner(store, engine);
      const registry = new StreamRegistry(runner, store, { retentionMs: 60_000 });

      const result = await runner.run({
        chatId: 'chat-1',
        parentId: null,
        userParts: [{ type: 'text', text: 'Hi' }],
        profiles: [makeResolvedProfile()],
      });
      registry.registerTurn('chat-1', result.assistantMessageIds);
      const messageId = result.assistantMessageIds[0] as string;

      push(messageId, FINISH);
      await vi.advanceTimersByTimeAsync(0);

      expect(registry.snapshot('chat-1')).toHaveLength(1);
      // Still the live buffer -- its full event history includes `finish`.
      expect(registry.snapshot('chat-1')[0]?.events.map((e) => e.type)).toContain('finish');

      await vi.advanceTimersByTimeAsync(59_000);
      expect(registry.snapshot('chat-1')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2_000);
      // The in-memory buffer is now evicted (bounding memory is the retention window's job), and a finished
      // reply isn't rebuilt from its row: the stored messages are where a client reads it from now on.
      expect(registry.snapshot('chat-1')).toEqual([]);
      expect(store.messages.get(messageId)?.status).toBe('complete');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetBuffer replaces a message buffer wholesale, so a retry never replays the failed attempt it followed', async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    const runner = new TurnRunner(store, engine);
    const registry = new StreamRegistry(runner, store);

    const result = await runner.run({
      chatId: 'chat-1',
      parentId: null,
      userParts: [{ type: 'text', text: 'Hi' }],
      profiles: [makeResolvedProfile()],
    });
    registry.registerTurn('chat-1', result.assistantMessageIds);
    const messageId = result.assistantMessageIds[0] as string;

    push(messageId, { type: 'text-delta', text: 'Partial before failing' });
    push(messageId, { type: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } });
    await flush();
    expect(registry.snapshot('chat-1')[0]?.events.map((e) => e.type)).toEqual(['text-delta', 'error', 'status']);

    registry.resetBuffer('chat-1', messageId);
    const afterReset = registry.snapshot('chat-1');
    expect(afterReset).toHaveLength(1);
    expect(afterReset[0]).toMatchObject({ messageId, status: 'streaming', events: [] });

    // Live events after the reset (from a retry) land on the fresh buffer,
    // with none of the failed attempt's history mixed in.
    const received: ChatStreamEvent[] = [];
    registry.subscribe('chat-1', (e) => received.push(e));
    void runner.retry('chat-1', messageId, makeResolvedProfile());
    push(messageId, { type: 'text-delta', text: 'Retried text' });
    await flush();
    expect(received.filter((e) => e.type === 'text-delta')).toEqual([{ messageId, type: 'text-delta', text: 'Retried text' }]);
    expect(registry.snapshot('chat-1')[0]?.events.filter((e) => e.type === 'text-delta')).toEqual([
      { messageId, type: 'text-delta', text: 'Retried text' },
    ]);
  });

  it('resetBuffer cancels a pending eviction timer, so a since-reset buffer is never wiped out by the old attempt\'s eviction', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const { engine, push } = manualEngine();
      const runner = new TurnRunner(store, engine);
      const registry = new StreamRegistry(runner, store, { retentionMs: 60_000 });

      const result = await runner.run({
        chatId: 'chat-1',
        parentId: null,
        userParts: [{ type: 'text', text: 'Hi' }],
        profiles: [makeResolvedProfile()],
      });
      registry.registerTurn('chat-1', result.assistantMessageIds);
      const messageId = result.assistantMessageIds[0] as string;

      push(messageId, { type: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } });
      await vi.advanceTimersByTimeAsync(0); // schedules eviction in 60s

      registry.resetBuffer('chat-1', messageId);
      await vi.advanceTimersByTimeAsync(61_000); // past the original eviction deadline

      // Still present and streaming -- the reset buffer was never evicted by the timer scheduled for the pre-reset attempt.
      const snapshot = registry.snapshot('chat-1');
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]).toMatchObject({ messageId, status: 'streaming', events: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('StreamRegistry and background work (spec 2026-10-17-claude-background-helpers-design)', () => {
  const helper = { taskId: 'k1', callId: 't1', kind: 'local_agent', label: 'implementer', startedAt: 1, lastActivity: 'Bash' };
  function setup() {
    const store = new InMemoryStore();
    let approvalListener: ((event: ToolApprovalEvent) => void) | null = null;
    const toolProvider = { onApprovalEvent: (cb: (event: ToolApprovalEvent) => void) => { approvalListener = cb; return () => {}; } } as unknown as ToolProvider;
    const runner = new TurnRunner(store, { stream: async function* () {}, listModels: async () => [], testConnection: async () => ({ ok: true, message: '', latencyMs: 0 }) }, { toolProvider });
    const registry = new StreamRegistry(runner, store);
    const got: unknown[] = [];
    registry.subscribe('c1', (e) => got.push(e));
    return { registry, got, approve: (event: ToolApprovalEvent) => approvalListener!(event) };
  }

  it('helpers reach subscribers and the hello', () => {
    const { registry, got } = setup();
    registry.setHelpers('c1', [helper]);
    expect(got).toEqual([{ type: 'helpers', chatId: 'c1', helpers: [helper] }]);
    expect(registry.chatState('c1')).toEqual({ helpers: [helper], backgroundApprovals: [] });
    registry.setHelpers('c1', []);
    expect(registry.chatState('c1').helpers).toEqual([]);
  });

  it('background approval reaches a chat subscriber, marked as no reply\'s own, and the hello, and leaves both when resolved', () => {
    const { registry, got, approve } = setup();
    const request = { id: 'r1', chatId: 'c1', messageId: 'm-old', toolName: 'Bash', risk: 'execute' as const, source: 'agent' as const, args: { command: 'npm test' }, summary: 'npm test', subagent: { callId: 't1', label: 'implementer', parentProfileId: 'p' } };
    approve({ type: 'request', request });
    expect(got).toEqual([{ messageId: 'm-old', type: 'approval-request', request, background: true }]);
    expect(registry.chatState('c1').backgroundApprovals).toEqual([request]);
    approve({ type: 'resolved', requestId: 'r1', messageId: 'm-old', choice: 'once' });
    expect(got.at(-1)).toEqual({ messageId: 'm-old', type: 'approval-resolved', requestId: 'r1', choice: 'once', background: true });
    expect(registry.chatState('c1').backgroundApprovals).toEqual([]);
  });

  it("a helper's approval soon after its reply finished is a background one, though the reply's buffer is still kept", async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    let approvalListener: ((event: ToolApprovalEvent) => void) | null = null;
    const toolProvider = new FakeToolProvider();
    const listen = toolProvider.onApprovalEvent.bind(toolProvider);
    toolProvider.onApprovalEvent = (cb) => {
      approvalListener = cb;
      return listen(cb);
    };
    const runner = new TurnRunner(store, engine, { toolProvider });
    const registry = new StreamRegistry(runner, store, { retentionMs: 60_000 });
    const result = await runner.run({ chatId: 'c1', parentId: null, userParts: [{ type: 'text', text: 'Hi' }], profiles: [makeResolvedProfile()] });
    registry.registerTurn('c1', result.assistantMessageIds);
    const messageId = result.assistantMessageIds[0] as string;
    push(messageId, FINISH);
    await vi.waitFor(() => expect(registry.snapshot('c1').find((b) => b.messageId === messageId)?.status).toBe('complete'));

    const got: unknown[] = [];
    registry.subscribe('c1', (e) => got.push(e));
    const request = { id: 'r1', chatId: 'c1', messageId, toolName: 'Bash', risk: 'execute' as const, source: 'agent' as const, args: { command: 'npm test' }, summary: 'npm test', subagent: { callId: 't1', label: 'implementer', parentProfileId: 'p' } };
    approvalListener!({ type: 'request', request });

    // A reconnect's hello carries it, so the card stays while the helper waits.
    expect(registry.chatState('c1').backgroundApprovals).toEqual([request]);
    expect(got).toEqual([{ messageId, type: 'approval-request', request, background: true }]);
    expect(registry.snapshot('c1').find((b) => b.messageId === messageId)?.events.map((e) => e.type)).not.toContain('approval-request');

    approvalListener!({ type: 'resolved', requestId: 'r1', messageId, choice: 'once' });
    expect(registry.chatState('c1').backgroundApprovals).toEqual([]);
    expect(got.at(-1)).toEqual({ messageId, type: 'approval-resolved', requestId: 'r1', choice: 'once', background: true });
  });

  it('tells subscribers when stored messages changed', () => {
    const { registry, got } = setup();
    registry.messagesChanged('c1');
    expect(got).toEqual([{ type: 'messages-changed', chatId: 'c1' }]);
  });
});

describe('StreamRegistry and runs of text', () => {
  function emitter(): { registry: StreamRegistry; emit: (event: TurnEvent) => void; live: ChatStreamEvent[] } {
    let emit: ((event: TurnEvent) => void) | null = null;
    const runner = { on: (cb: (event: TurnEvent) => void) => { emit = cb; return () => {}; } } as unknown as TurnRunner;
    const registry = new StreamRegistry(runner, new InMemoryStore());
    registry.registerTurn('c1', ['m1', 'm2']);
    const live: ChatStreamEvent[] = [];
    registry.subscribe('c1', (e) => live.push(e));
    return { registry, emit: (event) => emit!(event), live };
  }

  it('keeps a run of text deltas, and of reasoning deltas, as one in the buffer, and the replay folds to the same parts', () => {
    const { registry, emit, live } = emitter();
    const sent: TurnEvent[] = [
      { messageId: 'm1', type: 'reasoning-delta', text: 'Let me ' },
      { messageId: 'm1', type: 'reasoning-delta', text: 'think.' },
      { messageId: 'm1', type: 'text-delta', text: 'One ' },
      { messageId: 'm1', type: 'text-delta', text: 'two ' },
      { messageId: 'm1', type: 'text-delta', text: 'three.' },
      { messageId: 'm1', type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'a' } },
      { messageId: 'm1', type: 'tool-result', id: 't1', name: 'read_file', result: 'x', isError: false },
      { messageId: 'm1', type: 'text-delta', text: 'After ' },
      { messageId: 'm1', type: 'text-delta', text: 'the tool.' },
      { messageId: 'm1', type: 'notice', text: 'A notice.' },
      { messageId: 'm1', type: 'text-delta', text: '' },
      { messageId: 'm1', type: 'text-delta', text: 'End.' },
    ];
    const copies = structuredClone(sent);
    for (const event of sent) emit(event);

    // Every delta still goes out live, as it was sent: joining is the buffer's business only.
    expect(live).toEqual(copies);
    expect(sent).toEqual(copies);
    const buffered = registry.snapshot('c1').find((b) => b.messageId === 'm1')!.events;
    expect(buffered).toEqual([
      { messageId: 'm1', type: 'reasoning-delta', text: 'Let me think.' },
      { messageId: 'm1', type: 'text-delta', text: 'One two three.' },
      { messageId: 'm1', type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'a' } },
      { messageId: 'm1', type: 'tool-result', id: 't1', name: 'read_file', result: 'x', isError: false },
      { messageId: 'm1', type: 'text-delta', text: 'After the tool.' },
      { messageId: 'm1', type: 'notice', text: 'A notice.' },
      { messageId: 'm1', type: 'text-delta', text: 'End.' },
    ]);
    // The same parts either way: what a client rebuilds from the hello is what it would have built live.
    expect(buffered.reduce(withEvent, [])).toEqual(copies.reduce(withEvent, []));
  });

  it('joins only within one reply, and a later delta never changes a snapshot already handed out', () => {
    const { registry, emit } = emitter();
    emit({ messageId: 'm1', type: 'text-delta', text: 'A' });
    emit({ messageId: 'm2', type: 'text-delta', text: 'X' });
    emit({ messageId: 'm1', type: 'text-delta', text: 'B' });
    const before = JSON.stringify(registry.snapshot('c1'));
    const held = registry.snapshot('c1').map((b) => [...b.events]);
    emit({ messageId: 'm1', type: 'text-delta', text: 'C' });
    emit({ messageId: 'm2', type: 'text-delta', text: 'Y' });
    expect(JSON.stringify(held.map((events, i) => ({ ...registry.snapshot('c1')[i]!, events })))).toBe(before);
    expect(registry.snapshot('c1').map((b) => b.events)).toEqual([
      [{ messageId: 'm1', type: 'text-delta', text: 'ABC' }],
      [{ messageId: 'm2', type: 'text-delta', text: 'XY' }],
    ]);
  });
});

describe('StreamRegistry and generation progress', () => {
  it("buffers tool-progress for a live reply's hello, keeping only the latest of a run for one call", () => {
    const store = new InMemoryStore();
    let approvalListener: ((event: ToolApprovalEvent) => void) | null = null;
    const toolProvider = { onApprovalEvent: (cb: (event: ToolApprovalEvent) => void) => { approvalListener = cb; return () => {}; } } as unknown as ToolProvider;
    const runner = new TurnRunner(store, { stream: async function* () {}, listModels: async () => [], testConnection: async () => ({ ok: true, message: '', latencyMs: 0 }) }, { toolProvider });
    const registry = new StreamRegistry(runner, store);
    registry.registerTurn('c1', ['m1']);
    const got: unknown[] = [];
    registry.subscribe('c1', (e) => got.push(e));
    for (const step of [1, 2, 3]) approvalListener!({ type: 'progress', messageId: 'm1', callId: 't1', progress: { stage: 'generating', step, steps: 3 } });
    approvalListener!({ type: 'progress', messageId: 'm1', callId: 't2', progress: { stage: 'queued' } });
    // Every event still goes out live.
    expect(got).toHaveLength(4);
    const events = registry.snapshot('c1').find((b) => b.messageId === 'm1')?.events;
    expect(events).toEqual([
      { messageId: 'm1', type: 'tool-progress', callId: 't1', progress: { stage: 'generating', step: 3, steps: 3 } },
      { messageId: 'm1', type: 'tool-progress', callId: 't2', progress: { stage: 'queued' } },
    ]);
  });

  it("buffers a run of thinking events as its latest, so a long think doesn't fill the hello", () => {
    let emit: ((event: TurnEvent) => void) | null = null;
    const runner = { on: (cb: (event: TurnEvent) => void) => { emit = cb; return () => {}; } } as unknown as TurnRunner;
    const registry = new StreamRegistry(runner, new InMemoryStore());
    registry.registerTurn('c1', ['m1']);
    const got: unknown[] = [];
    registry.subscribe('c1', (e) => got.push(e));
    emit!({ messageId: 'm1', type: 'thinking', since: 10 });
    for (const tokens of [100, 200, 300]) emit!({ messageId: 'm1', type: 'thinking', since: 10, tokens });
    emit!({ messageId: 'm1', type: 'text-delta', text: 'Done.' });
    expect(got).toHaveLength(5);
    expect(registry.snapshot('c1').find((b) => b.messageId === 'm1')?.events).toEqual([
      { messageId: 'm1', type: 'thinking', since: 10, tokens: 300 },
      { messageId: 'm1', type: 'text-delta', text: 'Done.' },
    ]);
  });
});
