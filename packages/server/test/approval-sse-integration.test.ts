import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore } from '@otherbench/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import { McpServerManager } from '@otherbench/tools/mcp/manager.js';
import { OtherBenchToolProvider } from '@otherbench/tools/provider.js';
import { createApp } from '../src/app.js';
import type { Container } from '../src/container.js';
import { StreamRegistry } from '../src/stream/registry.js';

/**
 * End-to-end proof (task 26's verification requirement) that a tool call
 * gated by `OtherBenchToolProvider` surfaces as a real `approval-request`
 * `TurnEvent` on the SAME SSE channel a client already listens to for
 * text/tool deltas (`GET /chats/:id/stream`) -- no separate transport, no
 * extra client wiring beyond handling one more event type -- and that
 * resolving it via `POST /api/approvals/:id/resolve` both unblocks the
 * suspended `execute()` call and emits a matching `approval-resolved` event.
 *
 * The engine here is hand-driven (never actually invokes any tool's
 * `execute` itself -- that is AI SDK's job in the real `engine-aisdk`
 * package, already covered by that package's own tests). What this test
 * exercises instead is the piece task 26 actually adds: TurnRunner asking
 * `OtherBenchToolProvider.listTools()` for a profile's tools and threading
 * `chatId`/`messageId`/`workspaceRoot` through correctly, such that calling
 * `.execute()` on one of the tools it handed back -- exactly what
 * `engine-aisdk`'s `buildToolSet` does for a real model's tool call --
 * reaches the SAME gate, gets audited, and streams the SAME way a real
 * model-triggered call would.
 */

function manualEngine(): { engine: ChatEngine; requests: EngineRequest[] } {
  const requests: EngineRequest[] = [];
  const engine: ChatEngine = {
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      requests.push(req);
      // Never yields anything and never resolves on its own -- the variant
      // just sits 'streaming' for the duration of this test, same as a real
      // model mid-tool-call. `cancel()`/test teardown aborts it.
      await new Promise<void>((resolve) => {
        req.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    async listModels() {
      return [];
    },
    async testConnection() {
      return { ok: true, message: 'ok', latencyMs: 0 };
    },
  };
  return { engine, requests };
}

/** Reads one complete SSE record at a time -- copy of turns.test.ts's helper (module-private there). */
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

  async function next(timeoutMs = 2000): Promise<{ event: string | null; data: unknown } | null> {
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

let ws: string;
let container: Container;
let manual: { engine: ChatEngine; requests: EngineRequest[] };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'otherbench-approval-sse-test-'));
  const store = new InMemoryStore();
  const secrets = new FakeSecretStore();
  const broker = new PermissionBroker(store);
  const mcpManager = new McpServerManager(store, secrets);
  const toolProvider = new OtherBenchToolProvider(store, broker, mcpManager);
  manual = manualEngine();
  const turnRunner = new TurnRunner(store, manual.engine, { toolProvider });
  container = {
    store,
    secrets,
    engine: manual.engine,
    registry: {} as never,
    toolProvider,
    mcpManager,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    close: () => {},
  };

  store.connections.create({
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
  store.profiles.create({
    id: 'profile-1',
    name: 'Profile',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'model-x',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' },
    isDefault: false,
    archivedAt: null,
  });
  store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'profile-1', headMessageId: null, workspaceRoot: ws, pinned: false, archivedAt: null });
});

afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function app() {
  return createApp(container);
}

describe('approval events over the real SSE channel', () => {
  it('a gated tool call streams approval-request, and resolving it via the HTTP route streams approval-resolved and unblocks execute()', async () => {
    const turnRes = await app().request('/api/chats/chat-1/turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'please write a file' }], profileIds: ['profile-1'] }),
    });
    expect(turnRes.status).toBe(202);
    const { assistantMessageIds } = (await turnRes.json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0]!;

    // Confirm TurnRunner actually built and passed real (gated) tools --
    // this is the specific wiring task 26 adds to TurnRunner.
    expect(manual.requests).toHaveLength(1);
    const writeFile = manual.requests[0]!.tools.find((t) => t.name === 'write_file');
    expect(writeFile).toBeDefined();
    expect(manual.requests[0]!.workspaceRoot).toBe(ws);

    const sse = await app().request(`/api/chats/chat-1/stream`);
    const reader = sseReader(sse);
    const hello = await reader.next();
    expect(hello!.event).toBe('hello');

    // Exactly what engine-aisdk's buildToolSet does for a real tool call --
    // ctx mirrors what it would construct from this same EngineRequest.
    const execPromise = writeFile!.execute(
      { path: 'note.txt', content: 'hello from the model' },
      { chatId: 'chat-1', messageId, profileId: 'profile-1', workspaceRoot: ws, signal: new AbortController().signal }
    );

    let requestEvent: { event: string | null; data: unknown } | null = null;
    for (let i = 0; i < 5 && !requestEvent; i++) {
      const record = await reader.next();
      if (record?.data && typeof record.data === 'object' && (record.data as { type?: string }).type === 'approval-request') {
        requestEvent = record;
      }
    }
    expect(requestEvent).not.toBeNull();
    const request = (requestEvent!.data as { request: { id: string; messageId: string; toolName: string } }).request;
    expect(request.messageId).toBe(messageId);
    expect(request.toolName).toBe('write_file');

    const resolveRes = await app().request(`/api/approvals/${request.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'once' }),
    });
    expect(resolveRes.status).toBe(200);

    let resolvedEvent: { event: string | null; data: unknown } | null = null;
    for (let i = 0; i < 5 && !resolvedEvent; i++) {
      const record = await reader.next();
      if (record?.data && typeof record.data === 'object' && (record.data as { type?: string }).type === 'approval-resolved') {
        resolvedEvent = record;
      }
    }
    expect(resolvedEvent).not.toBeNull();
    expect((resolvedEvent!.data as { requestId: string; choice: string }).choice).toBe('once');

    const result = (await execPromise) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    reader.cancel();
  });
});
