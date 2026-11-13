import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SENDS_PER_CHAIN } from '@otherbench/core/domain/chat-sends.js';
import type { ChatSend } from '@otherbench/core/ports/store.js';
import type { Handover } from '../../src/chat-sends/remote-port.js';
import { FakeRemote, flush, Harness, refusal } from './harness.js';

/** The PC (node-B) taking sends from the laptop (node-A), whose chat "A" has synced here but runs there. */
let h: Harness;
let remote: FakeRemote;

const handover = (over: Partial<Handover> = {}): Handover => ({
  id: 'send-1', chainId: 'rA', depth: 1, chainBase: 0, fromChatId: 'A', fromMessageId: 'rA', fromTitle: 'Finance', fromAppName: null,
  toChatId: 'B', text: 'Add a runway card.', ...over,
});

const row = (id = 'send-1'): ChatSend => h.store.chatSends.get(id)!;

async function settleDown(): Promise<void> {
  await flush();
  await h.service.idle();
}

/** The text of the user message a reply answers. */
function askedText(replyId: string): string {
  const parent = h.store.messages.get(h.store.messages.get(replyId)!.parentId!)!;
  return parent.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

beforeEach(() => {
  h = new Harness('node-B');
  h.store.nodes.rename('PC');
  h.store.peers.create({ nodeId: 'node-A', name: 'Laptop', fingerprint: 'e'.repeat(64), addresses: [], issuedTokenHash: 'h', heldTokenRef: 'r', platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1 });
  remote = new FakeRemote();
  h.addChat('A', { runsOn: 'node-A' });
  h.addChat('B');
  h.addChat('C');
  h.store.apps.create({ id: 'app-budget', name: 'Nextcloud Budget' });
  h.build({ remote });
  h.service.start();
});

afterEach(() => h.service.dispose());

describe('ChatSendService across machines: the target', () => {
  it('takeHandover writes a mirror row under the same id and delivers it, naming the sender as its machine gave it', async () => {
    h.store.chats.delete('A');
    expect(await h.service.takeHandover('node-A', handover())).toEqual({ accepted: true });
    await settleDown();
    expect(row()).toMatchObject({ fromNode: 'node-A', fromTitle: 'Finance', toNode: null, status: 'running', toChatId: 'B' });
    const replyId = row().toReplyId!;
    expect(askedText(replyId)).toContain('"Finance"');
    expect(askedText(replyId)).toContain('Add a runway card.');
  });

  it("the delivered turn is marked as the sending machine's while it starts, and released once it has", async () => {
    const marks: string[] = [];
    h.service.dispose();
    h.build({
      remote,
      markPeerTurn: (chatId, nodeId) => {
        marks.push(`touch ${chatId} ${nodeId}`);
        return () => marks.push(`release ${chatId} running=${h.bus.runningTurns().some((t) => t.chatId === chatId)}`);
      },
    });
    h.service.start();
    await h.service.takeHandover('node-A', handover());
    await settleDown();
    expect(marks).toEqual(['touch B node-A', 'release B running=true']);
  });

  it('takeHandover twice with the same id makes one row and one turn', async () => {
    await h.service.takeHandover('node-A', handover());
    expect(await h.service.takeHandover('node-A', handover())).toEqual({ accepted: true });
    await settleDown();
    expect(h.store.chatSends.byToChat('B')).toHaveLength(1);
    expect(h.engine.requests).toHaveLength(1);
  });

  it('takeHandover refuses, finally, a chat that is missing, archived, or runs on another machine', async () => {
    h.addChat('Z', { archivedAt: 5 });
    h.addChat('Y', { runsOn: 'node-A' });
    expect(await h.service.takeHandover('node-A', handover({ id: 's1', toChatId: 'nope' }))).toMatchObject({ final: true, refused: expect.stringMatching(/no chat/) });
    expect(await h.service.takeHandover('node-A', handover({ id: 's2', toChatId: 'Z' }))).toMatchObject({ final: true, refused: expect.stringMatching(/archived/) });
    expect(await h.service.takeHandover('node-A', handover({ id: 's3', toChatId: 'Y' }))).toMatchObject({ final: true, refused: expect.stringMatching(/runs on Laptop/) });
    expect(h.store.chatSends.byFromMessage('rA')).toEqual([]);
  });

  it('takeHandover with createApp makes the chat here under the given id, running here', async () => {
    expect(await h.service.takeHandover('node-A', handover({ toChatId: 'new-chat', createApp: { appId: 'app-budget', title: 'Runway card' } }))).toEqual({ accepted: true });
    await settleDown();
    const made = h.store.chats.get('new-chat')!;
    expect(made).toMatchObject({ appId: 'app-budget', title: 'Runway card', runsOn: 'node-B' });
    expect(row()).toMatchObject({ toChatId: 'new-chat', createdChat: true, status: 'running' });
  });

  it('a settled mirror row is reported once, not resumed here, and reported again until taken', async () => {
    remote.reportAnswers.push('retry');
    await h.service.takeHandover('node-A', handover());
    await settleDown();
    const turnsBefore = h.engine.requests.length;
    await h.finish(row().toReplyId!, 'Added the card.');
    expect(row()).toMatchObject({ status: 'replied', replyText: 'Added the card.', reportedAt: null });
    expect(remote.reports).toEqual([{ nodeId: 'node-A', sendId: 'send-1', fromChatId: 'A', o: { status: 'replied', replyText: 'Added the card.', reason: null } }]);
    // Nothing resumes here: the sender is on the laptop.
    expect(h.engine.requests).toHaveLength(turnsBefore);
    h.service.tick();
    await settleDown();
    expect(remote.reports).toHaveLength(2);
    expect(row().reportedAt).not.toBeNull();
    h.service.tick();
    await settleDown();
    expect(remote.reports).toHaveLength(2);
  });

  it("takeStop stops a running mirror row's reply and reports it stopped", async () => {
    await h.service.takeHandover('node-A', handover());
    await settleDown();
    const replyId = row().toReplyId!;
    expect(h.service.takeStop('node-A', 'send-1', 'Stopped from the send card.')).toBe('taken');
    await settleDown();
    expect(h.store.messages.get(replyId)!.status).toBe('cancelled');
    expect(row()).toMatchObject({ status: 'stopped', reason: 'Stopped from the send card.' });
    expect(remote.reports.map((r) => r.o.status)).toEqual(['stopped']);
  });

  it('takeStop on a queued mirror row settles and reports it', async () => {
    const busy = await h.reply('B');
    await h.service.takeHandover('node-A', handover());
    await settleDown();
    expect(row().status).toBe('queued');
    expect(h.service.takeStop('node-A', 'send-1', 'Stopped from the send card.')).toBe('taken');
    await settleDown();
    expect(row().status).toBe('stopped');
    expect(remote.reports.map((r) => r.o.status)).toEqual(['stopped']);
    await h.finish(busy, 'x');
    expect(h.engine.requests).toHaveLength(1);
  });

  it('takeStop from another node is refused', async () => {
    await h.service.takeHandover('node-A', handover());
    await settleDown();
    expect(h.service.takeStop('node-C', 'send-1', 'x')).toBe('unknown');
    expect(h.service.takeStop('node-A', 'nope', 'x')).toBe('unknown');
    expect(row().status).toBe('running');
  });

  it('a chain carries on across the hop: depth and the count made before it reached here', async () => {
    await h.service.takeHandover('node-A', handover({ depth: 2, chainBase: MAX_SENDS_PER_CHAIN - 2 }));
    await settleDown();
    const replyId = row().toReplyId!;
    const out = await h.send('B', replyId, [{ chatId: 'C', text: 'one' }]);
    expect(out).toMatchObject({ sent: [{ chatId: 'C' }] });
    expect(h.store.chatSends.byFromMessage(replyId)[0]).toMatchObject({ chainId: 'rA', depth: 3 });
    // Two before it reached here, the mirror and the one just sent: the limit is reached.
    expect(refusal(await h.send('B', replyId, [{ chatId: 'C', text: 'two' }]))).toMatch(/chains stop at|limit is/);
  });

  it("waitingChatIds and heldChatIds leave out a mirror row's sender", async () => {
    await h.service.takeHandover('node-A', handover());
    await settleDown();
    expect(h.service.waitingChatIds()).toEqual([]);
    expect(h.service.heldChatIds()).toEqual([]);
  });

  it('after a restart, a running mirror row whose reply was reconciled as an error fails and is reported', async () => {
    h.service.dispose();
    const now = Date.now();
    h.store.messages.create({ id: 'ub', chatId: 'B', parentId: null, role: 'user', parts: [{ type: 'text', text: 'x' }], status: 'complete', error: null, producedBy: null, createdAt: now });
    h.store.messages.create({
      id: 'rb', chatId: 'B', parentId: 'ub', role: 'assistant', parts: [], status: 'error', error: { kind: 'unknown', message: 'OtherBench stopped.', retryable: true },
      producedBy: { profileId: 'p1', profileName: 'Mock', connectionId: 'conn', modelId: 'm' }, createdAt: now + 1,
    });
    h.store.chatSends.create({
      id: 'send-1', chainId: 'rA', depth: 1, fromChatId: 'A', fromMessageId: 'rA', toChatId: 'B', createdChat: false, text: 'x', status: 'running',
      toReplyId: 'rb', replyText: null, reason: null, resumedAs: null, fromNode: 'node-A', fromTitle: 'Finance',
    });
    h.build({ remote });
    h.service.start();
    await settleDown();
    expect(row()).toMatchObject({ status: 'failed', reason: 'OtherBench stopped.' });
    expect(remote.reports.map((r) => r.o.status)).toEqual(['failed']);
  });
});
