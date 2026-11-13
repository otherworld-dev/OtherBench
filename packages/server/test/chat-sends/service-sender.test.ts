import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatSend } from '@otherbench/core/ports/store.js';
import { STOPPED_FROM_CARD } from '../../src/chat-sends/service.js';
import { FakeRemote, flush, Harness, refusal } from './harness.js';

const UNREACHABLE = "PC isn't reachable. The message goes when it is back.";
const BUSY = 'PC is being used by computer use. The message goes when that ends.';

let h: Harness;
let remote: FakeRemote;

const only = (fromMessageId: string): ChatSend => {
  const rows = h.store.chatSends.byFromMessage(fromMessageId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

async function tick(): Promise<void> {
  h.service.tick();
  await flush();
  await h.service.idle();
}

/** The text of the user message a reply answers. */
function askedText(replyId: string): string {
  const parent = h.store.messages.get(h.store.messages.get(replyId)!.parentId!)!;
  return parent.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

beforeEach(() => {
  h = new Harness('node-A');
  h.store.nodes.rename('Laptop');
  h.store.peers.create({ nodeId: 'node-B', name: 'PC', fingerprint: 'f'.repeat(64), addresses: [], issuedTokenHash: 'h', heldTokenRef: 'r', platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1 });
  remote = new FakeRemote();
  h.addChat('A');
  h.addChat('B', { runsOn: 'node-B' });
  h.addChat('C');
  h.store.apps.create({ id: 'app-web', name: 'Web', workspace: { kind: 'machine', nodeId: 'node-B', root: 'C:/web' } });
  h.build({ remote });
  h.service.start();
});

afterEach(() => h.service.dispose());

describe('ChatSendService across machines: the sender', () => {
  it('list returns chats on every machine with machine names, and the apps', async () => {
    remote.active.set('node-B', ['B']);
    const listed = await h.service.list(h.ctxFor('A', 'r0'));
    expect(listed.chats.find((c) => c.chatId === 'B')).toEqual({ chatId: 'B', title: 'Chat B', app: null, busy: true, machine: 'PC', acceptsSends: true });
    expect(listed.chats.find((c) => c.chatId === 'C')).toEqual({ chatId: 'C', title: 'Chat C', app: null, busy: false, machine: 'Laptop', acceptsSends: true });
    expect(listed.chats.map((c) => c.chatId)).not.toContain('A');
    // A chat on a machine that isn't paired any more can't be reached at all.
    h.addChat('Z', { runsOn: 'node-gone' });
    expect((await h.service.list(h.ctxFor('A', 'r0'))).chats.map((c) => c.chatId)).not.toContain('Z');
    expect(listed.apps).toEqual([{ name: 'Web', machine: 'PC', acceptsSends: true }]);
    remote.states.set('node-B', 'off');
    expect((await h.service.list(h.ctxFor('A', 'r0'))).apps).toEqual([{ name: 'Web', machine: 'PC', acceptsSends: false }]);
  });

  it('send to a chat on B writes a queued row with toNode B and hands it over', async () => {
    const r = await h.reply('A');
    const out = await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    const row = only(r);
    expect(out).toEqual({ sent: [{ sendId: row.id, chatId: 'B', title: 'Chat B', app: null, createdChat: false, queued: false, machine: 'PC', held: false }] });
    expect(remote.handOvers).toEqual([
      { nodeId: 'node-B', h: { id: row.id, chainId: r, depth: 1, chainBase: 0, fromChatId: 'A', fromMessageId: r, fromTitle: 'Chat A', fromAppName: null, toChatId: 'B', text: 'do it' } },
    ]);
    expect(row).toMatchObject({ toNode: 'node-B', status: 'running', heldReason: null, toReplyId: null });
    expect(row.handedAt).not.toBeNull();
    // Nothing ran here but A's own reply.
    expect(h.engine.requests.map((q) => q.chatId)).toEqual(['A']);
  });

  it('a final refusal fails the row with its reason, and the sender resumes', async () => {
    remote.handOverAnswers.push({ refused: 'There is no chat B here.', final: true });
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    expect(only(r)).toMatchObject({ status: 'failed', reason: 'There is no chat B here.' });
    await h.finish(r, 'Sent.');
    const resumed = h.latestReply('A')!;
    expect(resumed).not.toBe(r);
    expect(askedText(resumed)).toContain('There is no chat B here.');
  });

  it('an unreachable machine holds the row, says so once, and hands it over when the machine is back', async () => {
    remote.states.set('node-B', 'unreachable');
    const r = await h.reply('A');
    const out = await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    const row = only(r);
    expect(out).toMatchObject({ sent: [{ chatId: 'B', machine: 'PC', held: true }] });
    expect(row).toMatchObject({ status: 'queued', heldReason: UNREACHABLE });
    expect(remote.handOvers).toEqual([]);
    await tick();
    const held = h.events.filter((e) => e.type === 'chat-send-held');
    expect(held).toEqual([{ type: 'chat-send-held', chatId: 'A', sendId: row.id, machine: 'PC', reason: UNREACHABLE }]);
    remote.states.set('node-B', 'ok');
    await tick();
    expect(only(r)).toMatchObject({ status: 'running', heldReason: null, heldSeen: false });
    expect(remote.handOvers).toHaveLength(1);
  });

  it('a refusal that will pass (computer use in control there) holds instead of failing', async () => {
    remote.handOverAnswers.push({ refused: BUSY, final: false });
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    expect(only(r)).toMatchObject({ status: 'queued', heldReason: BUSY });
    await tick();
    expect(only(r)).toMatchObject({ status: 'running', heldReason: null });
  });

  it('send to a new chat in an app whose folder is bound to B makes it there, not here', async () => {
    const r = await h.reply('A');
    const out = await h.send('A', r, [{ app: 'Web', text: 'Fix the build\nIt fails on Windows.' }]);
    const row = only(r);
    expect(remote.handOvers).toHaveLength(1);
    const handed = remote.handOvers[0]!.h;
    expect(handed.createApp).toEqual({ appId: 'app-web', title: 'Fix the build' });
    expect(handed.toChatId).toBe(row.toChatId);
    expect(row).toMatchObject({ toAppId: 'app-web', createdChat: true, toNode: 'node-B', status: 'running' });
    expect(h.store.chats.get(row.toChatId)).toBeNull();
    expect(out).toMatchObject({ sent: [{ chatId: row.toChatId, title: 'Fix the build', app: 'Web', createdChat: true, machine: 'PC' }] });
  });

  it('refuses a chat or app on a machine that said it does not accept sends, writing nothing', async () => {
    remote.states.set('node-B', 'off');
    const r = await h.reply('A');
    const off = `PC doesn't accept work from chats on paired machines. Turn on "Let chats on paired machines send work to chats here" in Settings → Machines on PC.`;
    expect(refusal(await h.send('A', r, [{ chatId: 'B', text: 'x' }]))).toBe(off);
    expect(refusal(await h.send('A', r, [{ app: 'Web', text: 'x' }]))).toBe(off);
    expect(h.store.chatSends.byFromMessage(r)).toEqual([]);
  });

  it('takeOutcome settles the row and resumes the sender with the reply', async () => {
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    await h.finish(r, 'Sent.');
    const row = only(r);
    expect(h.service.takeOutcome('node-B', row.id, { status: 'replied', replyText: 'Done on the PC.', reason: null })).toBe('taken');
    await flush();
    await h.service.idle();
    expect(only(r)).toMatchObject({ status: 'replied', replyText: 'Done on the PC.' });
    const resumed = h.latestReply('A')!;
    expect(resumed).not.toBe(r);
    expect(askedText(resumed)).toContain('Done on the PC.');
  });

  it('takeOutcome on a settled row is taken and changes nothing', async () => {
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    h.service.stop(r);
    await flush();
    await h.service.idle();
    expect(h.service.takeOutcome('node-B', only(r).id, { status: 'replied', replyText: 'late', reason: null })).toBe('taken');
    expect(only(r)).toMatchObject({ status: 'stopped', replyText: null });
  });

  it('takeOutcome from another node is refused', async () => {
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    expect(h.service.takeOutcome('node-C', only(r).id, { status: 'replied', replyText: 'x', reason: null })).toBe('unknown');
    expect(h.service.takeOutcome('node-B', 'no-such-send', { status: 'replied', replyText: 'x', reason: null })).toBe('unknown');
    expect(only(r).status).toBe('running');
  });

  it('Stop on the card stops a running remote row at once and keeps telling B until it takes it', async () => {
    remote.stopAnswers.push('retry');
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    h.service.stop(r);
    await flush();
    await h.service.idle();
    const row = only(r);
    expect(row).toMatchObject({ status: 'stopped', stopPending: STOPPED_FROM_CARD });
    expect(remote.stops).toEqual([{ nodeId: 'node-B', sendId: row.id, toChatId: 'B', reason: STOPPED_FROM_CARD }]);
    await tick();
    expect(remote.stops).toHaveLength(2);
    expect(only(r).stopPending).toBeNull();
  });

  it('cancel settles a held row as cancelled and the sender resumes with "Cancelled by the user."', async () => {
    remote.states.set('node-B', 'unreachable');
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    await h.finish(r, 'Sent.');
    expect(h.service.cancel(only(r).id)).toBe(true);
    await flush();
    await h.service.idle();
    expect(only(r)).toMatchObject({ status: 'cancelled', reason: 'Cancelled by the user.', heldReason: null });
    expect(askedText(h.latestReply('A')!)).toContain('Cancelled by the user.');
    expect(h.service.cancel(only(r).id)).toBe(false);
  });

  it('wait sets heldSeen and takes the chat off the held list', async () => {
    remote.states.set('node-B', 'unreachable');
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    expect(h.service.heldChatIds()).toEqual(['A']);
    expect(h.service.wait(only(r).id)).toBe(true);
    expect(only(r).heldSeen).toBe(true);
    expect(h.service.heldChatIds()).toEqual([]);
    expect(h.service.waitingChatIds()).toEqual(['A']);
  });

  it('runHere moves a chat with no folder here and delivers it locally', async () => {
    remote.states.set('node-B', 'unreachable');
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    expect(h.service.views('A')[0]).toMatchObject({ machine: 'PC', canRunHere: true });
    expect(await h.service.runHere(only(r).id)).toEqual({ ok: true });
    await flush();
    await h.service.idle();
    expect(h.store.chats.get('B')!.runsOn).toBe('node-A');
    expect(only(r)).toMatchObject({ toNode: null, status: 'running', heldReason: null });
    expect(h.engine.requests.map((q) => q.chatId)).toEqual(['A', 'B']);
  });

  it('runHere refuses when the folder does not resolve here', async () => {
    h.store.chats.update('B', { workspace: { kind: 'machine', nodeId: 'node-B', root: 'C:/web' } });
    remote.states.set('node-B', 'unreachable');
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    expect(h.service.views('A')[0]).toMatchObject({ machine: 'PC', canRunHere: false });
    expect(await h.service.runHere(only(r).id)).toEqual({ refused: "Chat B's folder is only on PC." });
    expect(only(r)).toMatchObject({ toNode: 'node-B', status: 'queued' });
  });

  it('start leaves a running remote row alone', () => {
    h.store.chatSends.create({
      id: 'sx', chainId: 'rx', depth: 1, fromChatId: 'A', fromMessageId: 'rx', toChatId: 'B', createdChat: false, text: 'x',
      status: 'running', toReplyId: null, replyText: null, reason: null, resumedAs: null, toNode: 'node-B', handedAt: 1,
    });
    const again = h.build({ remote });
    again.start();
    expect(h.store.chatSends.get('sx')!.status).toBe('running');
    again.dispose();
  });

  it("the sender's resumed turn, carrying a paired machine's reply, is marked as that machine's while it starts", async () => {
    const marks: string[] = [];
    h.service.dispose();
    h.build({
      remote,
      markPeerTurn: (chatId, nodeId) => {
        marks.push(`touch ${chatId} ${nodeId}`);
        return () => marks.push(`release ${chatId} latest=${h.latestReply(chatId)}`);
      },
    });
    h.service.start();
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    await h.finish(r, 'Sent.');
    expect(marks).toEqual([]);
    h.service.takeOutcome('node-B', only(r).id, { status: 'replied', replyText: 'Done.', reason: null });
    await flush();
    await h.service.idle();
    const resumed = h.latestReply('A')!;
    expect(resumed).not.toBe(r);
    // Released only once the resumed reply exists, so the mark saw it start.
    expect(marks).toEqual(['touch A node-B', `release A latest=${resumed}`]);
  });

  it('waitingChatIds counts a remote row sender', async () => {
    const r = await h.reply('A');
    await h.send('A', r, [{ chatId: 'B', text: 'do it' }]);
    expect(h.service.waitingChatIds()).toEqual(['A']);
  });
});
