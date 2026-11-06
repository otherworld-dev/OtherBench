import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SENDS_PER_CHAIN } from '@otherbench/core/domain/chat-sends.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { resolveWorkspace } from '@otherbench/core/domain/workspace.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { SendOutcome, SendTarget } from '@otherbench/core/ports/chat-messenger.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { ChatSendService, type ChatSendDeps } from '../../src/chat-sends/service.js';
import { collectMessageTree, createAppChat } from '../../src/routes/chats.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { startTurn, type TurnStartDeps } from '../../src/turn-start.js';

/** A ChatEngine driven by hand per message id (as in schedule/service.test.ts), recording every request. */
function manualEngine(): { engine: ChatEngine; push: (messageId: string, event: EngineEvent | null) => void; requests: EngineRequest[] } {
  interface Channel {
    queued: (EngineEvent | null)[];
    waiters: ((event: EngineEvent | null) => void)[];
  }
  const channels = new Map<string, Channel>();
  const requests: EngineRequest[] = [];
  const channelFor = (messageId: string): Channel => {
    let ch = channels.get(messageId);
    if (!ch) {
      ch = { queued: [], waiters: [] };
      channels.set(messageId, ch);
    }
    return ch;
  };
  const engine: ChatEngine = {
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      requests.push(req);
      const ch = channelFor(req.messageId);
      while (true) {
        if (req.signal.aborted) return;
        const event = await new Promise<EngineEvent | null>((resolve) => {
          if (ch.queued.length > 0) {
            resolve(ch.queued.shift() as EngineEvent | null);
            return;
          }
          const onAbort = (): void => resolve(null);
          req.signal.addEventListener('abort', onAbort, { once: true });
          ch.waiters.push((e) => {
            req.signal.removeEventListener('abort', onAbort);
            resolve(e);
          });
        });
        if (event === null || req.signal.aborted) return;
        yield event;
        if (event.type === 'finish' || event.type === 'error') return;
      }
    },
    listModels: async () => [],
    testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
  };
  const push = (messageId: string, event: EngineEvent | null): void => {
    const ch = channelFor(messageId);
    const waiter = ch.waiters.shift();
    if (waiter) waiter(event);
    else ch.queued.push(event);
  };
  return { engine, push, requests };
}

const FINISH: EngineEvent = { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let store: InMemoryStore;
let engine: ReturnType<typeof manualEngine>;
let bus: AppEventBus;
let events: AppEvent[];
let runner: TurnRunner;
let turnDeps: TurnStartDeps;
let service: ChatSendService;
let waitingNotes: Set<string>;

async function resolveP(id: string): Promise<ResolvedProfile> {
  const p = store.profiles.get(id);
  if (!p) throw new Error(`Profile "${id}" not found.`);
  return { ...p, connection: store.connections.get(p.connectionId)!, apiKey: null, model: null };
}

function build(over: Partial<ChatSendDeps> = {}): ChatSendService {
  return new ChatSendService({
    store,
    turnRunner: runner,
    startTurn: (input) => startTurn(turnDeps, input),
    resolveProfile: resolveP,
    resolveWorkspace: (ws) => resolveWorkspace(ws, store.nodes.self().id, store.locations.allPaths(), () => true),
    isChatBusy: (chatId) => bus.runningTurns().some((t) => t.chatId === chatId),
    hasWaitingNotes: (chatId) => waitingNotes.has(chatId),
    createAppChat: (app, title) => createAppChat({ store }, app, title),
    emit: (e) => bus.emit(e),
    ...over,
  });
}

function addChat(id: string, over: Record<string, unknown> = {}): void {
  store.chats.create({ id, title: `Chat ${id}`, profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, ...over });
}

/** Starts a turn in `chatId` with `text` and returns its reply's id (still streaming). */
async function reply(chatId: string, text = 'hello'): Promise<string> {
  const chat = store.chats.get(chatId)!;
  const tip = chat.headMessageId === null ? null : store.messages.children(chat.headMessageId).at(-1)?.id ?? chat.headMessageId;
  const result = await startTurn(turnDeps, { chatId, parentId: tip, userParts: [{ type: 'text', text }], profiles: [await resolveP(chat.profileId)] });
  return result.assistantMessageIds[0]!;
}

async function finish(replyId: string, text: string): Promise<void> {
  engine.push(replyId, { type: 'text-delta', text });
  engine.push(replyId, FINISH);
  await vi.waitFor(() => expect(store.messages.get(replyId)?.status).toBe('complete'));
  await flush();
  await service.idle();
}

function ctxFor(chatId: string, messageId: string, over: Partial<ToolContext> = {}): ToolContext {
  return { chatId, messageId, profileId: 'p1', workspaceRoot: null, signal: new AbortController().signal, ...over };
}

async function send(chatId: string, messageId: string, targets: SendTarget[]): Promise<SendOutcome> {
  const out = await service.send(ctxFor(chatId, messageId), targets);
  await flush();
  await service.idle();
  return out;
}

const refusal = (out: SendOutcome): string => ('refused' in out ? out.refused : '');
/** The newest reply in a chat. */
const latestReply = (chatId: string): string | undefined =>
  collectMessageTree(store, chatId)
    .filter((m) => m.role === 'assistant')
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(-1)?.id;

beforeEach(() => {
  store = new InMemoryStore();
  engine = manualEngine();
  runner = new TurnRunner(store, engine.engine);
  bus = new AppEventBus();
  bus.attach(runner, store);
  events = [];
  bus.subscribe((e) => events.push(e));
  turnDeps = { store, turnRunner: runner, streamRegistry: new StreamRegistry(runner, store), events: bus };
  waitingNotes = new Set();
  store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'p1', name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', artifacts: false, recall: false },
    isDefault: true, archivedAt: null,
  });
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
    const listed = service.list(ctxFor('A', 'r'));
    expect(listed.map((c) => c.chatId).sort()).toEqual(['B', 'C']);
    expect(listed.find((c) => c.chatId === 'B')).toMatchObject({ app: 'Server', busy: false });
    expect(listed.find((c) => c.chatId === 'C')).toMatchObject({ busy: true });
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
