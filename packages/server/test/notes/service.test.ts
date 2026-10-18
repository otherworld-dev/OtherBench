import { describe, expect, it, vi } from 'vitest';
import { TurnRunner, type TurnInput } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { EngineEvent, EngineRequest, SelfStart } from '@otherbench/core/ports/chat-engine.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { NoteAttachment } from '@otherbench/core/types/messages.js';
import { NotesService } from '../../src/notes/service.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry, type ChatStreamEvent } from '../../src/stream/registry.js';
import { startTurn } from '../../src/turn-start.js';

const FINISH: EngineEvent = { type: 'finish', usage: { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
const IMAGE: NoteAttachment = { attachmentId: 'att-1', mime: 'image/png', filename: 'shot.png' };
const PDF: NoteAttachment = { attachmentId: 'att-2', mime: 'application/pdf', filename: 'spec.pdf' };

/** A fake engine whose replies run until the test ends them, and can say a note was picked up mid-reply. */
class HeldEngine extends FakeChatEngine {
  private readonly queues = new Map<string, { events: (EngineEvent | 'end')[]; wake: (() => void) | null }>();

  constructor() {
    super([]);
  }

  override async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    this.requests.push(req);
    const q = this.queue(req.messageId);
    const onAbort = (): void => q.wake?.();
    req.signal.addEventListener('abort', onAbort);
    try {
      for (;;) {
        if (req.signal.aborted) return;
        const next = q.events.shift();
        if (next === 'end') return;
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => (q.wake = resolve));
        q.wake = null;
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  push(messageId: string, ...events: (EngineEvent | 'end')[]): void {
    const q = this.queue(messageId);
    q.events.push(...events);
    q.wake?.();
  }

  finish(messageId: string): void {
    this.push(messageId, FINISH, 'end');
  }

  fail(messageId: string): void {
    this.push(messageId, { type: 'error', error: { kind: 'unknown', message: 'boom', retryable: false } }, 'end');
  }

  private queue(messageId: string): { events: (EngineEvent | 'end')[]; wake: (() => void) | null } {
    let q = this.queues.get(messageId);
    if (!q) {
      q = { events: [], wake: null };
      this.queues.set(messageId, q);
    }
    return q;
  }
}

function profile(id: string): ResolvedProfile {
  return {
    id, name: `Profile ${id}`, description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
    connection: { id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null },
    apiKey: null, model: null,
  };
}

function setup() {
  const store = new InMemoryStore();
  for (const id of ['chat-1', 'chat-2']) {
    store.chats.create({ id, title: 'Chat', profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  }
  store.attachments.create({ id: 'att-1', chatId: 'chat-1', messageId: null, filename: 'shot.png', mime: 'image/png', size: 10, sha256: 'abc', storagePath: 'x', extractedText: null });
  store.attachments.create({ id: 'att-2', chatId: 'chat-1', messageId: null, filename: 'spec.pdf', mime: 'application/pdf', size: 10, sha256: 'def', storagePath: 'y', extractedText: null });
  const engine = new HeldEngine();
  const sendToReply = vi.fn<NonNullable<FakeChatEngine['sendToReply']>>(async () => true);
  const withdrawNote = vi.fn<NonNullable<FakeChatEngine['withdrawNote']>>(async () => true);
  engine.sendToReply = sendToReply;
  engine.withdrawNote = withdrawNote;
  let service: NotesService | null = null;
  const turnRunner = new TurnRunner(store, engine, { takeNote: (messageId, noteId) => service?.take(messageId, noteId) ?? null });
  const streamRegistry = new StreamRegistry(turnRunner, store);
  const events = new AppEventBus();
  const appEvents: AppEvent[] = [];
  events.subscribe((e) => appEvents.push(e));
  const deps = { store, turnRunner, streamRegistry, events };
  const startTurnSpy = vi.fn((input: TurnInput) => startTurn(deps, input));
  const resolveProfile = vi.fn(async (id: string) => profile(id));
  let clock = 1_000;
  let ids = 0;
  const notes = new NotesService({ store, turnRunner, engine, streamRegistry, startTurn: startTurnSpy, resolveProfile, events, now: () => clock, generateId: () => `note-${++ids}` });
  service = notes;
  // As the container wires it.
  turnRunner.on((e) => {
    if (e.type === 'status' && e.status !== 'streaming') notes.replyEnded(e.messageId, e.status);
  });
  const heard: ChatStreamEvent[] = [];
  streamRegistry.subscribe('chat-1', (e) => heard.push(e));

  /** Starts a reply in chat-1 (one per profile) that runs until the test ends it. */
  const running = (profileIds: string[] = ['p1'], over: Partial<TurnInput> = {}) =>
    startTurn(deps, { chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'do the work' }], profiles: profileIds.map(profile), ...over });
  const ended = (messageId: string) => vi.waitFor(() => expect(store.messages.get(messageId)!.status).not.toBe('streaming'));
  const resolved = () => heard.filter((e): e is Extract<ChatStreamEvent, { type: 'note-resolved' }> => e.type === 'note-resolved');

  return { store, engine, sendToReply, withdrawNote, notes, turnRunner, streamRegistry, startTurnSpy, resolveProfile, appEvents, heard, running, ended, resolved, advance: (ms: number) => (clock += ms) };
}

type Ctx = ReturnType<typeof setup>;

function input(over: Partial<Parameters<NotesService['send']>[0]> = {}): Parameters<NotesService['send']>[0] {
  return { chatId: 'chat-1', text: 'also check the footer', attachments: [], parentId: null, profileIds: ['p1'], clientId: 'tab-1', ...over };
}

function selfStart(over: Partial<SelfStart> = {}): SelfStart & { declined: () => boolean } {
  let declined = false;
  return {
    chatId: 'chat-1', afterMessageId: 'none', profileId: 'p1', notice: '', unattended: false, noteIds: [],
    run: async function* (): AsyncGenerator<EngineEvent> {
      yield { type: 'text-delta', text: 'Footer checked.' };
      yield FINISH;
    },
    decline: () => {
      declined = true;
    },
    declined: () => declined,
    ...over,
  };
}

describe('NotesService', () => {
  it('takes the live path only when the composer points at the one running reply with its own profile', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();

    const note = (await ctx.notes.send(input({ parentId: r!, attachments: [PDF] })))!;

    expect(note).toMatchObject({ chatId: 'chat-1', path: 'live', replyIds: [r], text: 'also check the footer', parentId: r, profileIds: ['p1'], clientId: 'tab-1', sentAt: 1_000 });
    expect(ctx.sendToReply).toHaveBeenCalledWith(r, { id: note.id, text: 'also check the footer', attachments: [PDF] });
    // Held, not bound: a binding is set once, and the note may yet come back.
    expect(ctx.store.attachments.get('att-2')!.messageId).toBeNull();
    expect(ctx.notes.heldAttachmentIds('chat-1')).toEqual(['att-2']);
    expect(ctx.heard).toContainEqual({ type: 'notes', chatId: 'chat-1', notes: [note] });
    expect(ctx.notes.isBusy('chat-1')).toBe(true);
  });

  const waitCases: [string, (ctx: Ctx) => Promise<{ send: Parameters<NotesService['send']>[0]; replyIds: string[] }>][] = [
    ['the composer is on another message', async (ctx) => {
      const { userMessageId, assistantMessageIds } = await ctx.running();
      return { send: input({ parentId: userMessageId }), replyIds: assistantMessageIds };
    }],
    ['another profile is picked', async (ctx) => {
      const { assistantMessageIds } = await ctx.running();
      return { send: input({ parentId: assistantMessageIds[0]!, profileIds: ['p2'] }), replyIds: assistantMessageIds };
    }],
    ['two replies are running', async (ctx) => {
      const { assistantMessageIds } = await ctx.running(['p1', 'p2']);
      return { send: input({ parentId: assistantMessageIds[0]!, profileIds: ['p1'] }), replyIds: assistantMessageIds };
    }],
    ['the reply is a scheduled run', async (ctx) => {
      const { assistantMessageIds } = await ctx.running(['p1'], { unattended: true });
      return { send: input({ parentId: assistantMessageIds[0]! }), replyIds: assistantMessageIds };
    }],
    ['the note carries an image (a held image is unbound, and a reply only loads bound ones)', async (ctx) => {
      const { assistantMessageIds } = await ctx.running();
      return { send: input({ parentId: assistantMessageIds[0]!, attachments: [IMAGE] }), replyIds: assistantMessageIds };
    }],
    ['the reply is a /compact', async (ctx) => {
      const { assistantMessageIds } = await ctx.running(['p1'], { userParts: [{ type: 'context', kind: 'compact' }] });
      return { send: input({ parentId: assistantMessageIds[0]! }), replyIds: assistantMessageIds };
    }],
  ];

  it.each(waitCases)('takes the wait path when %s', async (_, arrange) => {
    const ctx = setup();
    const { send, replyIds } = await arrange(ctx);

    const note = await ctx.notes.send(send);

    expect(note).toMatchObject({ path: 'wait', replyIds });
    expect(ctx.sendToReply).not.toHaveBeenCalled();
  });

  it("falls back to the wait path when the engine can't take the note", async () => {
    const ctx = setup();
    ctx.sendToReply.mockResolvedValue(false);
    const { assistantMessageIds: [r] } = await ctx.running();

    const note = (await ctx.notes.send(input({ parentId: r! })))!;

    expect(note).toMatchObject({ path: 'wait', replyIds: [r] });
    expect(ctx.heard).toContainEqual({ type: 'notes', chatId: 'chat-1', notes: [note] });
    ctx.engine.finish(r!);
    await vi.waitFor(() => expect(ctx.startTurnSpy).toHaveBeenCalledTimes(1));
  });

  it("send returns null when the chat isn't busy", async () => {
    const ctx = setup();

    expect(await ctx.notes.send(input())).toBeNull();
    expect(ctx.notes.isBusy('chat-1')).toBe(false);
    expect(ctx.heard).toEqual([]);
  });

  it('a picked note is taken once and reported folded', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const note = (await ctx.notes.send(input({ parentId: r!, attachments: [PDF] })))!;

    ctx.engine.push(r!, { type: 'note-picked', noteId: note.id }, { type: 'text-delta', text: 'Checking the footer too.' });
    await vi.waitFor(() => expect(ctx.resolved()).toEqual([{ type: 'note-resolved', chatId: 'chat-1', noteId: note.id, outcome: 'folded', clientId: 'tab-1' }]));

    expect(ctx.notes.take(r!, note.id)).toBeNull();
    expect(ctx.notes.hasWaiting('chat-1')).toBe(false);
    expect(ctx.heard).toContainEqual({ type: 'notes', chatId: 'chat-1', notes: [] });
    ctx.engine.finish(r!);
    await ctx.ended(r!);
    expect(ctx.store.messages.get(r!)!.parts).toEqual([
      { type: 'user-note', noteId: note.id, text: 'also check the footer', attachments: [PDF] },
      { type: 'text', text: 'Checking the footer too.' },
    ]);
    // Delivered: bound to the reply that carries it, and no longer held.
    expect(ctx.store.attachments.get('att-2')!.messageId).toBe(r);
    expect(ctx.notes.heldAttachmentIds('chat-1')).toEqual([]);
    // Resolved once: nothing later moves it.
    ctx.notes.dropped('chat-1', [note.id]);
    expect(ctx.resolved()).toHaveLength(1);
    expect(ctx.notes.helloState('chat-1').noteOutcomes).toEqual([{ noteId: note.id, outcome: 'folded' }]);
  });

  it("take folds a live note into another running reply of its chat, and refuses one that isn't waiting or is another chat's", async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const note = (await ctx.notes.send(input({ parentId: r! })))!;
    ctx.engine.finish(r!);
    await ctx.ended(r!);
    const other = await startTurn(ctx, { chatId: 'chat-2', parentId: null, userParts: [{ type: 'text', text: 'hi' }], profiles: [profile('p1')] });
    // Claude Code carried on by itself in chat-1, and read the note in that reply.
    const { assistantMessageId: s } = await ctx.turnRunner.runSelfStarted({ chatId: 'chat-1', parentId: r!, profile: profile('p1'), notice: '', unattended: false, stream: (req) => ctx.engine.stream(req) });

    expect(ctx.notes.take(other.assistantMessageIds[0]!, note.id)).toBeNull();
    expect(ctx.notes.take(s, 'note-unknown')).toBeNull();
    expect(ctx.notes.take(s, note.id)).toEqual({ type: 'user-note', noteId: note.id, text: 'also check the footer', attachments: [] });
    expect(ctx.notes.take(s, note.id)).toBeNull();
    expect(ctx.resolved().map((e) => e.outcome)).toEqual(['folded']);
  });

  it('wait notes go out as one turn when the replies end complete, in send order', async () => {
    const ctx = setup();
    const { assistantMessageIds: [a, b] } = await ctx.running(['p1', 'p2']);
    const first = (await ctx.notes.send(input({ text: 'first', parentId: a!, profileIds: ['p1', 'p2'], attachments: [IMAGE] })))!;
    const second = (await ctx.notes.send(input({ text: 'second', parentId: b!, profileIds: ['p2'], clientId: 'tab-2' })))!;
    expect([first.path, second.path]).toEqual(['wait', 'wait']);
    expect(ctx.store.attachments.get('att-1')!.messageId).toBeNull();

    ctx.engine.finish(a!);
    await ctx.ended(a!);
    expect(ctx.startTurnSpy).not.toHaveBeenCalled();
    ctx.engine.finish(b!);

    await vi.waitFor(() => expect(ctx.resolved()).toHaveLength(2));
    expect(ctx.startTurnSpy).toHaveBeenCalledTimes(1);
    expect(ctx.startTurnSpy.mock.calls[0]![0]).toMatchObject({
      chatId: 'chat-1',
      parentId: a,
      userParts: [{ type: 'text', text: 'first\n\nsecond' }, { type: 'image', attachmentId: 'att-1', mime: 'image/png' }],
      profiles: [{ id: 'p1' }, { id: 'p2' }],
    });
    expect(ctx.resolved()).toEqual([
      { type: 'note-resolved', chatId: 'chat-1', noteId: first.id, outcome: 'turn', clientId: 'tab-1' },
      { type: 'note-resolved', chatId: 'chat-1', noteId: second.id, outcome: 'turn', clientId: 'tab-2' },
    ]);
    const turn = (await ctx.startTurnSpy.mock.results[0]!.value) as Awaited<ReturnType<typeof startTurn>>;
    expect(ctx.store.chats.get('chat-1')!.headMessageId).toBe(turn.userMessageId);
    expect(ctx.store.attachments.get('att-1')!.messageId).toBe(turn.userMessageId);
    expect(ctx.notes.isBusy('chat-1')).toBe(true);
  });

  it('wait notes come back when a reply they waited on was cancelled', async () => {
    const ctx = setup();
    const { assistantMessageIds: [a, b] } = await ctx.running(['p1', 'p2']);
    const note = (await ctx.notes.send(input({ parentId: a!, profileIds: ['p1', 'p2'], attachments: [IMAGE] })))!;

    ctx.turnRunner.cancel(a!);
    ctx.engine.finish(b!);

    await vi.waitFor(() => expect(ctx.resolved()).toEqual([{ type: 'note-resolved', chatId: 'chat-1', noteId: note.id, outcome: 'returned', clientId: 'tab-1', note }]));
    expect(ctx.startTurnSpy).not.toHaveBeenCalled();
    expect(ctx.store.attachments.get('att-1')!.messageId).toBeNull();
    expect(ctx.notes.heldAttachmentIds('chat-1')).toEqual([]);
    expect(ctx.notes.isBusy('chat-1')).toBe(false);
  });

  it('live notes come back when their reply is stopped; on a complete reply they wait for the follow-on', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const picked = (await ctx.notes.send(input({ text: 'picked', parentId: r! })))!;
    const queued = (await ctx.notes.send(input({ text: 'queued', parentId: r! })))!;
    ctx.engine.push(r!, { type: 'note-picked', noteId: picked.id });
    await vi.waitFor(() => expect(ctx.resolved()).toHaveLength(1));

    ctx.turnRunner.cancel(r!);
    await ctx.ended(r!);

    expect(ctx.resolved().map((e) => [e.noteId, e.outcome])).toEqual([[picked.id, 'folded'], [queued.id, 'returned']]);
    expect(ctx.store.messages.get(r!)!.parts).toEqual([{ type: 'user-note', noteId: picked.id, text: 'picked', attachments: [] }]);
    expect(ctx.startTurnSpy).toHaveBeenCalledTimes(0);
    expect(ctx.notes.isBusy('chat-1')).toBe(false);

    const { assistantMessageIds: [r2] } = await ctx.running();
    const late = (await ctx.notes.send(input({ parentId: r2! })))!;
    ctx.engine.finish(r2!);
    await ctx.ended(r2!);
    expect(ctx.notes.helloState('chat-1').notes).toEqual([late]);
    expect(ctx.notes.isBusy('chat-1')).toBe(true);
  });

  it('a follow-on makes one user message from its notes and moves the head to it', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const first = (await ctx.notes.send(input({ text: 'first', parentId: r!, attachments: [PDF] })))!;
    const second = (await ctx.notes.send(input({ text: 'second', parentId: r! })))!;
    ctx.engine.finish(r!);
    await ctx.ended(r!);
    const start = selfStart({ afterMessageId: r!, noteIds: [second.id, first.id] });

    await ctx.notes.followOn(start);

    const [user] = ctx.store.messages.children(r!);
    expect(user).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'first\n\nsecond' }, { type: 'file', attachmentId: 'att-2' }] });
    expect(ctx.store.attachments.get('att-2')!.messageId).toBe(user!.id);
    const [reply] = ctx.store.messages.children(user!.id);
    await ctx.ended(reply!.id);
    expect(ctx.store.messages.get(reply!.id)).toMatchObject({ status: 'complete', parts: [{ type: 'text', text: 'Footer checked.' }] });
    expect(ctx.store.chats.get('chat-1')!.headMessageId).toBe(user!.id);
    expect(ctx.appEvents).toContainEqual({ type: 'turn-started', chatId: 'chat-1', messageIds: [reply!.id] });
    expect(ctx.streamRegistry.snapshot('chat-1').some((b) => b.messageId === reply!.id)).toBe(true);
    expect(ctx.resolved().map((e) => [e.noteId, e.outcome])).toEqual([[first.id, 'turn'], [second.id, 'turn']]);
    expect(start.declined()).toBe(false);
    expect(ctx.notes.hasWaiting('chat-1')).toBe(false);
  });

  it('a follow-on whose notes were already returned is declined', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const note = (await ctx.notes.send(input({ parentId: r! })))!;
    ctx.turnRunner.cancel(r!);
    await ctx.ended(r!);
    const start = selfStart({ afterMessageId: r!, noteIds: [note.id] });

    await ctx.notes.followOn(start);

    expect(start.declined()).toBe(true);
    expect(ctx.store.messages.children(r!)).toEqual([]);
    expect(ctx.resolved().map((e) => e.outcome)).toEqual(['returned']);
  });

  const declineCases: [string, (ctx: Ctx, r: string) => void][] = [
    ['a /clear came after the reply', (ctx, r) => {
      ctx.store.messages.create({ id: 'line', chatId: 'chat-1', parentId: r, role: 'user', parts: [{ type: 'context', kind: 'clear' }], status: 'complete', error: null, producedBy: null });
      ctx.store.chats.update('chat-1', { headMessageId: 'line' });
    }],
    ["the profile can't be resolved", (ctx) => {
      ctx.resolveProfile.mockRejectedValue(new Error('gone'));
    }],
  ];

  it.each(declineCases)('a follow-on declined because %s returns its notes', async (_, arrange) => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const note = (await ctx.notes.send(input({ parentId: r!, attachments: [PDF] })))!;
    expect(note.path).toBe('live');
    ctx.engine.finish(r!);
    await ctx.ended(r!);
    arrange(ctx, r!);
    const start = selfStart({ afterMessageId: r!, noteIds: [note.id] });

    await ctx.notes.followOn(start);

    expect(start.declined()).toBe(true);
    expect(ctx.resolved()).toEqual([{ type: 'note-resolved', chatId: 'chat-1', noteId: note.id, outcome: 'returned', clientId: 'tab-1', note }]);
    expect(ctx.store.attachments.get('att-2')!.messageId).toBeNull();
    expect(ctx.notes.heldAttachmentIds('chat-1')).toEqual([]);
    expect(ctx.notes.isBusy('chat-1')).toBe(false);
  });

  it('a follow-on for a chat that was deleted is declined', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const note = (await ctx.notes.send(input({ parentId: r! })))!;
    ctx.engine.finish(r!);
    await ctx.ended(r!);
    ctx.store.chats.delete('chat-1');
    const start = selfStart({ afterMessageId: r!, noteIds: [note.id] });

    await ctx.notes.followOn(start);

    expect(start.declined()).toBe(true);
    expect(ctx.notes.isBusy('chat-1')).toBe(false);
  });

  it('dropped notes come back with their attachments unbound', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const note = (await ctx.notes.send(input({ parentId: r!, attachments: [PDF] })))!;
    expect(note.path).toBe('live');
    ctx.engine.finish(r!);
    await ctx.ended(r!);

    ctx.notes.dropped('chat-1', [note.id, 'note-unknown']);

    expect(ctx.resolved()).toEqual([{ type: 'note-resolved', chatId: 'chat-1', noteId: note.id, outcome: 'returned', clientId: 'tab-1', note }]);
    expect(ctx.store.attachments.get('att-2')!.messageId).toBeNull();
    expect(ctx.notes.heldAttachmentIds('chat-1')).toEqual([]);
    expect(ctx.notes.isBusy('chat-1')).toBe(false);
    // Reported again, or for a chat that's gone: nothing happens.
    ctx.notes.dropped('chat-1', [note.id]);
    ctx.notes.dropped('chat-gone', ['note-x']);
    expect(ctx.resolved()).toHaveLength(1);
  });

  it('withdraw returns the note and unbinds its attachments; null once it was read', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const live = (await ctx.notes.send(input({ text: 'live', parentId: r! })))!;
    const waiting = (await ctx.notes.send(input({ parentId: r!, profileIds: ['p2'], attachments: [IMAGE] })))!;
    expect([live.path, waiting.path]).toEqual(['live', 'wait']);
    expect(ctx.notes.heldAttachmentIds('chat-1')).toEqual(['att-1']);

    expect(await ctx.notes.withdraw('chat-1', waiting.id)).toEqual(waiting);
    expect(ctx.store.attachments.get('att-1')!.messageId).toBeNull();
    expect(ctx.notes.heldAttachmentIds('chat-1')).toEqual([]);
    expect(await ctx.notes.withdraw('chat-1', waiting.id)).toBeNull();

    // Claude already started reading it.
    ctx.withdrawNote.mockResolvedValueOnce(false);
    expect(await ctx.notes.withdraw('chat-1', live.id)).toBeNull();
    expect(ctx.notes.helloState('chat-1').notes).toEqual([live]);
    expect(await ctx.notes.withdraw('chat-1', live.id)).toEqual(live);
    expect(ctx.withdrawNote).toHaveBeenCalledWith(live.id);
    expect(ctx.resolved().map((e) => [e.noteId, e.outcome])).toEqual([[waiting.id, 'removed'], [live.id, 'removed']]);
    expect(ctx.notes.hasWaiting('chat-1')).toBe(false);
  });

  it('helloState lists waiting notes and recent outcomes', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const gone = (await ctx.notes.send(input({ parentId: r!, profileIds: ['p2'] })))!;
    await ctx.notes.withdraw('chat-1', gone.id);
    const waiting = (await ctx.notes.send(input({ parentId: r! })))!;

    expect(ctx.notes.helloState('chat-1')).toEqual({ notes: [waiting], noteOutcomes: [{ noteId: gone.id, outcome: 'removed' }] });
    expect(ctx.notes.helloState('chat-2')).toEqual({ notes: [], noteOutcomes: [] });

    ctx.advance(10 * 60_000 + 1);
    expect(ctx.notes.helloState('chat-1')).toEqual({ notes: [waiting], noteOutcomes: [] });
  });

  it('wait notes hold while a live note waits for its follow-on, then go after it', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const live = (await ctx.notes.send(input({ text: 'live', parentId: r! })))!;
    const waiting = (await ctx.notes.send(input({ text: 'waiting', parentId: r!, profileIds: ['p2'] })))!;
    ctx.engine.finish(r!);
    await ctx.ended(r!);
    expect(ctx.startTurnSpy).not.toHaveBeenCalled();

    await ctx.notes.followOn(selfStart({ afterMessageId: r!, noteIds: [live.id] }));
    const [user] = ctx.store.messages.children(r!);
    const [reply] = ctx.store.messages.children(user!.id);
    await ctx.ended(reply!.id);

    await vi.waitFor(() => expect(ctx.startTurnSpy).toHaveBeenCalledTimes(1));
    expect(ctx.startTurnSpy.mock.calls[0]![0]).toMatchObject({ parentId: r, userParts: [{ type: 'text', text: 'waiting' }], profiles: [{ id: 'p2' }] });
    await vi.waitFor(() => expect(ctx.resolved().map((e) => [e.noteId, e.outcome])).toEqual([[live.id, 'turn'], [waiting.id, 'turn']]));
  });

  it('a note sent while its reply was ending is still resolved, never left waiting', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    let release!: (taken: boolean) => void;
    ctx.sendToReply.mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)));
    const sending = ctx.notes.send(input({ parentId: r! }));

    ctx.turnRunner.cancel(r!);
    await ctx.ended(r!);
    release(false);
    const note = (await sending)!;

    expect(ctx.resolved()).toEqual([expect.objectContaining({ noteId: note.id, outcome: 'returned' })]);
    expect(ctx.notes.isBusy('chat-1')).toBe(false);
  });

  it('a stopped follow-on returns the wait notes held behind it, and no turn runs', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const live = (await ctx.notes.send(input({ text: 'live', parentId: r! })))!;
    const behind = (await ctx.notes.send(input({ text: 'behind', parentId: r!, profileIds: ['p2'] })))!;
    ctx.engine.finish(r!);
    await ctx.ended(r!);

    await ctx.notes.followOn(selfStart({ afterMessageId: r!, noteIds: [live.id], run: (req) => ctx.engine.stream(req) }));
    const [user] = ctx.store.messages.children(r!);
    const [f] = ctx.store.messages.children(user!.id);
    ctx.turnRunner.cancel(f!.id);
    await ctx.ended(f!.id);

    expect(ctx.resolved().map((e) => [e.noteId, e.outcome])).toEqual([[live.id, 'turn'], [behind.id, 'returned']]);
    expect(ctx.startTurnSpy).not.toHaveBeenCalled();
    expect(ctx.notes.isBusy('chat-1')).toBe(false);
  });

  it('a stopped notes turn returns a note sent while it was starting; the notes going out stay listed until resolved', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const first = (await ctx.notes.send(input({ text: 'first', parentId: r!, profileIds: ['p2'] })))!;
    let release!: (p: ResolvedProfile) => void;
    ctx.resolveProfile.mockImplementationOnce(() => new Promise<ResolvedProfile>((resolve) => (release = resolve)));
    ctx.engine.finish(r!);
    await ctx.ended(r!);
    await vi.waitFor(() => expect(ctx.resolveProfile).toHaveBeenCalledTimes(1));

    // Going out, but not yet resolved: still listed, held, and not the user's to take back.
    expect(ctx.notes.helloState('chat-1').notes).toEqual([first]);
    expect(await ctx.notes.withdraw('chat-1', first.id)).toBeNull();
    const during = (await ctx.notes.send(input({ text: 'during', parentId: r!, profileIds: ['p2'] })))!;
    expect(during).toMatchObject({ path: 'wait', replyIds: [] });
    expect(ctx.notes.helloState('chat-1').notes).toEqual([first, during]);
    release(profile('p2'));
    await vi.waitFor(() => expect(ctx.resolved()).toHaveLength(1));
    // Resolved first, then the set without it, so no client ever sees it neither waiting nor resolved.
    const at = ctx.heard.findIndex((e) => e.type === 'note-resolved');
    expect(ctx.heard.slice(0, at).filter((e) => e.type === 'notes').every((e) => e.type === 'notes' && e.notes.some((n) => n.id === first.id))).toBe(true);
    expect(ctx.heard[at + 1]).toEqual({ type: 'notes', chatId: 'chat-1', notes: [during] });

    const turn = (await ctx.startTurnSpy.mock.results[0]!.value) as Awaited<ReturnType<typeof startTurn>>;
    ctx.turnRunner.cancel(turn.assistantMessageIds[0]!);
    await ctx.ended(turn.assistantMessageIds[0]!);

    expect(ctx.resolved().map((e) => [e.noteId, e.outcome])).toEqual([[first.id, 'turn'], [during.id, 'returned']]);
    expect(ctx.startTurnSpy).toHaveBeenCalledTimes(1);
  });

  it('notes being made into a follow-on stay listed until resolved', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const live = (await ctx.notes.send(input({ parentId: r!, attachments: [PDF] })))!;
    ctx.engine.finish(r!);
    await ctx.ended(r!);
    let release!: (p: ResolvedProfile) => void;
    ctx.resolveProfile.mockImplementationOnce(() => new Promise<ResolvedProfile>((resolve) => (release = resolve)));

    const following = ctx.notes.followOn(selfStart({ afterMessageId: r!, noteIds: [live.id] }));
    await vi.waitFor(() => expect(ctx.resolveProfile).toHaveBeenCalledTimes(1));

    expect(ctx.notes.helloState('chat-1').notes).toEqual([live]);
    expect(ctx.notes.heldAttachmentIds('chat-1')).toEqual(['att-2']);
    expect(ctx.notes.hasWaiting('chat-1')).toBe(true);
    release(profile('p1'));
    await following;
    expect(ctx.notes.helloState('chat-1').notes).toEqual([]);
    expect(ctx.resolved().map((e) => e.outcome)).toEqual(['turn']);
  });

  it("on Stop of another reply, a live note Claude already started stays waiting; one it hadn't comes back", async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const started = (await ctx.notes.send(input({ text: 'started', parentId: r! })))!;
    const queued = (await ctx.notes.send(input({ text: 'queued', parentId: r! })))!;
    ctx.engine.finish(r!);
    await ctx.ended(r!);
    ctx.withdrawNote.mockImplementation(async (noteId) => noteId === queued.id);
    // Claude Code carried on by itself in the same process, and the user stopped that.
    const { assistantMessageId: s } = await ctx.turnRunner.runSelfStarted({ chatId: 'chat-1', parentId: r!, profile: profile('p1'), notice: '', unattended: false, stream: (req) => ctx.engine.stream(req) });
    ctx.turnRunner.cancel(s);
    await ctx.ended(s);

    await vi.waitFor(() => expect(ctx.resolved()).toEqual([expect.objectContaining({ noteId: queued.id, outcome: 'returned' })]));
    expect(ctx.withdrawNote).toHaveBeenCalledWith(started.id);
    expect(ctx.notes.helloState('chat-1').notes).toEqual([started]);
  });

  const failures: [string, Partial<Parameters<NotesService['send']>[0]>, (ctx: Ctx) => void][] = [
    ['the turn fails to start', { profileIds: ['p2'] }, (ctx) => ctx.startTurnSpy.mockRejectedValueOnce(new Error('boom'))],
    ['the message they follow is gone', { parentId: 'gone', profileIds: ['p2'] }, () => undefined],
    ['no profile was picked', { profileIds: [] }, () => undefined],
  ];

  it.each(failures)('wait notes come back when %s', async (_, over, arrange) => {
    const ctx = setup();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { assistantMessageIds: [r] } = await ctx.running();
    const note = (await ctx.notes.send(input({ parentId: r!, attachments: [IMAGE], ...over })))!;
    expect(note.path).toBe('wait');
    arrange(ctx);

    ctx.engine.finish(r!);

    await vi.waitFor(() => expect(ctx.resolved()).toEqual([{ type: 'note-resolved', chatId: 'chat-1', noteId: note.id, outcome: 'returned', clientId: 'tab-1', note }]));
    expect(ctx.notes.helloState('chat-1')).toEqual({ notes: [], noteOutcomes: [{ noteId: note.id, outcome: 'returned' }] });
    expect(ctx.store.attachments.get('att-1')!.messageId).toBeNull();
    expect(ctx.notes.isBusy('chat-1')).toBe(false);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('dropped for a chat deleted while its notes waited does nothing but forget them', async () => {
    const ctx = setup();
    const { assistantMessageIds: [r] } = await ctx.running();
    const note = (await ctx.notes.send(input({ parentId: r! })))!;
    ctx.engine.finish(r!);
    await ctx.ended(r!);
    const before = ctx.heard.length;
    ctx.store.chats.delete('chat-1');

    ctx.notes.dropped('chat-1', [note.id]);

    expect(ctx.heard).toHaveLength(before);
    expect(ctx.notes.helloState('chat-1')).toEqual({ notes: [], noteOutcomes: [] });
    expect(ctx.notes.isBusy('chat-1')).toBe(false);
  });
});
