import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SENDS_PER_CHAIN } from '@otherbench/core/domain/chat-sends.js';
import type { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { SendOutcome, SendTarget } from '@otherbench/core/ports/chat-messenger.js';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { ChatSendService, ChatSendDeps } from '../../src/chat-sends/service.js';
import { collectMessageTree, createAppChat } from '../../src/routes/chats.js';
import { startTurn } from '../../src/turn-start.js';
import type { AppEventBus } from '../../src/stream/events.js';
import type { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { TurnStartDeps } from '../../src/turn-start.js';
import { flush, Harness, refusal, FINISH } from './harness.js';

let h: Harness;
let store: InMemoryStore;
let engine: Harness['engine'];
let bus: AppEventBus;
let events: AppEvent[];
let runner: TurnRunner;
let turnDeps: TurnStartDeps;
let service: ChatSendService;
let waitingNotes: Set<string>;

const resolveP: Harness['resolveP'] = (id) => h.resolveP(id);
function build(over: Partial<ChatSendDeps> = {}): ChatSendService {
  return h.build(over);
}
const addChat = (id: string, over: Record<string, unknown> = {}): void => h.addChat(id, over);
const reply = (chatId: string, text = 'hello'): Promise<string> => h.reply(chatId, text);
const finish = (replyId: string, text: string): Promise<void> => h.finish(replyId, text);
const ctxFor = (chatId: string, messageId: string, over: Partial<ToolContext> = {}): ToolContext => h.ctxFor(chatId, messageId, over);
const send = (chatId: string, messageId: string, targets: SendTarget[]): Promise<SendOutcome> => h.send(chatId, messageId, targets);
const latestReply = (chatId: string): string | undefined => h.latestReply(chatId);

beforeEach(() => {
  h = new Harness();
  ({ store, engine, bus, events, runner, turnDeps, waitingNotes } = h);
  for (const id of ['A', 'B', 'C', 'D']) addChat(id);
  service = build();
  service.start();
});

afterEach(() => service.dispose());

describe('ChatSendService: sending', () => {
  it('refuses a compare turn', async () => {
    const chat = store.chats.get('A')!;
    const result = await startTurn(turnDeps, { chatId: 'A', parentId: chat.headMessageId, userParts: [{ type: 'text', text: 'x' }], profiles: [await resolveP('p1'), await resolveP('p1')] });
    expect(refusal(await send('A', result.assistantMessageIds[0]!, [{ chatId: 'B', text: 'x' }]))).toMatch(/Compare/);
    expect(store.chatSends.byFromChat('A')).toEqual([]);
  });

  it('refuses the sender itself, an unknown chat, an archived one and one on another machine', async () => {
    store.chats.update('C', { archivedAt: 1 });
    store.chats.update('D', { runsOn: 'node-2' });
    const r = await reply('A');
    expect(refusal(await send('A', r, [{ chatId: 'A', text: 'x' }]))).toMatch(/itself/);
    expect(refusal(await send('A', r, [{ chatId: 'nope', text: 'x' }]))).toMatch(/no chat/i);
    expect(refusal(await send('A', r, [{ chatId: 'C', text: 'x' }]))).toMatch(/archived/);
    expect(refusal(await send('A', r, [{ chatId: 'D', text: 'x' }]))).toMatch(/runs on .*only chats on this machine/);
    expect(store.chatSends.byFromChat('A')).toEqual([]);
  });

  it('refuses an app it cannot name exactly, or whose folder is not on this machine', async () => {
    store.apps.create({ id: 'app1', name: 'Web' });
    store.apps.create({ id: 'app2', name: 'web' });
    store.apps.create({ id: 'app3', name: 'Away', workspace: { kind: 'machine', nodeId: 'other-node', root: 'Z:/nowhere' } });
    const r = await reply('A');
    expect(refusal(await send('A', r, [{ app: 'Nothing', text: 'x' }]))).toMatch(/No app/);
    expect(refusal(await send('A', r, [{ app: 'WEB', text: 'x' }]))).toMatch(/More than one app/);
    expect(refusal(await send('A', r, [{ app: 'Away', text: 'x' }]))).toMatch(/folder/);
  });

  it('starts a new chat in an app with its folder and default profile, titled from the text, and opens the app', async () => {
    store.apps.create({ id: 'app1', name: 'Server', workspace: null, defaultProfileId: 'p1', open: false });
    const r = await reply('A');
    const out = await send('A', r, [{ app: 'server', text: 'Add a /health route\nand a test' }]);
    if (!('sent' in out)) throw new Error(refusal(out));
    const made = store.chats.get(out.sent[0]!.chatId)!;
    expect(made).toMatchObject({ appId: 'app1', profileId: 'p1', title: 'Add a /health route' });
    expect(out.sent[0]).toMatchObject({ createdChat: true, app: 'Server' });
    expect(store.apps.get('app1')!.open).toBe(true);
  });

  it('records a top-level send as depth 1 of a chain named after the sending reply', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    expect(store.chatSends.byFromMessage(r)).toMatchObject([{ chainId: r, depth: 1, fromChatId: 'A', toChatId: 'B', text: 'x' }]);
  });

  it('refuses more than 4 targets from one reply, counting earlier sends', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }, { chatId: 'C', text: 'x' }, { chatId: 'D', text: 'x' }]);
    addChat('E');
    addChat('F');
    expect(refusal(await send('A', r, [{ chatId: 'E', text: 'x' }, { chatId: 'F', text: 'x' }]))).toMatch(/4/);
  });

  it('lists the chats it could send to: not itself, not archived, with their app and whether they are busy', async () => {
    store.apps.create({ id: 'app1', name: 'Server' });
    store.chats.update('B', { appId: 'app1' });
    store.chats.update('D', { archivedAt: 1 });
    await reply('C');
    const { chats: listed, apps } = await service.list(ctxFor('A', 'r'));
    expect(listed.map((c) => c.chatId).sort()).toEqual(['B', 'C']);
    expect(listed.find((c) => c.chatId === 'B')).toMatchObject({ app: 'Server', busy: false, machine: 'This machine', acceptsSends: true });
    expect(listed.find((c) => c.chatId === 'C')).toMatchObject({ busy: true });
    // The apps a new chat can be started in, by their exact names (a model guessed "Budget" for "Nextcloud Budget").
    expect(apps).toEqual([{ name: 'Server', machine: 'This machine', acceptsSends: true }]);
  });
});


/** The parts of the user message a reply answers. */
const userPartsOf = (replyId: string) => store.messages.get(store.messages.get(replyId)!.parentId!)!.parts;

describe('ChatSendService: delivering', () => {
  it('starts a turn in an idle chat, marked as from the sender, with the delivered text', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'Add the button' }]);
    const row = store.chatSends.byFromMessage(r)[0]!;
    expect(row.status).toBe('running');
    expect(row.toReplyId).toBe(latestReply('B'));
    const parts = userPartsOf(row.toReplyId!);
    expect(parts[0]).toEqual({ type: 'chat-link', kind: 'from', chats: [{ chatId: 'A', title: 'Chat A' }], sendIds: [row.id] });
    expect(parts[1]).toMatchObject({ type: 'text', text: expect.stringContaining('Add the button') });
    expect((parts[1] as { text: string }).text).toContain('"Chat A" (chat A)');
    expect(events).toContainEqual({ type: 'chat-sends-changed', chatIds: expect.arrayContaining(['A', 'B']) });
  });

  it('waits while the target has a reply running, and goes out when it ends', async () => {
    const busy = await reply('B', 'my own work');
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'later please' }]);
    expect(store.chatSends.byFromMessage(r)[0]).toMatchObject({ status: 'queued', toReplyId: null });
    await finish(busy, 'done with mine');
    await vi.waitFor(() => expect(store.chatSends.byFromMessage(r)[0]!.status).toBe('running'));
    const parent = store.messages.get(store.chatSends.byFromMessage(r)[0]!.toReplyId!)!.parentId!;
    // It follows on from the reply that was running, not beside it.
    expect(store.messages.get(parent)!.parentId).toBe(busy);
  });

  it("waits while the user's own messages are waiting to go out in the target", async () => {
    waitingNotes.add('B');
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    expect(store.chatSends.byFromMessage(r)[0]!.status).toBe('queued');
  });

  it('sends two messages to the same chat one after the other', async () => {
    const ra = await reply('A');
    const rc = await reply('C');
    await send('A', ra, [{ chatId: 'B', text: 'from A' }]);
    await send('C', rc, [{ chatId: 'B', text: 'from C' }]);
    const [fromA] = store.chatSends.byFromMessage(ra);
    const [fromC] = store.chatSends.byFromMessage(rc);
    expect(fromA!.status).toBe('running');
    expect(fromC!.status).toBe('queued');
    await finish(fromA!.toReplyId!, 'did A');
    await vi.waitFor(() => expect(store.chatSends.get(fromC!.id)!.status).toBe('running'));
  });

  it('fails a send whose target chat was deleted before it could go out', async () => {
    const busy = await reply('B');
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    store.chats.delete('B');
    await finish(busy, 'gone');
    await vi.waitFor(() => expect(store.chatSends.byFromMessage(r)[0]).toMatchObject({ status: 'failed', reason: expect.stringMatching(/deleted/) }));
  });
});

/** The text of the user message a reply answers. */
const userTextOf = (replyId: string): string => userPartsOf(replyId).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
/** The reply working on the one send from `fromReply` to `toChat`. */
const workerOf = (fromReply: string, toChat: string): string => store.chatSends.byFromMessage(fromReply).find((r) => r.toChatId === toChat)!.toReplyId!;
const repliesIn = (chatId: string): number => collectMessageTree(store, chatId).filter((m) => m.role === 'assistant').length;

describe('ChatSendService: replies and resuming', () => {
  it('resumes the sender once, after every chat it sent to has replied, with all the replies in order', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'button' }, { chatId: 'C', text: 'route' }]);
    await finish(r, 'Sent.');
    await finish(workerOf(r, 'B'), 'Added the button.');
    expect(repliesIn('A')).toBe(1);
    await finish(workerOf(r, 'C'), 'Added the route.');
    await vi.waitFor(() => expect(repliesIn('A')).toBe(2));
    const resumed = latestReply('A')!;
    const parts = userPartsOf(resumed);
    expect(parts[0]).toMatchObject({ type: 'chat-link', kind: 'replies', chats: [{ chatId: 'B', status: 'replied' }, { chatId: 'C', status: 'replied' }] });
    const text = userTextOf(resumed);
    expect(text.indexOf('Added the button.')).toBeGreaterThan(-1);
    expect(text.indexOf('Added the button.')).toBeLessThan(text.indexOf('Added the route.'));
    expect(store.chatSends.byFromMessage(r).every((row) => row.resumedAs === resumed)).toBe(true);
    // It continues from the sending reply.
    expect(store.messages.get(store.messages.get(resumed)!.parentId!)!.parentId).toBe(r);
  });

  it('waits for the sender to finish its own reply before resuming it', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await finish(workerOf(r, 'B'), 'done');
    expect(repliesIn('A')).toBe(1);
    await finish(r, 'Sent.');
    await vi.waitFor(() => expect(repliesIn('A')).toBe(2));
  });

  it('resumes once when the same reply is reported ended twice', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await finish(r, 'Sent.');
    const worker = workerOf(r, 'B');
    await finish(worker, 'done');
    (service as unknown as { onReplyEnded(id: string, s: string): void }).onReplyEnded(worker, 'complete');
    await flush();
    await service.idle();
    await vi.waitFor(() => expect(repliesIn('A')).toBe(2));
    await flush();
    await service.idle();
    expect(repliesIn('A')).toBe(2);
  });

  it("passes on a failed reply as failed, with the error, and still resumes the sender", async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await finish(r, 'Sent.');
    engine.push(workerOf(r, 'B'), { type: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } });
    await vi.waitFor(() => expect(repliesIn('A')).toBe(2));
    expect(store.chatSends.byFromMessage(r)[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('boom') });
    expect(userTextOf(latestReply('A')!)).toContain('boom');
  });

  it('waits for a chat that sends on, and passes up its answer after it resumes, not its "I asked" reply', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'whole feature' }]);
    await finish(r, 'Sent.');
    const b1 = workerOf(r, 'B');
    await send('B', b1, [{ chatId: 'C', text: 'your part' }]);
    expect(store.chatSends.byFromMessage(b1)[0]).toMatchObject({ depth: 2, chainId: r });
    await finish(b1, 'I asked C.');
    expect(repliesIn('A')).toBe(1);
    await finish(workerOf(b1, 'C'), 'C did its part.');
    await vi.waitFor(() => expect(repliesIn('B')).toBe(2));
    const b2 = latestReply('B')!;
    expect(store.chatSends.byFromMessage(r)[0]!.toReplyId).toBe(b2);
    await finish(b2, 'Feature done, with C.');
    await vi.waitFor(() => expect(repliesIn('A')).toBe(2));
    const text = userTextOf(latestReply('A')!);
    expect(text).toContain('Feature done, with C.');
    expect(text).not.toContain('I asked C.');
  });

  it('stops a chain at 3 hops', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    const b = workerOf(r, 'B');
    await send('B', b, [{ chatId: 'C', text: 'x' }]);
    const c = workerOf(b, 'C');
    await send('C', c, [{ chatId: 'D', text: 'x' }]);
    const d = workerOf(c, 'D');
    expect(store.chatSends.byFromMessage(c)[0]!.depth).toBe(3);
    addChat('E');
    expect(refusal(await send('D', d, [{ chatId: 'E', text: 'x' }]))).toMatch(/3/);
  });

  it('stops a chain at 10 sends in all', async () => {
    const r = await reply('A');
    for (let i = 0; i < 10; i++) {
      store.chatSends.create({ id: `old${i}`, chainId: r, depth: 1, fromChatId: 'A', fromMessageId: `elsewhere${i}`, toChatId: 'B', createdChat: false, text: 'x', status: 'replied', toReplyId: null, replyText: null, reason: null, resumedAs: null });
    }
    expect(refusal(await send('A', r, [{ chatId: 'B', text: 'x' }]))).toMatch(/ask the user/);
  });

  it('refuses sending back to a chat that is waiting on this one', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    expect(refusal(await send('B', workerOf(r, 'B'), [{ chatId: 'A', text: 'x' }]))).toMatch(/waiting/);
  });

  it('drops the replies when the sender was cleared after it sent', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await finish(r, 'Sent.');
    const clear = store.messages.create({ id: 'clear-1', chatId: 'A', parentId: r, role: 'user', parts: [{ type: 'context', kind: 'clear' }], status: 'complete', error: null, producedBy: null });
    store.chats.update('A', { headMessageId: clear.id });
    await finish(workerOf(r, 'B'), 'done');
    await vi.waitFor(() => expect(store.chatSends.byFromMessage(r)[0]).toMatchObject({ status: 'replied', resumedAs: 'none' }));
    expect(repliesIn('A')).toBe(1);
  });
});

describe('ChatSendService: stopping and restarts', () => {
  it('Stop on the send card stops every reply it started, down the chain, and the sender stays quiet', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await finish(r, 'Sent.');
    const b1 = workerOf(r, 'B');
    await send('B', b1, [{ chatId: 'C', text: 'y' }]);
    await finish(b1, 'I asked C.');
    const c = workerOf(b1, 'C');
    service.stop(r);
    await vi.waitFor(() => expect(store.messages.get(c)!.status).toBe('cancelled'));
    await flush();
    await service.idle();
    expect(store.chatSends.byFromMessage(r)[0]).toMatchObject({ status: 'stopped', reason: 'Stopped from the send card.' });
    expect(store.chatSends.byFromMessage(b1)[0]).toMatchObject({ status: 'stopped' });
    expect(repliesIn('A')).toBe(1);
    expect(repliesIn('B')).toBe(1);
  });

  it('Stop on a queued send settles it straight away', async () => {
    await reply('B');
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    service.stop(r);
    expect(store.chatSends.byFromMessage(r)[0]).toMatchObject({ status: 'stopped', reason: 'Stopped from the send card.' });
  });

  it('stopping a target chat in its own chat passes "stopped" back, and the sender carries on', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await finish(r, 'Sent.');
    runner.cancel(workerOf(r, 'B'));
    await vi.waitFor(() => expect(repliesIn('A')).toBe(2));
    expect(store.chatSends.byFromMessage(r)[0]!.status).toBe('stopped');
  });

  it("Stop on the sender's own reply while it runs stops what it already started", async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    const b = workerOf(r, 'B');
    runner.cancel(r);
    await vi.waitFor(() => expect(store.messages.get(b)!.status).toBe('cancelled'));
    await flush();
    await service.idle();
    expect(store.chatSends.byFromMessage(r)[0]!.status).toBe('stopped');
    expect(repliesIn('A')).toBe(1);
  });

  it('after a restart, a send whose reply was reconciled as an error fails, and the sender resumes', async () => {
    service.dispose();
    const now = Date.now();
    const mk = (id: string, chatId: string, parentId: string | null, role: 'user' | 'assistant', status: 'complete' | 'error', at: number) =>
      store.messages.create({ id, chatId, parentId, role, parts: [{ type: 'text', text: id }], status, error: status === 'error' ? { kind: 'unknown', message: 'OtherBench stopped.', retryable: true } : null, producedBy: role === 'assistant' ? { profileId: 'p1', profileName: 'Mock', connectionId: 'conn', modelId: 'm' } : null, createdAt: at });
    mk('ua', 'A', null, 'user', 'complete', now);
    mk('ra', 'A', 'ua', 'assistant', 'complete', now + 1);
    mk('ub', 'B', null, 'user', 'complete', now + 2);
    mk('rb', 'B', 'ub', 'assistant', 'error', now + 3);
    store.chats.update('A', { headMessageId: 'ua' });
    store.chats.update('B', { headMessageId: 'ub' });
    store.chatSends.create({ id: 's1', chainId: 'ra', depth: 1, fromChatId: 'A', fromMessageId: 'ra', toChatId: 'B', createdChat: false, text: 'x', status: 'running', toReplyId: 'rb', replyText: null, reason: null, resumedAs: null });
    service = build();
    service.start();
    await flush();
    await service.idle();
    await vi.waitFor(() => expect(repliesIn('A')).toBe(2));
    expect(store.chatSends.get('s1')).toMatchObject({ status: 'failed', reason: 'OtherBench stopped.' });
  });

  it('after a restart, a queued send goes out', async () => {
    service.dispose();
    store.chatSends.create({ id: 's1', chainId: 'gone', depth: 1, fromChatId: 'A', fromMessageId: 'gone', toChatId: 'B', createdChat: false, text: 'x', status: 'queued', toReplyId: null, replyText: null, reason: null, resumedAs: null });
    service = build();
    service.start();
    await flush();
    await service.idle();
    expect(store.chatSends.get('s1')!.status).toBe('running');
  });

  it('drops the replies, without throwing, when the sender chat was deleted', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await finish(r, 'Sent.');
    store.chats.delete('A');
    await finish(workerOf(r, 'B'), 'done');
    expect(store.chatSends.byFromMessage(r)[0]).toMatchObject({ status: 'replied', resumedAs: 'none' });
  });

  it('lists the chats waiting on sends they made', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    expect(service.waitingChatIds()).toEqual(['A']);
    await finish(r, 'Sent.');
    await finish(workerOf(r, 'B'), 'done');
    await vi.waitFor(() => expect(repliesIn('A')).toBe(2));
    expect(service.waitingChatIds()).toEqual([]);
  });
});

describe('ChatSendService: shutting down', () => {
  it('does nothing once disposed, even for a reply that ended just before', async () => {
    const unsettled = vi.spyOn(store.chatSends, 'unsettled');
    (service as unknown as { onReplyEnded(id: string, s: string): void }).onReplyEnded('some-reply', 'complete');
    service.dispose();
    unsettled.mockClear();
    await flush();
    await flush();
    expect(unsettled).not.toHaveBeenCalled();
  });
});

describe('ChatSendService: review fixes', () => {
  const settled = async (): Promise<void> => {
    await flush();
    await service.idle();
    await flush();
    await service.idle();
  };

  it('Stop on the card keeps the sender quiet even when one chat had already replied', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }, { chatId: 'C', text: 'y' }]);
    await finish(r, 'Sent.');
    await finish(workerOf(r, 'B'), 'B done');
    service.stop(r);
    await vi.waitFor(() => expect(store.messages.get(workerOf(r, 'C'))!.status).toBe('cancelled'));
    await settled();
    expect(repliesIn('A')).toBe(1);
    expect(store.chatSends.byFromMessage(r).find((s) => s.toChatId === 'C')).toMatchObject({ status: 'stopped' });
  });

  it('Stop on the sender reply itself keeps it quiet even when one chat had already replied', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }, { chatId: 'C', text: 'y' }]);
    await finish(workerOf(r, 'B'), 'B done');
    runner.cancel(r);
    await vi.waitFor(() => expect(store.messages.get(workerOf(r, 'C'))!.status).toBe('cancelled'));
    await settled();
    expect(repliesIn('A')).toBe(1);
  });

  it('Stop on the card keeps a chat further down quiet too, when one of its own sends had replied', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await finish(r, 'Sent.');
    const b1 = workerOf(r, 'B');
    await send('B', b1, [{ chatId: 'C', text: 'c' }, { chatId: 'D', text: 'd' }]);
    await finish(b1, 'Asked C and D.');
    await finish(workerOf(b1, 'D'), 'D done');
    service.stop(r);
    await vi.waitFor(() => expect(store.messages.get(workerOf(b1, 'C'))!.status).toBe('cancelled'));
    await settled();
    expect(repliesIn('B')).toBe(1);
    expect(repliesIn('A')).toBe(1);
  });

  it('Stop on the card after every reply came back, while the sender was busy, still keeps it quiet', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await finish(r, 'Sent.');
    const mine = await reply('A', 'something else meanwhile');
    await finish(workerOf(r, 'B'), 'done');
    service.stop(r);
    await finish(mine, 'ok');
    await settled();
    expect(repliesIn('A')).toBe(2);
    expect(service.waitingChatIds()).toEqual([]);
  });

  it('a regenerated reply can send: it is not a compare turn', async () => {
    const first = await reply('A');
    await finish(first, 'first try');
    const userId = store.messages.get(first)!.parentId!;
    const again = store.messages.create({ id: 'regen', chatId: 'A', parentId: userId, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: { profileId: 'p1', profileName: 'Mock', connectionId: 'conn', modelId: 'm', regenerated: true } });
    expect('sent' in (await send('A', again.id, [{ chatId: 'B', text: 'x' }]))).toBe(true);
  });

  it('a send waiting on the notes of the user goes out once they clear, with no reply ending anywhere', async () => {
    service.dispose();
    service = build({ retryMs: 20 });
    service.start();
    waitingNotes.add('B');
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    expect(store.chatSends.byFromMessage(r)[0]!.status).toBe('queued');
    waitingNotes.delete('B');
    await vi.waitFor(() => expect(store.chatSends.byFromMessage(r)[0]!.status).toBe('running'));
  });

  it('after a restart, a group that had all come back but not resumed its sender resumes it', async () => {
    service.dispose();
    const now = Date.now();
    store.messages.create({ id: 'ua', chatId: 'A', parentId: null, role: 'user', parts: [{ type: 'text', text: 'go' }], status: 'complete', error: null, producedBy: null, createdAt: now });
    store.messages.create({ id: 'ra', chatId: 'A', parentId: 'ua', role: 'assistant', parts: [{ type: 'text', text: 'Sent.' }], status: 'complete', error: null, producedBy: { profileId: 'p1', profileName: 'Mock', connectionId: 'conn', modelId: 'm' }, createdAt: now + 1 });
    store.chats.update('A', { headMessageId: 'ua' });
    store.chatSends.create({ id: 's1', chainId: 'ra', depth: 1, fromChatId: 'A', fromMessageId: 'ra', toChatId: 'B', createdChat: false, text: 'x', status: 'replied', toReplyId: 'gone', replyText: 'done', reason: null, resumedAs: null });
    service = build();
    service.start();
    await vi.waitFor(() => expect(repliesIn('A')).toBe(2));
  });

  it('after a restart, a chat in the middle of a chain whose reply was lost does not resume for nobody', async () => {
    service.dispose();
    const now = Date.now();
    const mk = (id: string, chatId: string, parentId: string | null, role: 'user' | 'assistant', status: 'complete' | 'error', at: number) =>
      store.messages.create({ id, chatId, parentId, role, parts: [{ type: 'text', text: id }], status, error: status === 'error' ? { kind: 'unknown', message: 'OtherBench stopped.', retryable: true } : null, producedBy: role === 'assistant' ? { profileId: 'p1', profileName: 'Mock', connectionId: 'conn', modelId: 'm' } : null, createdAt: at });
    mk('ua', 'A', null, 'user', 'complete', now);
    mk('ra', 'A', 'ua', 'assistant', 'complete', now + 1);
    mk('ub', 'B', null, 'user', 'complete', now + 2);
    mk('rb', 'B', 'ub', 'assistant', 'error', now + 3);
    mk('uc', 'C', null, 'user', 'complete', now + 4);
    mk('rc', 'C', 'uc', 'assistant', 'error', now + 5);
    for (const [chat, head] of [['A', 'ua'], ['B', 'ub'], ['C', 'uc']] as const) store.chats.update(chat, { headMessageId: head });
    store.chatSends.create({ id: 'ab', chainId: 'ra', depth: 1, fromChatId: 'A', fromMessageId: 'ra', toChatId: 'B', createdChat: false, text: 'x', status: 'running', toReplyId: 'rb', replyText: null, reason: null, resumedAs: null, createdAt: now });
    store.chatSends.create({ id: 'bc', chainId: 'ra', depth: 2, fromChatId: 'B', fromMessageId: 'rb', toChatId: 'C', createdChat: false, text: 'y', status: 'running', toReplyId: 'rc', replyText: null, reason: null, resumedAs: null, createdAt: now + 1 });
    service = build();
    service.start();
    await vi.waitFor(() => expect(repliesIn('A')).toBe(2));
    await settled();
    expect(repliesIn('B')).toBe(1);
  });

  it('tells the sender, from its own side, that a chat it sent to was deleted while waiting on others', async () => {
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await finish(r, 'Sent.');
    const b1 = workerOf(r, 'B');
    await send('B', b1, [{ chatId: 'C', text: 'y' }]);
    await finish(b1, 'Asked C.');
    store.chats.delete('B');
    await finish(workerOf(b1, 'C'), 'C done');
    await vi.waitFor(() => expect(store.chatSends.byFromMessage(r)[0]).toMatchObject({ status: 'dropped', reason: expect.stringMatching(/chat it was sent to was deleted/) }));
  });

  it('a send stays queued, not failed, when the target gets busy while its profile is read', async () => {
    let raced = false;
    service.dispose();
    service = build({
      resolveProfile: async (id) => {
        if (!raced) {
          raced = true;
          await reply('B', 'the user got there first');
        }
        return resolveP(id);
      },
    });
    service.start();
    const r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    expect(store.chatSends.byFromMessage(r)[0]!.status).toBe('queued');
    await finish(latestReply('B')!, 'mine done');
    await vi.waitFor(() => expect(store.chatSends.byFromMessage(r)[0]!.status).toBe('running'));
  });

  it('a Stop that lands while the target turn is starting stops that turn', async () => {
    let r = '';
    service.dispose();
    service = build({
      startTurn: async (input) => {
        if (input.chatId === 'B') service.stop(r);
        return startTurn(turnDeps, input);
      },
    });
    service.start();
    r = await reply('A');
    await send('A', r, [{ chatId: 'B', text: 'x' }]);
    await settled();
    expect(store.chatSends.byFromMessage(r)[0]!.status).toBe('stopped');
    await vi.waitFor(() => expect(store.messages.get(latestReply('B')!)!.status).toBe('cancelled'));
  });
});
