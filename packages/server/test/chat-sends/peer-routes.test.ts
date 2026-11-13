import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ChatEngine } from '@otherbench/core/ports/chat-engine.js';
import { ChatSendService } from '../../src/chat-sends/service.js';
import type { Container } from '../../src/container.js';
import { forwardedApi, PeerInfluence } from '../../src/peer/forward.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const idleEngine: ChatEngine = {
  async *stream() {},
  listModels: async () => [],
  testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
};

const H = { id: 's1', chainId: 'r', depth: 1, chainBase: 0, fromChatId: 'A', fromMessageId: 'r', fromTitle: 'Finance', fromAppName: null, toChatId: 'B', text: 'Add a card.' };

let container: Container;
let store: InMemoryStore;
let service: ChatSendService;

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(forwardedApi(container).request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { peerNodeId: 'node-laptop' }));
}

beforeEach(() => {
  store = new InMemoryStore('node-pc');
  store.nodes.rename('PC');
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
    // The chat marking runs, as in the real listener: a write it can't place is refused without peerComputerControl.
    peerInfluence: new PeerInfluence(),
  };
  service = new ChatSendService({
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
  container.chatSends = service;
});

afterEach(() => vi.restoreAllMocks());

describe('chat sends on the peer listener', () => {
  it('incoming is refused with chat_sends_off while the setting is off, without reaching the service', async () => {
    const take = vi.spyOn(service, 'takeHandover');
    const res = await post('/chats/B/sends/incoming', H);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'PC doesn\'t accept work from chats on paired machines. Turn on "Let chats on paired machines send work to chats here" in Settings → Machines on PC.',
      kind: 'chat_sends_off',
    });
    expect(take).not.toHaveBeenCalled();
  });

  it("incoming hands the send to takeHandover with the caller's node id, never one from the body", async () => {
    store.settings.update({ peerChatSends: true });
    const take = vi.spyOn(service, 'takeHandover').mockResolvedValue({ accepted: true });
    const res = await post('/chats/B/sends/incoming', { ...H, fromNode: 'node-evil' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect(take).toHaveBeenCalledWith('node-laptop', H);
  });

  it("incoming: the service's refusal is a 409 with its words", async () => {
    store.settings.update({ peerChatSends: true });
    vi.spyOn(service, 'takeHandover').mockResolvedValue({ refused: 'The chat "B" is archived.', final: true });
    const res = await post('/chats/B/sends/incoming', H);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The chat "B" is archived.', kind: 'refused' });
  });

  it('incoming with a chat id that does not match the path, or that is not a send, is a 400', async () => {
    store.settings.update({ peerChatSends: true });
    const take = vi.spyOn(service, 'takeHandover');
    expect((await post('/chats/C/sends/incoming', H)).status).toBe(400);
    expect((await post('/chats/B/sends/incoming', { ...H, depth: 0 })).status).toBe(400);
    expect((await post('/chats/B/sends/incoming', { ...H, text: ' ' })).status).toBe(400);
    expect((await post('/chats/B/sends/incoming', { ...H, createApp: { title: 'x' } })).status).toBe(400);
    expect(take).not.toHaveBeenCalled();
  });

  it('outcome is taken while the setting is off: it only settles a send this machine made', async () => {
    const take = vi.spyOn(service, 'takeOutcome').mockReturnValue('taken');
    const o = { status: 'replied', replyText: 'Done.', reason: null };
    const res = await post('/chats/A/sends/s1/outcome', o);
    expect(res.status).toBe(200);
    expect(take).toHaveBeenCalledWith('node-laptop', 's1', o);
    take.mockReturnValue('unknown');
    expect((await post('/chats/A/sends/s1/outcome', o)).status).toBe(404);
    expect((await post('/chats/A/sends/s1/outcome', { ...o, status: 'cancelled' })).status).toBe(400);
  });

  it('remote-stop passes the chat marking without peerComputerControl, and reaches takeStop', async () => {
    const take = vi.spyOn(service, 'takeStop').mockReturnValue('taken');
    const res = await post('/chats/B/sends/s1/remote-stop', { reason: 'Stopped from the send card.' });
    expect(res.status).toBe(200);
    expect(take).toHaveBeenCalledWith('node-laptop', 's1', 'Stopped from the send card.');
    take.mockReturnValue('unknown');
    expect((await post('/chats/B/sends/s1/remote-stop', {})).status).toBe(404);
  });
});
