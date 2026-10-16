import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import { toolContextFor } from '@otherbench/core/domain/tool-context.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { McpServerManager } from '@otherbench/tools/mcp/manager.js';
import { OtherBenchToolProvider } from '@otherbench/tools/provider.js';
import { createApp } from '../src/app.js';
import type { Container } from '../src/container.js';
import { AppEventBus, markUnreadOnFinish, withChatEvents } from '../src/stream/events.js';
import { StreamRegistry } from '../src/stream/registry.js';
import { sseStream } from '../src/stream/sse.js';

const FINISH: EngineEvent = { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };

/** An engine that never finishes on its own, so a test can drive its tools; aborting ends it. */
function hangingEngine(): { engine: ChatEngine; requests: EngineRequest[] } {
  const requests: EngineRequest[] = [];
  const engine: ChatEngine = {
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      requests.push(req);
      await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }));
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

let ws: string;
let container: Container;
let events: AppEventBus;
let seen: AppEvent[];

function build(engine: ChatEngine): void {
  events = new AppEventBus();
  const store = withChatEvents(new InMemoryStore(), events);
  const secrets = new FakeSecretStore();
  const broker = new PermissionBroker(store);
  const mcpManager = new McpServerManager(store, secrets);
  const toolProvider = new OtherBenchToolProvider(store, broker, mcpManager);
  const turnRunner = new TurnRunner(store, engine, { toolProvider });
  events.attach(turnRunner, store);
  markUnreadOnFinish(events, store);
  container = {
    store, events, secrets, engine, registry: {} as never, toolProvider, mcpManager, turnRunner,
    // A real blob store: deleting a chat sweeps blobs.
    streamRegistry: new StreamRegistry(turnRunner, store), blobStore: createBlobStore(join(ws, 'attachments')), close: () => {},
  };
  store.connections.create({ id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'profile-1', name: 'Profile', description: null, colour: null, connectionId: 'conn-1', modelId: 'model-x', systemPrompt: null, params: {},
    toolPolicy: { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' }, isDefault: true, archivedAt: null,
  });
  seen = [];
  events.subscribe((e) => seen.push(e));
}

const app = () => createApp(container);
const flush = () => new Promise((r) => setTimeout(r, 10));

function post(path: string, body: unknown) {
  return app().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'otherbench-events-test-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('AppEventBus', () => {
  it('keeps announcing to the other listeners when one throws', () => {
    const bus = new AppEventBus();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: AppEvent[] = [];
    bus.subscribe(() => {
      throw new Error('closed');
    });
    bus.subscribe((e) => got.push(e));
    bus.emit({ type: 'chat-deleted', chatId: 'c' });
    expect(got).toEqual([{ type: 'chat-deleted', chatId: 'c' }]);
    errors.mockRestore();
  });

  it('tracks replies from turn-started until turn-finished, for the hello', () => {
    const bus = new AppEventBus();
    bus.emit({ type: 'turn-started', chatId: 'c', messageIds: ['m1', 'm2'] });
    bus.emit({ type: 'turn-finished', chatId: 'c', messageId: 'm1', status: 'complete' });
    expect(bus.runningTurns()).toEqual([{ chatId: 'c', messageId: 'm2' }]);
  });

  it('tracks pending approvals: added on request, removed on resolve or when their turn ends', () => {
    const bus = new AppEventBus();
    bus.emit({ type: 'approval-requested', chatId: 'c', messageId: 'm1', requestId: 'r1', toolName: 'write_file' });
    bus.emit({ type: 'approval-requested', chatId: 'c', messageId: 'm2', requestId: 'r2', toolName: 'run_command' });
    expect(bus.pendingApprovals().map((p) => p.requestId)).toEqual(['r1', 'r2']);
    bus.emit({ type: 'approval-resolved', chatId: 'c', requestId: 'r1' });
    bus.emit({ type: 'turn-finished', chatId: 'c', messageId: 'm2', status: 'cancelled' });
    expect(bus.pendingApprovals()).toEqual([]);
  });

  it('keeps the kind of a pending question or plan for the hello', () => {
    const bus = new AppEventBus();
    bus.emit({ type: 'approval-requested', chatId: 'c', messageId: 'm1', requestId: 'a1', toolName: 'ask_user', kind: 'question' });
    bus.emit({ type: 'approval-requested', chatId: 'c', messageId: 'm1', requestId: 'r1', toolName: 'write_file' });
    expect(bus.pendingApprovals()).toEqual([
      { chatId: 'c', messageId: 'm1', requestId: 'a1', toolName: 'ask_user', kind: 'question' },
      { chatId: 'c', messageId: 'm1', requestId: 'r1', toolName: 'write_file' },
    ]);
  });
});

describe('app-wide events', () => {
  it('creating, updating and deleting a chat over the API emits chat-created, chat-updated and chat-deleted', async () => {
    build(new FakeChatEngine([FINISH]));
    const created = (await (await post('/api/chats', { profileId: 'profile-1' })).json()) as { id: string };
    await app().request(`/api/chats/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed' }) });
    expect((await app().request(`/api/chats/${created.id}`, { method: 'DELETE' })).status).toBe(204);

    expect(seen.map((e) => e.type)).toEqual(['chat-created', 'chat-updated', 'chat-deleted']);
    expect(seen[0]).toMatchObject({ chat: { id: created.id } });
    expect(seen[1]).toMatchObject({ chat: { id: created.id, title: 'Renamed' } });
  });

  it('a turn emits turn-started (after moving the head to the new user message) and then turn-finished', async () => {
    build(new FakeChatEngine([{ type: 'text-delta', text: 'hi' }, FINISH]));
    container.store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    seen.length = 0;
    const res = (await (await post('/api/chats/chat-1/turns', { parts: [{ type: 'text', text: 'hello' }], profileIds: ['profile-1'] })).json()) as {
      userMessageId: string;
      assistantMessageIds: string[];
    };
    await flush();

    const types = seen.map((e) => e.type);
    expect(types.indexOf('turn-started')).toBeLessThan(types.indexOf('turn-finished'));
    const updated = seen.find((e) => e.type === 'chat-updated');
    expect(updated).toMatchObject({ chat: { headMessageId: res.userMessageId } });
    expect(seen.find((e) => e.type === 'turn-started')).toEqual({ type: 'turn-started', chatId: 'chat-1', messageIds: res.assistantMessageIds });
    expect(seen.find((e) => e.type === 'turn-finished')).toEqual({ type: 'turn-finished', chatId: 'chat-1', messageId: res.assistantMessageIds[0], status: 'complete' });
  });

  it('an approval emits approval-requested with its chat, the events stream opens with it pending, and resolving clears it', async () => {
    const hanging = hangingEngine();
    build(hanging.engine);
    container.store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'profile-1', headMessageId: null, workspaceRoot: ws, pinned: false, archivedAt: null });
    const { assistantMessageIds } = (await (await post('/api/chats/chat-1/turns', { parts: [{ type: 'text', text: 'write' }], profileIds: ['profile-1'] })).json()) as {
      assistantMessageIds: string[];
    };
    const messageId = assistantMessageIds[0]!;
    const writeFile = hanging.requests[0]!.tools.find((t) => t.name === 'write_file')!;
    const running = writeFile.execute(
      { path: 'note.txt', content: 'x' },
      { chatId: 'chat-1', messageId, profileId: 'profile-1', workspaceRoot: ws, signal: new AbortController().signal }
    );
    await flush();

    const requested = seen.find((e) => e.type === 'approval-requested');
    expect(requested).toMatchObject({ type: 'approval-requested', chatId: 'chat-1', messageId, toolName: 'write_file' });
    const requestId = (requested as { requestId: string }).requestId;

    const stream = await app().request('/api/events');
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('event: hello');
    expect(first).toContain(`"requestId":"${requestId}"`);
    // The reply waiting on that approval is still running.
    expect(first).toContain(`"runningTurns":[{"chatId":"chat-1","messageId":"${messageId}"}]`);

    await post(`/api/approvals/${requestId}/resolve`, { choice: 'deny' });
    await running;
    expect(seen.find((e) => e.type === 'approval-resolved')).toEqual({ type: 'approval-resolved', chatId: 'chat-1', requestId });
    expect(events.pendingApprovals()).toEqual([]);
    const live = new TextDecoder().decode((await reader.read()).value);
    expect(live).toContain('"type":"approval-resolved"');
    await reader.cancel();
    container.turnRunner.cancel(messageId);
  });

  it('a reply that finishes marks its chat unread and announces it', async () => {
    build(new FakeChatEngine([{ type: 'text-delta', text: 'hi' }, FINISH]));
    container.store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    seen.length = 0;
    await post('/api/chats/chat-1/turns', { parts: [{ type: 'text', text: 'hello' }], profileIds: ['profile-1'] });
    await flush();

    expect(container.store.chats.get('chat-1')).toMatchObject({ unread: true });
    const types = seen.map((e) => e.type);
    expect(types.lastIndexOf('chat-updated')).toBeGreaterThan(types.indexOf('turn-started'));
    expect(seen.filter((e) => e.type === 'chat-updated').at(-1)).toMatchObject({ chat: { id: 'chat-1', unread: true } });
  });

  it('a reply that fails marks its chat unread; one the user stopped does not', () => {
    build(new FakeChatEngine([FINISH]));
    container.store.chats.create({ id: 'failed', title: 'A', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    container.store.chats.create({ id: 'stopped', title: 'B', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });

    events.emit({ type: 'turn-finished', chatId: 'failed', messageId: 'm1', status: 'error' });
    events.emit({ type: 'turn-finished', chatId: 'stopped', messageId: 'm2', status: 'cancelled' });

    expect(container.store.chats.get('failed')!.unread).toBe(true);
    expect(container.store.chats.get('stopped')!.unread).toBe(false);
  });

  it('a chat already unread, or gone, is left alone when another reply finishes', () => {
    build(new FakeChatEngine([FINISH]));
    container.store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    events.emit({ type: 'turn-finished', chatId: 'chat-1', messageId: 'm1', status: 'complete' });
    seen.length = 0;

    events.emit({ type: 'turn-finished', chatId: 'chat-1', messageId: 'm2', status: 'complete' });
    events.emit({ type: 'turn-finished', chatId: 'deleted', messageId: 'm3', status: 'complete' });

    expect(seen.map((e) => e.type)).toEqual(['turn-finished', 'turn-finished']);
  });

  it('a question emits approval-requested with kind question, the hello lists it, and the turn finishing clears it', async () => {
    const hanging = hangingEngine();
    build(hanging.engine);
    container.store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const { assistantMessageIds } = (await (await post('/api/chats/chat-1/turns', { parts: [{ type: 'text', text: 'ask' }], profileIds: ['profile-1'] })).json()) as { assistantMessageIds: string[] };
    const messageId = assistantMessageIds[0]!;
    void container.toolProvider.askUser(toolContextFor(hanging.requests[0]!), { kind: 'question', toolName: 'ask_user', questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }] });
    await flush();
    const requested = seen.find((e) => e.type === 'approval-requested');
    expect(requested).toMatchObject({ chatId: 'chat-1', messageId, toolName: 'ask_user', kind: 'question' });
    expect(events.pendingApprovals()).toHaveLength(1);
    container.turnRunner.cancel(messageId);
    await vi.waitFor(() => expect(events.pendingApprovals()).toEqual([]));
  });

  it('deleting a project announces each chat it moved to No project', async () => {
    build(new FakeChatEngine([FINISH]));
    const project = (await (await post('/api/projects', { name: 'P' })).json()) as { id: string };
    const chat = (await (await post('/api/chats', { projectId: project.id })).json()) as { id: string };
    seen.length = 0;
    await app().request(`/api/projects/${project.id}`, { method: 'DELETE' });
    expect(seen).toEqual([expect.objectContaining({ type: 'chat-updated', chat: expect.objectContaining({ id: chat.id, projectId: null }) })]);
  });
});

describe('SSE comments', () => {
  it('writes a comment line clients ignore, on one line', async () => {
    const res = sseStream((sink) => {
      sink.comment('keep\nalive');
      return () => {};
    });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': keep alive\n\n');
    await reader.cancel();
  });
});
