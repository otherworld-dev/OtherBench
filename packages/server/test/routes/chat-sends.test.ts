import { beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ChatEngine } from '@otherbench/core/ports/chat-engine.js';
import type { ChatSend, ChatSendView } from '@otherbench/core/ports/store.js';
import { createApp } from '../../src/app.js';
import { ChatSendService } from '../../src/chat-sends/service.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const idleEngine: ChatEngine = {
  async *stream() {},
  listModels: async () => [],
  testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
};

let container: Container;
let store: InMemoryStore;

function row(id: string, over: Partial<ChatSend> = {}): void {
  store.chatSends.create({ id, chainId: 'r1', depth: 1, fromChatId: 'A', fromMessageId: 'r1', toChatId: 'B', createdChat: false, text: 'x', status: 'replied', toReplyId: null, replyText: null, reason: null, resumedAs: null, ...over });
}

function call(path: string, method = 'GET', body?: unknown): Promise<Response> {
  return Promise.resolve(
    createApp(container).request(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  );
}

beforeEach(() => {
  store = new InMemoryStore();
  const turnRunner = new TurnRunner(store, idleEngine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine: idleEngine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    close: () => {},
  };
  container.chatSends = new ChatSendService({
    store,
    turnRunner,
    startTurn: async () => {
      throw new Error('no turns here');
    },
    resolveProfile: async () => {
      throw new Error('no profiles here');
    },
    resolveWorkspace: () => ({ status: 'none' }),
    isChatBusy: () => false,
    createAppChat: () => {
      throw new Error('no apps here');
    },
    emit: () => {},
  });
  store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'p1', name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' }, isDefault: true, archivedAt: null,
  });
  for (const id of ['A', 'B']) store.chats.create({ id, title: `Chat ${id}`, profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  store.messages.create({ id: 'r1', chatId: 'A', parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null });
});

describe('chat-to-chat routes', () => {
  it('GET /api/chats/:id/sends lists the sends from and to a chat, newest first', async () => {
    row('s1', { createdAt: 1 });
    row('s2', { fromChatId: 'B', toChatId: 'A', createdAt: 2 });
    const res = await call('/api/chats/A/sends');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sends: ChatSend[] };
    expect(body.sends.map((s) => s.id)).toEqual(['s2', 's1']);
    expect((await call('/api/chats/nope/sends')).status).toBe(404);
  });

  it('POST /api/chat-sends/:messageId/stop stops the sends of that reply and returns them', async () => {
    row('s1', { status: 'queued' });
    const res = await call('/api/chat-sends/r1/stop', 'POST');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sends: ChatSend[] }).sends).toMatchObject([{ id: 's1', status: 'stopped', reason: 'Stopped from the send card.' }]);
    expect((await call('/api/chat-sends/nope/stop', 'POST')).status).toBe(404);
  });

  it('GET /api/chat-sends/waiting names the chats with sends still out, and those held for a machine that is off', async () => {
    row('s1', { status: 'running', toReplyId: 'elsewhere' });
    expect(await (await call('/api/chat-sends/waiting')).json()).toEqual({ chatIds: ['A'], heldChatIds: [] });
    row('s2', { fromChatId: 'B', fromMessageId: 'rb', status: 'queued', toNode: 'node-pc', heldReason: "PC isn't reachable." });
    expect(await (await call('/api/chat-sends/waiting')).json()).toEqual({ chatIds: ['A', 'B'], heldChatIds: ['B'] });
  });

  it('GET /api/chats/:id/sends gives each send its machine and whether it could run here', async () => {
    store.peers.create({ nodeId: 'node-pc', name: 'PC', fingerprint: 'f'.repeat(64), addresses: [], issuedTokenHash: 'h', heldTokenRef: 'r', platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1 });
    row('s1', { status: 'queued', toNode: 'node-pc', heldReason: "PC isn't reachable." });
    const body = (await (await call('/api/chats/A/sends')).json()) as { sends: ChatSendView[] };
    expect(body.sends).toMatchObject([{ id: 's1', machine: 'PC', canRunHere: true, heldReason: "PC isn't reachable." }]);
  });

  it('POST /api/chats/:id/sends/stop stops the sends of the reply it names', async () => {
    row('s1', { status: 'queued' });
    const res = await call('/api/chats/A/sends/stop', 'POST', { fromMessageId: 'r1' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sends: ChatSendView[] }).sends).toMatchObject([{ id: 's1', status: 'stopped' }]);
    expect((await call('/api/chats/A/sends/stop', 'POST', { fromMessageId: 'nope' })).status).toBe(404);
    expect((await call('/api/chats/A/sends/stop', 'POST', {})).status).toBe(400);
  });

  it('POST wait marks a held send as seen; cancel settles it as cancelled; both return the chat\'s sends', async () => {
    row('s1', { status: 'queued', toNode: 'node-pc', heldReason: "PC isn't reachable." });
    const waited = await call('/api/chats/A/sends/s1/wait', 'POST');
    expect(waited.status).toBe(200);
    expect(((await waited.json()) as { sends: ChatSendView[] }).sends).toMatchObject([{ id: 's1', heldSeen: true }]);
    const cancelled = await call('/api/chats/A/sends/s1/cancel', 'POST');
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { sends: ChatSendView[] }).sends).toMatchObject([{ id: 's1', status: 'cancelled', reason: 'Cancelled by the user.' }]);
    expect((await call('/api/chats/A/sends/s1/cancel', 'POST')).status).toBe(409);
  });

  it('POST on a send that is not from that chat, or unknown, is a 404; run-here on one not waiting is a 409', async () => {
    row('s1', { status: 'running', toNode: 'node-pc' });
    expect((await call('/api/chats/B/sends/s1/wait', 'POST')).status).toBe(404);
    expect((await call('/api/chats/A/sends/nope/cancel', 'POST')).status).toBe(404);
    const res = await call('/api/chats/A/sends/s1/run-here', 'POST');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "That message isn't waiting for another machine." });
  });
});
