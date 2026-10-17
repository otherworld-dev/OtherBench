import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeToolProvider, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { TurnRunner, type TurnEvent } from '@otherbench/core/domain/turn.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { ToolApprovalEvent, ToolProvider } from '@otherbench/core/ports/tool-provider.js';
import type { Connection, ModelInfo, ResolvedProfile } from '@otherbench/core/types/config.js';
import { applySubagentEvent, type SubagentEvent } from '@otherbench/core/domain/parts.js';
import type { Part } from '@otherbench/core/types/messages.js';
import { StreamRegistry } from '../../src/stream/registry.js';

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

    const receivedA: TurnEvent[] = [];
    const receivedB: TurnEvent[] = [];
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
    const live: TurnEvent[] = [];
    registry.subscribe('chat-1', (e) => live.push(e));

    push(messageId, { type: 'text-delta', text: 'third' });
    await flush();
    push(messageId, FINISH);
    await flush();

    const combined = [...replay, ...live];
    const textDeltas = combined.filter((e): e is TurnEvent & { type: 'text-delta' } => e.type === 'text-delta');
    expect(textDeltas.map((e) => e.text)).toEqual(['First ', 'second ', 'third']);
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

    const received: TurnEvent[] = [];
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
    const received: TurnEvent[] = [];
    registry.subscribe('chat-1', (e) => received.push(e));

    push(messageId, { type: 'text-delta', text: 'Hello' });
    await flush();
    push(messageId, FINISH);
    await flush();

    expect(received.map((e) => e.type)).toEqual(['text-delta', 'finish', 'status']);
    // The variant's own persisted state is unaffected by the throwing subscriber.
    expect(store.messages.get(messageId)?.status).toBe('complete');
  });

  it('falls back to the persisted message row when the in-memory log is lost (e.g. a server restart mid-turn), with a correct terminal status and no duplicated content', async () => {
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

    // Simulate a server restart: a brand-new registry over the SAME store,
    // with no subscription history and therefore no in-memory buffer at all
    // for this message id.
    const freshRunner = new TurnRunner(store, engine);
    const freshRegistry = new StreamRegistry(freshRunner, store);

    const snapshot = freshRegistry.snapshot('chat-1');
    const buffer = snapshot.find((b) => b.messageId === messageId);
    expect(buffer).toBeDefined();
    // The row's current (terminal) status, not a stuck 'streaming'.
    expect(buffer?.status).toBe('complete');

    // Replaying the reconstructed events reproduces exactly the checkpointed
    // content -- no gap, no duplication -- the same property the in-memory
    // path already satisfies (see the "no gap and no duplication" test
    // above).
    const textDeltas = buffer!.events.filter(
      (e): e is TurnEvent & { type: 'text-delta' } => e.type === 'text-delta'
    );
    expect(textDeltas.map((e) => e.text).join('')).toBe('Hello world');
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
      status: 'complete',
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

  it('rebuilds a stored subagent part into subagent events that fold back to the same part', () => {
    const store = new InMemoryStore();
    store.chats.create({ id: 'chat-1', title: 'Test', profileId: 'profile-a', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const part: Part = {
      type: 'subagent', callId: 'call-1', label: 'Helper', prompt: 'Look.', profileId: 'p', profileName: 'P', modelId: 'm', status: 'complete',
      usage: { tokensIn: 3, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 },
      parts: [{ type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'a' } }, { type: 'text', text: 'Found.' }],
    };
    store.messages.create({ id: 'assistant-1', chatId: 'chat-1', parentId: null, role: 'assistant', parts: [{ type: 'text', text: 'Asking.' }, part], status: 'complete', error: null, producedBy: null });
    const { engine } = manualEngine();
    const registry = new StreamRegistry(new TurnRunner(store, engine), store);

    const buffer = registry.snapshot('chat-1').find((b) => b.messageId === 'assistant-1')!;
    expect(buffer.events.map((e) => e.type)).toEqual(['text-delta', 'subagent', 'subagent', 'subagent', 'subagent', 'subagent', 'status']);
    const rebuilt = buffer.events
      .filter((e): e is TurnEvent & { type: 'subagent' } => e.type === 'subagent')
      .reduce<Part[]>((parts, e) => applySubagentEvent(parts, e.callId, e.event as SubagentEvent), []);
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

  it('evicts a completed buffer from memory after the retention window; snapshot() still reflects it correctly via the DB fallback', async () => {
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
      // The in-memory buffer is now evicted (bounding memory is still the
      // retention window's job) -- but the persisted row is still
      // 'complete', so snapshot() falls back to it (see IMPORTANT 4, task
      // 16-18 report) rather than reporting nothing. Its events are
      // reconstructed from the row, not the original live history, so there
      // is no `finish` event in it -- proof this came from the DB fallback,
      // not a buffer that (bug) never actually got evicted.
      const afterEviction = registry.snapshot('chat-1');
      expect(afterEviction).toHaveLength(1);
      expect(afterEviction[0]?.status).toBe('complete');
      expect(afterEviction[0]?.events.map((e) => e.type)).not.toContain('finish');
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
    const received: TurnEvent[] = [];
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
    const runner = new TurnRunner(store, { stream: async function* () {}, listModels: async () => [], testConnection: async () => ({ ok: true, message: '', latencyMs: 0 }) } as ChatEngine, { toolProvider });
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

  it('background approval reaches a chat subscriber and the hello, and leaves both when resolved', () => {
    const { registry, got, approve } = setup();
    const request = { id: 'r1', chatId: 'c1', messageId: 'm-old', toolName: 'Bash', risk: 'execute' as const, source: 'agent' as const, args: { command: 'npm test' }, summary: 'npm test', subagent: { callId: 't1', label: 'implementer', parentProfileId: 'p' } };
    approve({ type: 'request', request });
    expect(got).toEqual([{ messageId: 'm-old', type: 'approval-request', request }]);
    expect(registry.chatState('c1').backgroundApprovals).toEqual([request]);
    approve({ type: 'resolved', requestId: 'r1', messageId: 'm-old', choice: 'once' });
    expect(got.at(-1)).toEqual({ messageId: 'm-old', type: 'approval-resolved', requestId: 'r1', choice: 'once' });
    expect(registry.chatState('c1').backgroundApprovals).toEqual([]);
  });

  it('tells subscribers when stored messages changed', () => {
    const { registry, got } = setup();
    registry.messagesChanged('c1');
    expect(got).toEqual([{ type: 'messages-changed', chatId: 'c1' }]);
  });
});
