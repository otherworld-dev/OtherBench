import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import { TurnRunner, type TurnEvent } from '@grunt/core/domain/turn.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { Connection, ResolvedProfile } from '@grunt/core/types/config.js';
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
    const registry = new StreamRegistry(runner);

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
    const registry = new StreamRegistry(runner);

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
    const registry = new StreamRegistry(runner);

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
    const registry = new StreamRegistry(runner);

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

  it('retains a completed buffer for late subscribers within the retention window, then evicts it', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const { engine, push } = manualEngine();
      const runner = new TurnRunner(store, engine);
      const registry = new StreamRegistry(runner, { retentionMs: 60_000 });

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

      await vi.advanceTimersByTimeAsync(59_000);
      expect(registry.snapshot('chat-1')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(registry.snapshot('chat-1')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
