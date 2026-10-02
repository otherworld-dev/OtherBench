import { describe, expect, it } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { ToolProvider } from '@grunt/core/ports/tool-provider.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

/**
 * Correctness check (NOT a regression guard -- see the honesty note below)
 * for a real bug found via a real-browser Playwright run while building
 * task 21 (see task-21-report.md): the capability-fallback `notice`
 * TurnEvent (packages/core/src/domain/turn.ts) was being emitted eagerly,
 * immediately after `TurnRunner.runVariant` computed it -- which reaches
 * that point after just ONE microtask hop past `toolProvider.listTools()`
 * (a real `ToolProvider`'s `listTools()` has no internal `await` of its
 * own). That was fast enough to fire BEFORE `routes/turns.ts` got a turn to
 * call `StreamRegistry.registerTurn()` for the new message ids, and
 * `StreamRegistry.handleEvent` silently drops any event for a message id it
 * has no buffer for yet (by design -- see registry.ts's class doc). The
 * notice still landed correctly in the database (a direct, unraced store
 * write), which is exactly why this stayed invisible to
 * `packages/core/test/turn.test.ts`'s `FakeChatEngine`-based unit tests
 * (they never touch `StreamRegistry` at all) and even to `packages/web`
 * component tests (which feed a fixed `TurnEvent` list straight into the
 * reducer, bypassing the transport entirely).
 *
 * Honesty note: this test goes through `createApp()`'s real
 * `POST /chats/:id/turns` and `GET /chats/:id/stream` handlers, with a
 * `ToolProvider` shaped like the real one, hoping to reproduce the same
 * ordering that broke in production. It does NOT, in practice -- verified
 * by hand (not left as a committed assertion) by reintroducing the eager
 * `emit()` and confirming this test still passed. Hono's in-process
 * `app.request()` calls the fetch handler directly, skipping the genuine
 * socket-level I/O phases a real `@hono/node-server` HTTP round trip goes
 * through -- and it's specifically those extra event-loop phases that
 * `registerTurn()` needed in order to reliably win the real race. The ONLY
 * reproduction found that reliably catches this class of bug is a real
 * browser against a real running server:
 * packages/web/e2e/attachments.spec.ts. This test is kept anyway because it
 * still exercises the deferred-emit code path end to end and would catch
 * OTHER regressions (e.g. the notice never reaching the buffer at all, in
 * any order) -- it is just not proof against the specific timing bug that
 * motivated it.
 *
 * Fixed in TurnRunner.runVariant by deferring the notice's LIVE `emit()`
 * call to the `for await` loop's first iteration -- timed to occur only
 * once the engine itself has produced a value, the same safety margin every
 * other event type already had for free.
 */

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

describe('capability-fallback notice: real HTTP round trip (regression)', () => {
  it('a subscriber connecting right after the turn is posted still sees the notice in the hello replay -- not lost to the registerTurn race', async () => {
    const store = new InMemoryStore();
    const { engine, push } = manualEngine();
    // Shaped like the real GruntToolProvider: a genuine `async` method with
    // no internal `await` -- this is what creates the race (see this file's
    // module doc).
    const toolProvider: ToolProvider = {
      listTools: async () => [],
      refreshMcp: async () => {},
      shutdown: async () => {},
      onApprovalEvent: () => () => {},
      resolveApproval: () => false,
      requestApproval: async () => ({ allowed: true, grantedBy: 'policy' }),
    };
    const turnRunner = new TurnRunner(store, engine, { toolProvider });
    const container: Container = {
      store,
      secrets: new FakeSecretStore(),
      engine,
      registry: {} as never,
      toolProvider,
      mcpManager: {} as never,
      turnRunner,
      streamRegistry: new StreamRegistry(turnRunner, store),
      blobStore: {} as never,
      close: () => {},
    };

    store.connections.create({
      id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null,
      extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null,
    });
    store.models.create({
      id: 'model-1', connectionId: 'conn-1', modelId: 'no-vision-model', displayName: 'No Vision',
      source: 'manual', supportsVision: false, supportsTools: false, supportsReasoning: false,
      contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null,
      priceCachedPer1m: null, currency: 'USD',
    });
    store.profiles.create({
      id: 'profile-1', name: 'No Vision', description: null, colour: null, connectionId: 'conn-1',
      modelId: 'no-vision-model', systemPrompt: null, params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
      isDefault: true, archivedAt: null,
    });
    store.chats.create({
      id: 'chat-1', title: 'Test', profileId: 'profile-1', headMessageId: null,
      workspaceRoot: null, pinned: false, archivedAt: null,
    });
    store.attachments.create({
      id: 'att-1', chatId: 'chat-1', messageId: null, filename: 'photo.png', mime: 'image/png',
      size: 10, sha256: 'x', storagePath: '/x', extractedText: null,
    });

    const app = createApp(container);

    const postRes = await app.request('/api/chats/chat-1/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'image', attachmentId: 'att-1', mime: 'image/png' }],
        profileIds: ['profile-1'],
      }),
    });
    expect(postRes.status).toBe(202);
    const { assistantMessageIds } = (await postRes.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0] as string;

    // The notice's LIVE emit is deliberately deferred to `runVariant`'s
    // first live-emitted event (see turn.ts) -- so the manual engine needs
    // to actually produce ITS first event before the notice can have
    // reached the registry. `manualEngine()`'s `stream()` is paused on an
    // unresolved promise until `push()` is called, mirroring a real engine
    // genuinely waiting on the network/a real per-chunk delay -- exactly
    // the boundary the fix relies on to lose the eager-emit race.
    push(messageId, { type: 'text-delta', text: 'Hello' });
    await new Promise((resolve) => setImmediate(resolve));

    // Connect right after posting -- this is exactly what a browser tab
    // that had its SSE connection open BEFORE the turn was created (the
    // ordinary case: `useChatSync` opens the stream on chat select, well
    // before the user ever sends a message) experiences on the live path,
    // and it's also exactly what the `hello` replay is FOR on a fresh
    // connect/reconnect. Either way, the registry's buffer for this message
    // must already contain the notice by now.
    const streamRes = await app.request('/api/chats/chat-1/stream');
    const reader = sseReader(streamRes);
    const hello = await reader.next();

    expect(hello?.event).toBe('hello');
    const inFlight = (hello?.data as { inFlight: { messageId: string; events: { type: string }[] }[] }).inFlight;
    const buffer = inFlight.find((b) => b.messageId === messageId);
    expect(buffer).toBeDefined();
    expect(buffer!.events.map((e) => e.type)).toContain('notice');

    push(messageId, { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' });
    await reader.cancel();
  });
});
