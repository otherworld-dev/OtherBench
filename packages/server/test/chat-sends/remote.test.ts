import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { PeerRequest, PeerResponse } from '../../src/peer/client.js';
import { PeerError } from '../../src/peer/service.js';
import { peerChatSendRemote, type PeerLink } from '../../src/chat-sends/remote.js';
import type { Handover } from '../../src/chat-sends/remote-port.js';

const H: Handover = { id: 's1', chainId: 'r', depth: 1, chainBase: 0, fromChatId: 'A', fromMessageId: 'r', fromTitle: 'Finance', fromAppName: null, toChatId: 'B', text: 'x' };

/** PeerService as far as the remote uses it, answering every call but the sync request with `answer`. */
function link(answer: () => PeerResponse | Promise<PeerResponse>, over: Partial<PeerLink> = {}): PeerLink & { calls: Omit<PeerRequest, 'token'>[] } {
  const calls: Omit<PeerRequest, 'token'>[] = [];
  return {
    calls,
    status: () => ({ status: 'reachable' }),
    acceptsChatSends: () => true,
    activeChats: () => [],
    call: async (_nodeId, req) => {
      calls.push(req);
      if (req.path === '/peer/sync-request') return { status: 200, body: { applied: 0 }, address: 'a', fingerprint: 'f' };
      return answer();
    },
    ...over,
  };
}

const res = (status: number, body: unknown = {}): PeerResponse => ({ status, body, address: 'a', fingerprint: 'f' });
const down = (): never => {
  throw new PeerError("PC isn't reachable.", 503);
};

function remoteWith(l: PeerLink) {
  const store = new InMemoryStore('node-L');
  store.peers.create({ nodeId: 'node-P', name: 'PC', fingerprint: 'f'.repeat(64), addresses: [], issuedTokenHash: 'h', heldTokenRef: 'r', platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1 });
  return peerChatSendRemote(store, l);
}

describe('peerChatSendRemote', () => {
  it('state: unreachable, then what the machine said: ok, off, or unknown when it never said', () => {
    expect(remoteWith(link(() => res(200), { status: () => ({ status: 'unreachable' }) })).state('node-P')).toBe('unreachable');
    expect(remoteWith(link(() => res(200), { acceptsChatSends: () => true })).state('node-P')).toBe('ok');
    expect(remoteWith(link(() => res(200), { acceptsChatSends: () => false })).state('node-P')).toBe('off');
    expect(remoteWith(link(() => res(200), { acceptsChatSends: () => null })).state('node-P')).toBe('unknown');
  });

  it('handOver asks the machine to pull first, then posts the send to the chat it is for', async () => {
    const l = link(() => res(200, { accepted: true }));
    expect(await remoteWith(l).handOver('node-P', H)).toEqual({ accepted: true });
    expect(l.calls).toEqual([
      { method: 'POST', path: '/peer/sync-request' },
      { method: 'POST', path: '/api/chats/B/sends/incoming', body: H },
    ]);
  });

  it('handOver: the setting off there is final, with its words', async () => {
    const off = 'PC doesn\'t accept work from chats on paired machines. Turn on "Let chats on paired machines send work to chats here" in Settings → Machines on PC.';
    expect(await remoteWith(link(() => res(403, { error: off, kind: 'chat_sends_off' }))).handOver('node-P', H)).toEqual({ refused: off, final: true });
  });

  it('handOver: computer use in control there waits', async () => {
    expect(await remoteWith(link(() => res(403, { error: 'busy', kind: 'desktop_only' }))).handOver('node-P', H)).toEqual({
      refused: 'PC is being used by computer use. The message goes when that ends.',
      final: false,
    });
  });

  it('handOver: no such route means an older build, and is final', async () => {
    expect(await remoteWith(link(() => res(404, { error: 'Not found.' }))).handOver('node-P', H)).toEqual({ refused: 'PC needs updating before chats can send work to it.', final: true });
  });

  it('handOver: a refusal of the send itself is final, with its words', async () => {
    expect(await remoteWith(link(() => res(409, { error: 'The chat "B" is archived.', kind: 'refused' }))).handOver('node-P', H)).toEqual({ refused: 'The chat "B" is archived.', final: true });
  });

  it('handOver: unreachable, at the pull or the post, or a server error there, waits', async () => {
    const waits = { refused: "PC isn't reachable. The message goes when it is back.", final: false };
    expect(await remoteWith(link(down)).handOver('node-P', H)).toEqual(waits);
    const l = link(() => res(200), { call: async () => down() });
    expect(await remoteWith(l).handOver('node-P', H)).toEqual(waits);
    expect(await remoteWith(link(() => res(500, { error: 'boom' }))).handOver('node-P', H)).toEqual(waits);
  });

  it('report posts to the sending chat there; 200 and 404 are taken, anything else is tried again', async () => {
    const o = { status: 'replied' as const, replyText: 'Done.', reason: null };
    const l = link(() => res(200, { taken: true }));
    expect(await remoteWith(l).report('node-P', 's1', 'A', o)).toBe('taken');
    expect(l.calls).toEqual([{ method: 'POST', path: '/api/chats/A/sends/s1/outcome', body: o }]);
    expect(await remoteWith(link(() => res(404))).report('node-P', 's1', 'A', o)).toBe('taken');
    expect(await remoteWith(link(() => res(403, { kind: 'desktop_only' }))).report('node-P', 's1', 'A', o)).toBe('retry');
    expect(await remoteWith(link(down)).report('node-P', 's1', 'A', o)).toBe('retry');
  });

  it('stop posts to the target chat there, with the reason; 200 and 404 are taken, anything else is tried again', async () => {
    const l = link(() => res(200, { stopped: true }));
    expect(await remoteWith(l).stop('node-P', 's1', 'B', 'Stopped from the send card.')).toBe('taken');
    expect(l.calls).toEqual([{ method: 'POST', path: '/api/chats/B/sends/s1/remote-stop', body: { reason: 'Stopped from the send card.' } }]);
    expect(await remoteWith(link(() => res(404))).stop('node-P', 's1', 'B', 'x')).toBe('taken');
    expect(await remoteWith(link(down)).stop('node-P', 's1', 'B', 'x')).toBe('retry');
  });

  it('names machines from the paired-machine list', () => {
    const r = remoteWith(link(() => res(200)));
    expect(r.machineName('node-P')).toBe('PC');
    expect(r.machineName('node-gone')).toBe('another machine');
  });
});
