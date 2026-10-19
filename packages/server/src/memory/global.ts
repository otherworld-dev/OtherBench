import { emptyGlobalMemoryBody, finaliseGlobalSummary, globalMemoryUpdatePrompt, normaliseGlobalMemoryBody } from '@otherbench/core/domain/global-memory.js';
import { MEMORY_QUIET_MS, pendingMemoryMessages, renderMemoryTranscript, type MemoryFailure } from '@otherbench/core/domain/memory.js';
import type { TurnEvent } from '@otherbench/core/domain/turn.js';
import type { ChatEngine } from '@otherbench/core/ports/chat-engine.js';
import type { Chat, GlobalMemory, Store } from '@otherbench/core/ports/store.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { appDefaultProfileId } from '../profile-resolution.js';
import { collectMessageTree } from '../routes/chats.js';
import { realScheduler, type Scheduler } from './scheduler.js';
import { MEMORY_UPDATE_TIMEOUT_MS, MemoryQueue, askMemoryModel, errorMessage, pickMemoryProfile } from './shared.js';

/** `lastError` when no profile can run the summariser. */
export const NO_GLOBAL_MEMORY_MODEL_MESSAGE = 'No model available for global memory';

export interface GlobalMemoryServiceDeps {
  store: Store;
  engine: ChatEngine;
  /** Resolves a profile id to what the engine needs; rejects when it can't (a missing connection, say). */
  resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  now?: () => number;
  scheduler?: Scheduler;
  quietMs?: number;
  timeoutMs?: number;
  /** The update queue it shares with project memory; its own when not given. */
  queue?: MemoryQueue;
}

/** What one global update did. */
export type GlobalMemoryUpdateOutcome =
  | { status: 'updated'; memory: GlobalMemory }
  | { status: 'unchanged' }
  | { status: 'nothing-new' }
  | { status: 'discarded'; reason: string }
  | { status: 'failed'; error: string };

const discarded = (reason: string): GlobalMemoryUpdateOutcome => ({ status: 'discarded', reason });

/** True when nobody saved the note between `before` and `after`. */
function sameNote(before: GlobalMemory, after: GlobalMemory): boolean {
  return before.note === after.note && before.noteUpdatedAt === after.noteUpdatedAt && before.noteUpdatedBy === after.noteUpdatedBy;
}

/**
 * Keeps the learned global note current (spec
 * docs/superpowers/specs/2026-10-08-global-memory-design.md §2): the same
 * quiet timer as project memory, for every chat not marked "Don't add to
 * memory" whether it's in a project or not. When it fires, the chat's
 * completed turns after its global cursor are folded into the note by one
 * utility call that keeps only lasting facts about the user. Runs on the
 * queue it shares with project memory, so the two never call the memory
 * model at once. A failure changes nothing and is kept as `lastError` until
 * the next success; a user save while a call runs wins.
 */
export class GlobalMemoryService {
  private readonly store: Store;
  private readonly engine: ChatEngine;
  private readonly resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly quietMs: number;
  private readonly timeoutMs: number;
  private readonly queue: MemoryQueue;
  /** chatId -> pending quiet timer. */
  private readonly timers = new Map<string, unknown>();
  private failure: MemoryFailure | null = null;
  /** chatId -> an update that is queued but hasn't started; a repeat request joins it. */
  private readonly waiting = new Map<string, Promise<GlobalMemoryUpdateOutcome>>();
  /** Stops for the calls in flight, so dispose() can abort them. */
  private readonly running = new Set<() => void>();
  private disposed = false;

  constructor(deps: GlobalMemoryServiceDeps) {
    this.store = deps.store;
    this.engine = deps.engine;
    this.resolveProfile = deps.resolveProfile;
    this.now = deps.now ?? Date.now;
    this.scheduler = deps.scheduler ?? realScheduler;
    this.quietMs = deps.quietMs ?? MEMORY_QUIET_MS;
    this.timeoutMs = deps.timeoutMs ?? MEMORY_UPDATE_TIMEOUT_MS;
    this.queue = deps.queue ?? new MemoryQueue();
  }

  /** Starts the quiet timer whenever an assistant reply finishes. Call once per runner. */
  attach(turnRunner: { on(cb: (e: TurnEvent) => void): () => void }): () => void {
    return turnRunner.on((event) => {
      if (event.type !== 'status' || !(event.status === 'complete' || event.status === 'error' || event.status === 'cancelled')) return;
      const message = this.store.messages.get(event.messageId);
      if (message?.role === 'assistant') this.noteTurnCompleted(message.chatId);
    });
  }

  /** A reply completed in `chatId`: (re)start its quiet timer if the chat adds to memory. */
  noteTurnCompleted(chatId: string): void {
    const chat = this.store.chats.get(chatId);
    if (chat && this.contributes(chat)) this.schedule(chatId, this.quietMs);
  }

  /** A turn is starting in `chatId`: the chat isn't quiet any more. */
  noteTurnStarted(chatId: string): void {
    this.cancel(chatId);
  }

  cancel(chatId: string): void {
    const handle = this.timers.get(chatId);
    if (handle === undefined) return;
    this.scheduler.clearTimeout(handle);
    this.timers.delete(chatId);
  }

  /** Startup: every contributing chat with a reply not yet folded in is queued if it's quiet, else timed for the rest of its quiet period. */
  sweep(): void {
    if (this.disposed) return;
    const now = this.now();
    for (const chat of this.store.chats.list()) {
      try {
        if (!this.contributes(chat)) continue;
        // Up to date (the usual case, and every chat right after migration 019): skip it without reading its messages.
        const cursor = chat.globalMemoryCursor ?? null;
        if (cursor !== null && cursor === this.store.messages.latestId(chat.id)) continue;
        const replies = this.pending(chat).filter((m) => m.role === 'assistant');
        if (replies.length === 0) continue;
        const wait = this.quietMs - (now - Math.max(...replies.map((m) => m.createdAt)));
        if (wait <= 0) void this.enqueue(chat.id);
        else this.schedule(chat.id, wait);
      } catch (err) {
        console.warn(`[otherbench-server] global memory sweep skipped chat ${chat.id}:`, err);
      }
    }
  }

  /** The last failed update, or null once one has succeeded since. */
  lastError(): MemoryFailure | null {
    return this.failure;
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  dispose(): void {
    this.disposed = true;
    for (const handle of this.timers.values()) this.scheduler.clearTimeout(handle);
    this.timers.clear();
    for (const stop of [...this.running]) stop();
  }

  /** Only the machine a chat runs on summarises it, as for project memory. */
  private contributes(chat: Chat): boolean {
    return !chat.memoryExcluded && chat.runsOn === this.store.nodes.self().id;
  }

  private pending(chat: Chat): CanonMessage[] {
    return pendingMemoryMessages(collectMessageTree(this.store, chat.id), chat.headMessageId, chat.globalMemoryCursor ?? null);
  }

  private schedule(chatId: string, ms: number): void {
    if (this.disposed) return;
    this.cancel(chatId);
    const handle = this.scheduler.setTimeout(() => {
      this.timers.delete(chatId);
      const chat = this.store.chats.get(chatId);
      if (chat && this.contributes(chat)) void this.enqueue(chatId);
    }, ms);
    this.timers.set(chatId, handle);
  }

  private enqueue(chatId: string): Promise<GlobalMemoryUpdateOutcome> {
    if (this.disposed) return Promise.resolve(discarded('The memory service was shut down.'));
    const waiting = this.waiting.get(chatId);
    if (waiting) return waiting;
    const run = this.queue.add(() => {
      this.waiting.delete(chatId);
      return this.runUpdate(chatId);
    });
    this.waiting.set(chatId, run);
    return run;
  }

  /** Never rejects: an unexpected throw is recorded like any other failure. */
  private async runUpdate(chatId: string): Promise<GlobalMemoryUpdateOutcome> {
    if (this.disposed) return discarded('The memory service was shut down.');
    try {
      return await this.update(chatId);
    } catch (err) {
      return this.fail(chatId, `Global memory update failed: ${errorMessage(err)}`);
    }
  }

  private async update(chatId: string): Promise<GlobalMemoryUpdateOutcome> {
    const start = this.check(chatId);
    if ('outcome' in start) return start.outcome;
    const pending = this.pending(start.chat);
    if (!pending.some((m) => m.role === 'assistant')) return { status: 'nothing-new' };

    const before = this.store.globalMemory.get();
    const currentBody = before.note || emptyGlobalMemoryBody();
    const chosen = this.store.settings.get().memoryProfileId;
    const profile = await pickMemoryProfile(this.store, this.resolveProfile, [chosen, appDefaultProfileId(this.store)], chosen);
    if (!profile) return this.fail(chatId, NO_GLOBAL_MEMORY_MODEL_MESSAGE);

    const answer = await askMemoryModel(
      { engine: this.engine, scheduler: this.scheduler, now: this.now, timeoutMs: this.timeoutMs, running: this.running, store: this.store },
      profile,
      chatId,
      pending.findLast((m) => m.role === 'assistant')!.id,
      globalMemoryUpdatePrompt(currentBody, renderMemoryTranscript(pending))
    );
    if (!answer.ok) return this.fail(chatId, `Global memory update failed: ${answer.error}`);
    const checked = finaliseGlobalSummary(currentBody, answer.text);
    if (!checked.ok) return this.fail(chatId, `The memory model (${profile.name}) wrote a global note that was rejected: ${checked.reason}`);

    // Anything may have changed while the model was answering.
    const end = this.check(chatId);
    if ('outcome' in end) return end.outcome;
    if (!sameNote(before, this.store.globalMemory.get())) return discarded('The note was edited while the update ran.');

    const newest = pending[pending.length - 1]!;
    this.failure = null;
    if (checked.body === normaliseGlobalMemoryBody(currentBody)) {
      this.store.chats.update(chatId, { globalMemoryCursor: newest.id });
      return { status: 'unchanged' };
    }
    const memory = this.store.globalMemory.saveNote(checked.body, 'summariser', chatId, this.now());
    this.store.chats.update(chatId, { globalMemoryCursor: newest.id });
    return { status: 'updated', memory };
  }

  private check(chatId: string): { chat: Chat } | { outcome: GlobalMemoryUpdateOutcome } {
    const chat = this.store.chats.get(chatId);
    if (!chat) return { outcome: discarded('The chat was deleted.') };
    if (chat.memoryExcluded) return { outcome: discarded('This chat is set to not add to memory.') };
    return { chat };
  }

  private fail(chatId: string, message: string): GlobalMemoryUpdateOutcome {
    this.failure = { message, at: this.now(), chatId };
    console.warn(`[otherbench-server] global memory update (chat ${chatId}) failed: ${message}`);
    return { status: 'failed', error: message };
  }
}
