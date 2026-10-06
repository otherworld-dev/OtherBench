import { randomUUID } from 'node:crypto';
import {
  MEMORY_QUIET_MS,
  NO_MEMORY_MODEL_MESSAGE,
  emptyMemoryBody,
  finaliseSummary,
  memoryUpdatePrompt,
  normaliseMemoryBody,
  pendingMemoryMessages,
  renderMemoryTranscript,
  type MemoryFailure,
  type MemoryUpdateOutcome,
} from '@grunt/core/domain/memory.js';
import type { TurnEvent } from '@grunt/core/domain/turn.js';
import type { ChatEngine, EngineEvent } from '@grunt/core/ports/chat-engine.js';
import type { Chat, Project, ProjectMemory, Store } from '@grunt/core/ports/store.js';
import type { ResolvedProfile } from '@grunt/core/types/config.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { appDefaultProfileId } from '../profile-resolution.js';
import { collectMessageTree } from '../routes/chats.js';
import { realScheduler, type Scheduler } from './scheduler.js';

/** How long one summariser call may take before it is abandoned. */
export const MEMORY_UPDATE_TIMEOUT_MS = 120_000;

export interface ProjectMemoryServiceDeps {
  store: Store;
  engine: ChatEngine;
  /** Resolves a profile id to what the engine needs; rejects when it can't (a missing connection, say). */
  resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  now?: () => number;
  scheduler?: Scheduler;
  quietMs?: number;
  timeoutMs?: number;
}

/** Finish reasons (AI SDK and Anthropic spellings) that mean the answer is incomplete or withheld. */
const TRUNCATING_FINISH_REASONS: ReadonlySet<string> = new Set(['length', 'max_tokens', 'model_context_window_exceeded', 'content-filter', 'refusal', 'error']);

const discarded = (reason: string): MemoryUpdateOutcome => ({ status: 'discarded', reason });

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when nobody saved the note between `before` and `after`. */
function sameNote(before: ProjectMemory | null, after: ProjectMemory | null): boolean {
  if (before === null || after === null) return before === after;
  return before.body === after.body && before.updatedAt === after.updatedAt && before.updatedBy === after.updatedBy;
}

/**
 * Keeps each project's memory note current (spec
 * docs/superpowers/specs/2026-10-03-project-memory-design.md §2, §6).
 *
 * A completed reply in a project chat (re)starts that chat's quiet timer; a
 * new turn cancels it. When it fires, the chat's completed active-path
 * messages after its cursor are folded into the note by one `purpose:
 * 'utility'` call. Updates run one at a time across all projects (so a
 * slow or metered memory model is never hit in parallel), each reading the
 * note fresh, so a queued update sees the previous one's result. A failure
 * changes nothing and is kept as the project's `lastError` until the next
 * success. Timers, failures and queues live in this process only; `sweep()`
 * rebuilds the timers on startup.
 */
export class ProjectMemoryService {
  private readonly store: Store;
  private readonly engine: ChatEngine;
  private readonly resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly quietMs: number;
  private readonly timeoutMs: number;
  /** chatId -> pending quiet timer. */
  private readonly timers = new Map<string, unknown>();
  /** The tail of the one update queue: at most one summariser call runs at a time across all projects, so a project's updates stay in order. */
  private tail: Promise<void> = Promise.resolve();
  /** Updates queued or running. */
  private outstanding = 0;
  /** projectId -> its last failed update, until the next success. */
  private readonly failures = new Map<string, MemoryFailure>();
  /** projectId + chatId -> an update that is queued but hasn't started; a repeat request joins it. */
  private readonly waiting = new Map<string, Promise<MemoryUpdateOutcome>>();
  /** Stops for the calls in flight, so dispose() can abort them. */
  private readonly running = new Set<() => void>();
  private disposed = false;

  constructor(deps: ProjectMemoryServiceDeps) {
    this.store = deps.store;
    this.engine = deps.engine;
    this.resolveProfile = deps.resolveProfile;
    this.now = deps.now ?? Date.now;
    this.scheduler = deps.scheduler ?? realScheduler;
    this.quietMs = deps.quietMs ?? MEMORY_QUIET_MS;
    this.timeoutMs = deps.timeoutMs ?? MEMORY_UPDATE_TIMEOUT_MS;
  }

  /** Starts the quiet timer whenever an assistant reply completes. Call once per runner. */
  attach(turnRunner: { on(cb: (e: TurnEvent) => void): () => void }): () => void {
    return turnRunner.on((event) => {
      // An errored or cancelled reply re-arms the timer too: its chat has gone quiet, and an update with no new completed reply returns before any model call.
      if (event.type !== 'status' || !(event.status === 'complete' || event.status === 'error' || event.status === 'cancelled')) return;
      const message = this.store.messages.get(event.messageId);
      if (message?.role === 'assistant') this.noteTurnCompleted(message.chatId);
    });
  }

  /** A reply completed in `chatId`: (re)start its quiet timer if the chat contributes to a project's memory. */
  noteTurnCompleted(chatId: string): void {
    const chat = this.store.chats.get(chatId);
    if (chat && this.contributes(chat)) this.schedule(chatId, this.quietMs);
  }

  /** A turn is starting in `chatId`: the chat isn't quiet any more. */
  noteTurnStarted(chatId: string): void {
    this.cancel(chatId);
  }

  /** Drops `chatId`'s pending quiet timer, if any. */
  cancel(chatId: string): void {
    const handle = this.timers.get(chatId);
    if (handle === undefined) return;
    this.scheduler.clearTimeout(handle);
    this.timers.delete(chatId);
  }

  /** "Update now": queues an update for `chatId` straight away, ignoring its timer. The route checks project membership and exclusion first. */
  updateNow(chatId: string): Promise<MemoryUpdateOutcome> {
    this.cancel(chatId);
    const chat = this.store.chats.get(chatId);
    if (!chat) return Promise.resolve(discarded('The chat was deleted.'));
    if (chat.projectId === null) return Promise.resolve(discarded("This chat isn't in a project."));
    return this.enqueue(chat.projectId, chatId);
  }

  /**
   * Startup: every contributing chat with a completed reply not yet folded
   * in is queued now if that reply is at least the quiet period old, or
   * timed for the rest of its quiet period otherwise.
   */
  sweep(): void {
    if (this.disposed) return;
    const now = this.now();
    for (const chat of this.store.chats.list()) {
      try {
        if (!this.contributes(chat) || chat.projectId === null) continue;
        const replies = this.pending(chat).filter((m) => m.role === 'assistant');
        if (replies.length === 0) continue;
        const newest = Math.max(...replies.map((m) => m.createdAt));
        const wait = this.quietMs - (now - newest);
        if (wait <= 0) void this.enqueue(chat.projectId, chat.id);
        else this.schedule(chat.id, wait);
      } catch (err) {
        console.warn(`[grunt-server] project memory sweep skipped chat ${chat.id}:`, err);
      }
    }
  }

  /** The project's last failed update, or null once one has succeeded since. */
  lastError(projectId: string): MemoryFailure | null {
    return this.failures.get(projectId) ?? null;
  }

  /** Resolves once every queued update has finished. */
  async idle(): Promise<void> {
    while (this.outstanding > 0) {
      await this.tail;
      await Promise.resolve();
    }
  }

  /** Drops every pending timer, aborts calls in flight and refuses new work. */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.timers.values()) this.scheduler.clearTimeout(handle);
    this.timers.clear();
    for (const stop of [...this.running]) stop();
  }

  /**
   * Only the machine a chat runs on summarises it into project memory: with
   * paired machines, two summarisers working through the same chats would
   * do the work twice and overwrite each other's notes.
   */
  private contributes(chat: Chat): boolean {
    return (
      chat.projectId !== null &&
      !chat.memoryExcluded &&
      chat.runsOn === this.store.nodes.self().id &&
      this.store.projects.get(chat.projectId) !== null
    );
  }

  private pending(chat: Chat): CanonMessage[] {
    return pendingMemoryMessages(collectMessageTree(this.store, chat.id), chat.headMessageId, chat.memoryCursor);
  }

  private schedule(chatId: string, ms: number): void {
    if (this.disposed) return;
    this.cancel(chatId);
    const handle = this.scheduler.setTimeout(() => {
      this.timers.delete(chatId);
      const chat = this.store.chats.get(chatId);
      if (chat && this.contributes(chat) && chat.projectId !== null) void this.enqueue(chat.projectId, chatId);
    }, ms);
    this.timers.set(chatId, handle);
  }

  private enqueue(projectId: string, chatId: string): Promise<MemoryUpdateOutcome> {
    if (this.disposed) return Promise.resolve(discarded('The memory service was shut down.'));
    const key = `${projectId}\u0000${chatId}`;
    const waiting = this.waiting.get(key);
    if (waiting) return waiting;
    this.outstanding += 1;
    const run = this.tail.then(() => {
      this.waiting.delete(key);
      return this.runUpdate(projectId, chatId);
    });
    this.waiting.set(key, run);
    this.tail = run.then(() => {
      this.outstanding -= 1;
    });
    return run;
  }

  /** Never rejects: an unexpected throw is recorded like any other failure. */
  private async runUpdate(projectId: string, chatId: string): Promise<MemoryUpdateOutcome> {
    if (this.disposed) return discarded('The memory service was shut down.');
    try {
      return await this.update(projectId, chatId);
    } catch (err) {
      return this.fail(projectId, chatId, `Memory update failed: ${errorMessage(err)}`);
    }
  }

  private async update(projectId: string, chatId: string): Promise<MemoryUpdateOutcome> {
    const start = this.check(projectId, chatId);
    if ('outcome' in start) return start.outcome;
    const pending = this.pending(start.chat);
    if (!pending.some((m) => m.role === 'assistant')) return { status: 'nothing-new' };

    const before = this.store.projectMemory.get(projectId);
    const currentBody = before?.body ?? emptyMemoryBody();
    const profile = await this.pickProfile(start.project);
    if (!profile) return this.fail(projectId, chatId, NO_MEMORY_MODEL_MESSAGE);

    const answer = await this.ask(profile, chatId, memoryUpdatePrompt(start.project.name, currentBody, renderMemoryTranscript(pending)));
    if (!answer.ok) return this.fail(projectId, chatId, `Memory update failed: ${answer.error}`);
    const checked = finaliseSummary(currentBody, answer.text);
    if (!checked.ok) return this.fail(projectId, chatId, `The memory model (${profile.name}) wrote a note that was rejected: ${checked.reason}`);

    // Anything may have changed while the model was answering (spec §6).
    const end = this.check(projectId, chatId);
    if ('outcome' in end) return end.outcome;
    if (!sameNote(before, this.store.projectMemory.get(projectId))) return discarded('The note was edited while the update ran.');

    const newest = pending[pending.length - 1]!;
    this.failures.delete(projectId);
    if (checked.body === normaliseMemoryBody(currentBody)) {
      this.store.chats.update(chatId, { memoryCursor: newest.id });
      return { status: 'unchanged' };
    }
    const memory = this.store.projectMemory.save(projectId, checked.body, 'summariser', chatId, this.now());
    this.store.chats.update(chatId, { memoryCursor: newest.id });
    return { status: 'updated', memory };
  }

  /** The chat and project when an update for them may proceed, or why it may not. */
  private check(projectId: string, chatId: string): { chat: Chat; project: Project } | { outcome: MemoryUpdateOutcome } {
    const chat = this.store.chats.get(chatId);
    if (!chat) return { outcome: discarded('The chat was deleted.') };
    const project = this.store.projects.get(projectId);
    if (!project) return { outcome: discarded('The project was deleted.') };
    if (chat.projectId !== projectId) return { outcome: discarded('The chat moved to another project.') };
    if (chat.memoryExcluded) return { outcome: discarded('This chat is set to not add to project memory.') };
    return { chat, project };
  }

  /** Spec §2: the Memory model setting, then the project's default, then the app default -- the first that exists, isn't archived and resolves. */
  private async pickProfile(project: Project): Promise<ResolvedProfile | null> {
    const chosen = this.store.settings.get().memoryProfileId;
    const candidates = [chosen, project.defaultProfileId, appDefaultProfileId(this.store)];
    for (const id of new Set(candidates)) {
      if (id === null) continue;
      const row = this.store.profiles.get(id);
      if (!row || row.archivedAt !== null) continue;
      try {
        const profile = await this.resolveProfile(id);
        // The mock engine answers everything with the same canned reply, so
        // it can never write a note: only use it when it's the chosen model.
        if (profile.connection.kind === 'mock' && id !== chosen) continue;
        return profile;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * One tool-less utility call, abandoned after `timeoutMs`. The whole
   * instruction is one user message: Claude Code's utility path reads only
   * that. Every wait on the stream races the timeout, so an engine that
   * ignores the abort can't hold the project's queue.
   */
  private async ask(profile: ResolvedProfile, chatId: string, prompt: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const controller = new AbortController();
    let timedOut = false;
    let stopped = false;
    let wake!: () => void;
    const interrupted = new Promise<'interrupted'>((resolve) => (wake = () => resolve('interrupted')));
    const stop = (): void => {
      stopped = true;
      controller.abort();
      wake();
    };
    this.running.add(stop);
    const timer = this.scheduler.setTimeout(() => {
      timedOut = true;
      stop();
    }, this.timeoutMs);
    const timeoutFailure = { ok: false as const, error: `The model didn't answer within ${Math.round(this.timeoutMs / 1000)} s.` };
    let text = '';
    let finished = false;
    let iterator: AsyncIterator<EngineEvent> | undefined;
    try {
      iterator = this.engine
        .stream({
          profile,
          messages: [
            {
              id: `memory-prompt:${randomUUID()}`,
              chatId,
              parentId: null,
              role: 'user',
              parts: [{ type: 'text', text: prompt }],
              status: 'complete',
              error: null,
              producedBy: null,
              createdAt: this.now(),
            },
          ],
          tools: [],
          signal: controller.signal,
          chatId,
          messageId: `memory-update:${randomUUID()}`,
          workspaceRoot: null,
          purpose: 'utility',
        })
        [Symbol.asyncIterator]();
      for (;;) {
        const step = await Promise.race([iterator.next(), interrupted]);
        if (step === 'interrupted' || step.done) break;
        const event = step.value;
        if (event.type === 'text-delta') text += event.text;
        else if (event.type === 'error') return timedOut ? timeoutFailure : { ok: false, error: event.error.message };
        else if (event.type === 'finish') {
          // A cut-off note must never be saved: it can parse as a valid, shorter note.
          if (TRUNCATING_FINISH_REASONS.has(event.finishReason)) {
            return { ok: false, error: `The model's answer was cut off (finish reason "${event.finishReason}").` };
          }
          // The note is complete; a Claude Code stream can stay open after this.
          finished = true;
          break;
        }
      }
    } catch (err) {
      return timedOut ? timeoutFailure : { ok: false, error: errorMessage(err) };
    } finally {
      this.scheduler.clearTimeout(timer);
      this.running.delete(stop);
      // Tear the call down (a Claude Code child, say) whether or not it finished.
      controller.abort();
      try {
        void Promise.resolve(iterator?.return?.()).catch(() => undefined);
      } catch {
        /* the engine's own problem */
      }
    }
    if (finished) return { ok: true, text };
    if (timedOut) return timeoutFailure;
    if (stopped) return { ok: false, error: 'The memory service was shut down.' };
    return { ok: true, text };
  }

  private fail(projectId: string, chatId: string, message: string): MemoryUpdateOutcome {
    this.failures.set(projectId, { message, at: this.now(), chatId });
    console.warn(`[grunt-server] project memory update for project ${projectId} (chat ${chatId}) failed: ${message}`);
    return { status: 'failed', error: message };
  }
}
