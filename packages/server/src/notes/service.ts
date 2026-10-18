import { randomUUID } from 'node:crypto';
import { contextLineOf } from '@otherbench/core/domain/context-lines.js';
import { notePart, notesToParts } from '@otherbench/core/domain/notes.js';
import type { TurnInput, TurnResult, TurnRunner } from '@otherbench/core/domain/turn.js';
import type { ChatEngine, SelfStart } from '@otherbench/core/ports/chat-engine.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { CanonMessage, MessageStatus, NoteAttachment, UserNotePart } from '@otherbench/core/types/messages.js';
import type { NoteOutcome, ReplyNote } from '@otherbench/core/types/notes.js';
import type { AppEventBus } from '../stream/events.js';
import type { StreamRegistry } from '../stream/registry.js';
import { lineAfter } from '../turn-start.js';

/** How long a resolved note's outcome is kept for a client that reconnects (`helloState`). */
const OUTCOME_KEEP_MS = 10 * 60_000;

export interface NotesServiceDeps {
  store: Store;
  turnRunner: TurnRunner;
  engine: ChatEngine;
  streamRegistry: StreamRegistry;
  /** Starts a turn as `POST /chats/:id/turns` does (turn-start.ts). */
  startTurn: (input: TurnInput) => Promise<TurnResult>;
  resolveProfile: (id: string) => Promise<ResolvedProfile>;
  events?: AppEventBus;
  /** Told a follow-on started, as `startSelfStartedTurn` tells it, so the chat isn't summarised as quiet mid-reply. */
  memory?: { noteTurnStarted(chatId: string): void };
  now?: () => number;
  generateId?: () => string;
}

export interface SendNoteInput {
  chatId: string;
  text: string;
  attachments: NoteAttachment[];
  parentId: string | null;
  profileIds: string[];
  clientId: string;
}

/** A waiting note. The holder stays the same when the note changes path. */
interface Held {
  note: ReplyNote;
}

/**
 * Messages the user sends while a reply is running (spec
 * 2026-10-18-send-while-replying-design). A note goes into the running reply
 * (`live`: pushed into its Claude Code through `ChatEngine.sendToReply`) only
 * when the composer points at that one reply with its own profile; otherwise it
 * `wait`s for the chat's replies to end and goes out as the next turn. This
 * holds the waiting set, in send order, and resolves each note exactly once:
 * `folded` into a reply, sent as a `turn`, `returned` to the box, or `removed`
 * by the user. Every change goes to the chat's stream subscribers.
 *
 * A note's attachments stay unsent (unbound) until it is delivered, since a
 * binding is set once: while it waits they are held (`heldAttachmentIds`; the
 * reply it goes into may load them through TurnRunner's `heldAttachment`), and
 * the message that delivers it binds them.
 */
export class NotesService {
  private readonly store: Store;
  private readonly turnRunner: TurnRunner;
  private readonly engine: ChatEngine;
  private readonly streamRegistry: StreamRegistry;
  private readonly startTurn: (input: TurnInput) => Promise<TurnResult>;
  private readonly resolveProfile: (id: string) => Promise<ResolvedProfile>;
  private readonly events?: AppEventBus;
  private readonly memory?: { noteTurnStarted(chatId: string): void };
  private readonly now: () => number;
  private readonly generateId: () => string;
  /** Each chat's waiting notes, in send order. */
  private readonly waiting = new Map<string, Held[]>();
  /**
   * Each chat's notes being made into a turn or follow-on: out of the waiting
   * set, but still listed (and the chat busy) until they are resolved.
   */
  private readonly inFlight = new Map<string, ReplyNote[]>();
  /** Each chat's recent outcomes, for `helloState`. */
  private readonly outcomes = new Map<string, { noteId: string; outcome: NoteOutcome; at: number }[]>();

  constructor(deps: NotesServiceDeps) {
    this.store = deps.store;
    this.turnRunner = deps.turnRunner;
    this.engine = deps.engine;
    this.streamRegistry = deps.streamRegistry;
    this.startTurn = deps.startTurn;
    this.resolveProfile = deps.resolveProfile;
    this.events = deps.events;
    this.memory = deps.memory;
    this.now = deps.now ?? Date.now;
    this.generateId = deps.generateId ?? randomUUID;
  }

  /** The chat has a streaming reply or waiting notes: a message now is a note. */
  isBusy(chatId: string): boolean {
    return this.streaming(chatId).length > 0 || this.hasWaiting(chatId);
  }

  /** The chat has notes not yet delivered (waiting, or being made into a turn). */
  hasWaiting(chatId: string): boolean {
    return this.listed(chatId).length > 0;
  }

  /** The attachments of the chat's undelivered notes: not the composer's to offer or delete. */
  heldAttachmentIds(chatId: string): string[] {
    return this.listed(chatId).flatMap((n) => n.attachments.map((a) => a.attachmentId));
  }

  /** Takes a note for a busy chat; null when the chat isn't busy (the client sends a normal turn instead). */
  async send(input: SendNoteInput): Promise<ReplyNote | null> {
    const { chatId } = input;
    if (!this.isBusy(chatId)) return null;
    const replies = this.streaming(chatId);
    const target = this.liveTarget(input, replies);
    const note: ReplyNote = {
      id: this.generateId(),
      chatId,
      text: input.text,
      attachments: input.attachments,
      path: target ? 'live' : 'wait',
      replyIds: target ? [target.id] : replies.map((r) => r.id),
      parentId: input.parentId,
      profileIds: input.profileIds,
      clientId: input.clientId,
      sentAt: this.now(),
    };
    const held: Held = { note };
    // Waiting before it's pushed, so a pick that comes at once finds it.
    this.waiting.set(chatId, [...this.waitingIn(chatId), held]);
    if (target) {
      let taken = false;
      try {
        taken = (await this.engine.sendToReply?.(target.id, { id: note.id, text: note.text, attachments: note.attachments })) ?? false;
      } catch (err) {
        console.error(`[otherbench-server] could not send a note into reply ${target.id}:`, err);
      }
      // Resolved meanwhile: read already, or its reply was stopped and it came back.
      if (!this.isWaiting(held)) return held.note;
      if (!taken) {
        // It waits instead: for whatever is running now, else for the reply it was meant for.
        const now = this.streaming(chatId).map((r) => r.id);
        held.note = { ...note, path: 'wait', replyIds: now.length > 0 ? now : note.replyIds };
      }
    }
    this.broadcastNotes(chatId);
    // Nothing may be running (only notes waiting): it could be due now.
    this.settle(chatId);
    return held.note;
  }

  /** Takes back a note nobody has read. Null when it was already read, or is gone. */
  async withdraw(chatId: string, noteId: string): Promise<ReplyNote | null> {
    const held = this.find(chatId, noteId);
    if (!held) return null;
    if (held.note.path === 'live' && !(await this.askBack(noteId))) return null;
    if (!this.remove(held)) return null;
    this.finish(held.note, 'removed');
    this.broadcastNotes(chatId);
    this.settle(chatId);
    return held.note;
  }

  /**
   * TurnRunner's `takeNote`: Claude read note `noteId` in reply `messageId`.
   * Any running reply of the note's chat may take a live note (Claude Code can
   * read it in a reply it started by itself, which took the process). Its
   * attachments are bound to that reply, which now carries them.
   */
  take(messageId: string, noteId: string): UserNotePart | null {
    const chatId = this.turnRunner.runningInfo(messageId)?.chatId ?? this.store.messages.get(messageId)?.chatId;
    if (chatId === undefined) return null;
    const held = this.find(chatId, noteId);
    if (!held || held.note.path !== 'live' || !this.remove(held)) return null;
    this.bind(chatId, held.note.attachments, messageId);
    this.finish(held.note, 'folded');
    this.broadcastNotes(chatId);
    return notePart(held.note);
  }

  /**
   * Reply `messageId` ended. Stopped or failed, every waiting note of the
   * chat comes back: nothing is sent after a reply the user stopped or that
   * broke. A live note of another reply is first taken back from Claude Code
   * and stays if Claude already started it (it will fold or follow on). After
   * a clean finish, live notes wait for Claude Code to run them as a
   * follow-on (or report them dropped), and wait notes may be due.
   */
  replyEnded(messageId: string, status: MessageStatus): void {
    const chatId = this.store.messages.get(messageId)?.chatId ?? [...this.waiting].find(([, list]) => list.some((h) => h.note.replyIds.includes(messageId)))?.[0];
    if (chatId === undefined) return;
    if (status === 'cancelled' || status === 'error') {
      const notes = this.waitingIn(chatId);
      // The stopped reply's own notes Claude Code cancels itself as it stops (and a closed process reports
      // any it couldn't), so withdrawNote can't tell those from started ones: they come back as they are.
      this.giveBack(chatId, notes.filter((h) => h.note.path === 'wait' || h.note.replyIds[0] === messageId));
      for (const held of notes.filter((h) => h.note.path === 'live' && h.note.replyIds[0] !== messageId)) void this.takeBack(held);
    }
    this.settle(chatId);
  }

  /**
   * Claude Code ran notes after their reply ended, as a turn of its own:
   * those still waiting become one user message under the reply, with a
   * reply that streams the turn. Declined, with the notes returned, when
   * none is waiting or the turn can't run where it would land.
   */
  async followOn(start: SelfStart): Promise<void> {
    const { chatId } = start;
    const ids = new Set(start.noteIds ?? []);
    const due = this.waitingIn(chatId).filter((h) => ids.has(h.note.id));
    if (due.length === 0) {
      start.decline();
      return;
    }
    const notes = this.startDelivering(chatId, due);
    let started = false;
    try {
      started = await this.runFollowOn(start, notes);
    } catch (err) {
      console.error(`[otherbench-server] could not run the notes Claude Code carried on with in chat ${chatId}:`, err);
    }
    if (!started) start.decline();
    this.endDelivering(chatId, notes, started ? 'turn' : 'returned');
  }

  /** The engine says these notes were never read (their process closed, or their turn ended at once). Those still waiting come back. */
  dropped(chatId: string, noteIds: string[]): void {
    if (!this.store.chats.get(chatId)) {
      // The chat is gone: nobody is there to give them back to.
      this.waiting.delete(chatId);
      return;
    }
    const ids = new Set(noteIds);
    this.giveBack(chatId, this.waitingIn(chatId).filter((h) => ids.has(h.note.id)));
    this.settle(chatId);
  }

  /** What a client connecting to the chat's stream needs: the undelivered notes and what became of recent ones. */
  helloState(chatId: string): { notes: ReplyNote[]; noteOutcomes: { noteId: string; outcome: NoteOutcome }[] } {
    this.prune();
    return {
      notes: this.listed(chatId),
      noteOutcomes: (this.outcomes.get(chatId) ?? []).map(({ noteId, outcome }) => ({ noteId, outcome })),
    };
  }

  /** The reply a note goes into, or null when it waits (see the class doc). */
  private liveTarget(input: SendNoteInput, replies: CanonMessage[]): CanonMessage | null {
    const reply = replies.length === 1 ? replies[0] : undefined;
    if (!reply || !this.engine.sendToReply || input.parentId !== reply.id) return null;
    if (input.profileIds.length !== 1 || input.profileIds[0] !== reply.producedBy?.profileId) return null;
    // A scheduled run's rules aren't the person's.
    if (this.turnRunner.runningInfo(reply.id)?.unattended !== false) return null;
    // A /compact's reply has nowhere for a note to land.
    const asked = reply.parentId ? this.store.messages.get(reply.parentId) : null;
    if (asked && contextLineOf(asked) !== null) return null;
    // A note never overtakes one already waiting for the reply to end.
    if (this.waitingIn(input.chatId).some((h) => h.note.path === 'wait')) return null;
    return reply;
  }

  /**
   * Sends the chat's wait notes once nothing in it is running: as one turn
   * when every reply they waited on finished, else back to the box. They hold
   * while a live note waits for its follow-on, so two replies never run at once.
   */
  private settle(chatId: string): void {
    if (this.inFlight.has(chatId) || this.streaming(chatId).length > 0) return;
    const due = this.waitingIn(chatId);
    if (due.length === 0 || due.some((h) => h.note.path === 'live')) return;
    const complete = due.every((h) => h.note.replyIds.every((id) => this.store.messages.get(id)?.status === 'complete'));
    if (!complete) {
      this.giveBack(chatId, due);
      return;
    }
    void this.sendAsTurn(chatId, due);
  }

  private async sendAsTurn(chatId: string, due: Held[]): Promise<void> {
    const notes = this.startDelivering(chatId, due);
    // The first note's parent and profiles: what the composer showed when the user started sending.
    const first = notes[0]!;
    let sent = false;
    try {
      const parent = first.parentId === null ? null : this.store.messages.get(first.parentId);
      if (first.parentId !== null && parent?.chatId !== chatId) throw new Error(`the message they follow (${first.parentId}) is gone`);
      if (first.profileIds.length === 0) throw new Error('no profile was picked');
      const profiles = await Promise.all(first.profileIds.map((id) => this.resolveProfile(id)));
      // TurnRunner.run binds the notes' attachments to the new user message.
      await this.startTurn({ chatId, parentId: first.parentId, userParts: notesToParts(notes), profiles });
      sent = true;
    } catch (err) {
      console.error(`[otherbench-server] could not send the notes waiting in chat ${chatId}; they go back to the message box:`, err);
    }
    this.endDelivering(chatId, notes, sent ? 'turn' : 'returned');
  }

  /** Runs a follow-on the way `startSelfStartedTurn` runs a self-start, with its guards. True once its reply exists. */
  private async runFollowOn(start: SelfStart, notes: ReplyNote[]): Promise<boolean> {
    const chat = this.store.chats.get(start.chatId);
    const after = this.store.messages.get(start.afterMessageId);
    if (!chat || !after || after.chatId !== chat.id || lineAfter({ store: this.store }, chat.headMessageId, after.id)) return false;
    let profile: ResolvedProfile;
    try {
      profile = await this.resolveProfile(start.profileId);
    } catch {
      return false;
    }
    // Checked again: a /clear, or the chat deleted, while the profile resolved.
    const now = this.store.chats.get(chat.id);
    if (!now || lineAfter({ store: this.store }, now.headMessageId, after.id)) return false;
    this.memory?.noteTurnStarted(chat.id);
    // A reply that ended without running Claude Code's turn declines it, so the turn is read and dropped.
    let ran = false;
    // It binds the notes' attachments to the new user message.
    const { userMessageId, assistantMessageId } = await this.turnRunner.runFollowOn({
      chatId: chat.id,
      parentId: after.id,
      userParts: notesToParts(notes),
      profile,
      stream: (req) => {
        ran = true;
        return start.run(req);
      },
      onEnd: () => {
        if (!ran) start.decline();
      },
    });
    try {
      this.streamRegistry.registerTurn(chat.id, [assistantMessageId]);
      // The head goes to the new user message, as a normal send does.
      this.store.chats.update(chat.id, { headMessageId: userMessageId, updatedAt: this.now() });
      this.events?.emit({ type: 'turn-started', chatId: chat.id, messageIds: [assistantMessageId] });
    } catch (err) {
      console.error(`[otherbench-server] could not announce the follow-on reply ${assistantMessageId}:`, err);
    }
    return true;
  }

  /** Moves notes from waiting to in flight. They stay listed, so the set clients see doesn't change. */
  private startDelivering(chatId: string, due: Held[]): ReplyNote[] {
    const notes = due.filter((h) => this.remove(h)).map((h) => h.note);
    this.inFlight.set(chatId, [...(this.inFlight.get(chatId) ?? []), ...notes]);
    return notes;
  }

  /** In-flight notes are resolved: each one's outcome, then the set without them. */
  private endDelivering(chatId: string, notes: ReplyNote[], outcome: NoteOutcome): void {
    const rest = (this.inFlight.get(chatId) ?? []).filter((n) => !notes.includes(n));
    if (rest.length > 0) this.inFlight.set(chatId, rest);
    else this.inFlight.delete(chatId);
    for (const note of notes) this.finish(note, outcome);
    this.broadcastNotes(chatId);
    this.settle(chatId);
  }

  /** Asks Claude Code for a live note back; returned if it was, kept (to fold or follow on) if Claude already started it. */
  private async takeBack(held: Held): Promise<void> {
    if (!(await this.askBack(held.note.id))) return;
    this.giveBack(held.note.chatId, [held]);
    this.settle(held.note.chatId);
  }

  /**
   * Asks the engine for live note `noteId` back. True when it was withdrawn,
   * or when no Claude Code has it any more (nothing would ever resolve it);
   * false when Claude has started reading it.
   */
  private async askBack(noteId: string): Promise<boolean> {
    try {
      if (await this.engine.withdrawNote?.(noteId)) return true;
    } catch (err) {
      console.error(`[otherbench-server] could not take back note ${noteId}:`, err);
    }
    return this.engine.knowsNote?.(noteId) === false;
  }

  /** The chat's replies streaming here now. */
  private streaming(chatId: string): CanonMessage[] {
    return this.store.messages.listByStatus('streaming').filter((m) => m.chatId === chatId && m.role === 'assistant' && this.turnRunner.runningInfo(m.id) !== null);
  }

  private waitingIn(chatId: string): Held[] {
    return this.waiting.get(chatId) ?? [];
  }

  /** The chat's undelivered notes: in flight, then waiting. */
  private listed(chatId: string): ReplyNote[] {
    return [...(this.inFlight.get(chatId) ?? []), ...this.waitingIn(chatId).map((h) => h.note)];
  }

  private find(chatId: string, noteId: string): Held | undefined {
    return this.waiting.get(chatId)?.find((h) => h.note.id === noteId);
  }

  private isWaiting(held: Held): boolean {
    return this.waiting.get(held.note.chatId)?.includes(held) ?? false;
  }

  /** Takes a note out of the waiting set. False when it had already left it. */
  private remove(held: Held): boolean {
    const list = this.waiting.get(held.note.chatId);
    const at = list?.indexOf(held) ?? -1;
    if (!list || at === -1) return false;
    const rest = list.filter((h) => h !== held);
    if (rest.length > 0) this.waiting.set(held.note.chatId, rest);
    else this.waiting.delete(held.note.chatId);
    return true;
  }

  /** Returns these waiting notes to the box. */
  private giveBack(chatId: string, notes: Held[]): void {
    const back = notes.filter((h) => this.remove(h));
    if (back.length === 0) return;
    for (const held of back) this.finish(held.note, 'returned');
    this.broadcastNotes(chatId);
  }

  /** Records a note's outcome and tells the chat. */
  private finish(note: ReplyNote, outcome: NoteOutcome): void {
    this.prune();
    const list = this.outcomes.get(note.chatId) ?? [];
    list.push({ noteId: note.id, outcome, at: this.now() });
    this.outcomes.set(note.chatId, list);
    this.streamRegistry.broadcastChat(note.chatId, {
      type: 'note-resolved',
      chatId: note.chatId,
      noteId: note.id,
      outcome,
      clientId: note.clientId,
      ...(outcome === 'returned' ? { note } : {}),
    });
  }

  private broadcastNotes(chatId: string): void {
    this.streamRegistry.broadcastChat(chatId, { type: 'notes', chatId, notes: this.listed(chatId) });
  }

  /** Binds the note's still-unsent attachments of this chat to the message that delivered it. */
  private bind(chatId: string, attachments: NoteAttachment[], messageId: string): void {
    for (const a of attachments) {
      const row = this.store.attachments.get(a.attachmentId);
      if (!row || row.chatId !== chatId || row.messageId !== null) continue;
      try {
        this.store.attachments.update(row.id, { messageId });
      } catch (err) {
        console.error(`[otherbench-server] could not bind attachment ${row.id} to the reply that read its note:`, err);
      }
    }
  }

  /** Forgets outcomes older than `OUTCOME_KEEP_MS`. */
  private prune(): void {
    const cutoff = this.now() - OUTCOME_KEEP_MS;
    for (const [chatId, list] of this.outcomes) {
      const kept = list.filter((o) => o.at > cutoff);
      if (kept.length === 0) this.outcomes.delete(chatId);
      else if (kept.length !== list.length) this.outcomes.set(chatId, kept);
    }
  }
}
