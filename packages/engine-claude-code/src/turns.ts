import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CommandRow } from '@otherbench/core/domain/context-lines.js';
import type { EngineBackgroundEvent, EngineEvent, EngineRequest, SelfStart } from '@otherbench/core/ports/chat-engine.js';
import { MAIN_ACCOUNT_SLUG, type ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import { BackgroundTasks } from './background.js';
import type { ClaudeCodeEngineDeps } from './deps.js';
import { autoModeUnavailable, classifyClaudeCodeFailure, isMissingSessionError } from './errors.js';
import type { HelperRegistry } from './helpers.js';
import { NOTE_PICKED, SELF_TURN_PREFIX, type LivePool, type LiveProcess, type NotePickedMessage } from './live.js';
import { prepareReply, replyMapper } from './reply-binding.js';
import { cancelNotes, stopTurn } from './turn-stop.js';
import type { SessionPlan } from './session.js';
import type { ApprovalTickets } from './tickets.js';
import { userMessage, type ContentBlock } from './user-content.js';

/** How long a stopped reply's turn may take to end after Claude Code is interrupted before its process is closed. */
export const INTERRUPT_GRACE_MS = 5_000;

/** A notice waiting for a safe moment to be yielded (see ClaudeCodeChatEngine.stream). */
export type PendingNotice = { text: string | null };

/** The note Claude Code started reading, when `message` is the pump's NOTE_PICKED (live.ts); else null. */
function pickedNote(message: SDKMessage): string | null {
  const m = message as unknown as Partial<NotePickedMessage>;
  return m.type === NOTE_PICKED && typeof m.noteId === 'string' ? m.noteId : null;
}

/**
 * Whether a message read while no reply is attached begins a turn of the
 * main agent: Claude Code carrying on by itself. A helper's own messages
 * (with a parent tool call) and system messages don't.
 */
function startsOwnTurn(message: SDKMessage): boolean {
  const m = message as unknown as { type?: unknown; parent_tool_use_id?: unknown };
  return (m.type === 'stream_event' || m.type === 'assistant') && m.parent_tool_use_id === null;
}

/** What a reply that sent /compact has seen of it: the PostCompact hook's summary and the boundary's token counts. */
export type Compaction = { summary: string | null; preTokens?: number; postTokens?: number | null; failure?: string };

const AUTO_COMPACTED = 'Claude Code compacted the context automatically.';

/** A reply's meta names the Claude account it ran on, only when that isn't main. */
function accountMeta(account: ClaudeAccountRef | undefined): { account?: string } {
  return account && account.slug !== MAIN_ACCOUNT_SLUG ? { account: account.slug } : {};
}

/** The account a request runs on: none for an endpoint backend, which uses no Claude login. */
export function loginAccount(req: EngineRequest): ClaudeAccountRef | undefined {
  return req.profile.connection.baseUrl ? undefined : req.claudeAccount;
}

/**
 * Reads a reply's turn from its live process: a user's reply, a self-started
 * one, and a turn nobody shows. Shares the engine's pool, processes and
 * running replies; where work between replies is reported is set here.
 */
export class ReplyTurns {
  /** Where work Claude Code does between replies is reported (spec 2026-10-17-claude-background-helpers-design). */
  backgroundHandler: ((event: EngineBackgroundEvent) => void) | null = null;

  constructor(
    private readonly deps: ClaudeCodeEngineDeps,
    private readonly pool: LivePool,
    private readonly processes: Set<LiveProcess>,
    private readonly running: Map<string, { live: LiveProcess; req: EngineRequest }>,
    private readonly scratchFolder: (chatId: string) => string,
    private readonly rememberCommands: (chatId: string, live: LiveProcess) => Promise<CommandRow[] | null>
  ) {}

  /**
   * What Claude Code does while no reply is attached to the process. A turn
   * running notes Claude Code started is theirs (a follow-on, see
   * LiveProcess.takeStarting); any other is one it began by itself.
   */
  private handleIdle(live: LiveProcess, message: SDKMessage): void {
    if (!startsOwnTurn(message)) return;
    const notes = live.takeStarting(message);
    this.selfStart(live, message, notes.length > 0 ? notes : undefined);
  }

  /** Tells the server which notes a process never ran (it closed, or their turn ended at once), for its chat. Never throws: the process calls it unguarded. */
  private reportDropped(live: LiveProcess, dropped: string[]): void {
    try {
      const chatId = live.background?.chatId ?? live.last?.chatId;
      if (dropped.length === 0 || chatId === undefined) return;
      this.backgroundHandler?.({ type: 'notes-dropped', chatId, noteIds: dropped });
    } catch (err) {
      console.error('[engine-claude-code] could not report the notes a closed process never read:', err);
    }
  }

  /**
   * Claude Code began a turn by itself (a helper reported back), or ran notes
   * `noteIds` the user sent mid-reply after that reply ended (a follow-on): it's
   * handed to whoever runs replies as a self-start, its output buffered until
   * then. With nobody to run it, it's read to its end and dropped.
   */
  private selfStart(live: LiveProcess, first: SDKMessage, noteIds?: string[]): void {
    // A follow-on's result names its notes, so it's attached under the first; any other names no message of ours.
    const placeholder = noteIds?.[0] ?? `${SELF_TURN_PREFIX}${randomUUID()}`;
    const feed = live.attach(placeholder);
    feed.push(first);
    // Helper cards it starts belong to its reply, whose id comes when it runs.
    if (live.background) {
      live.background.current = placeholder;
      live.background.handle(first);
    }
    const iterator = feed[Symbol.asyncIterator]();
    let taken = false;
    // Nobody shows this turn: it's read to its end, and a note picked in it reported dropped.
    const drain = (): Promise<boolean> => this.readUnshown(live, iterator);
    const last = live.last;
    if (!last || !this.backgroundHandler) {
      void drain();
      return;
    }
    const start: SelfStart = {
      chatId: last.chatId,
      afterMessageId: last.messageId,
      profileId: last.profileId,
      // The user asked for a follow-on: it's attended, and needs no notice.
      ...(noteIds
        ? { notice: '', unattended: false, noteIds }
        : { notice: this.selfStartNotice(live), unattended: last.unattended, ...(last.unattended && last.autoMode ? { unattendedAuto: true } : {}) }),
      run: (req) => {
        if (taken) throw new Error('A self-started turn runs once.');
        taken = true;
        live.background?.renameCurrent(placeholder, req.messageId);
        return this.runSelfStarted(live, req, iterator);
      },
      decline: () => {
        if (taken) return;
        taken = true;
        void drain();
      },
    };
    this.backgroundHandler({ type: 'self-start', start });
  }

  /** Why Claude Code carried on by itself: the helper or task that last finished, named once. */
  private selfStartNotice(live: LiveProcess): string {
    const finished = live.background?.lastFinished ?? null;
    // Named once: a later turn it starts with no helper finished since is not this helper's.
    if (live.background) live.background.lastFinished = null;
    return finished === null
      ? 'Carried on after a background task finished.'
      : finished.kind === 'local_agent'
        ? `Carried on after the helper "${finished.label}" reported back.`
        : `Carried on after the background task "${finished.label}" finished.`;
  }

  /** A self-started turn, for the reply `req` describes: gated and mapped like a user's reply, from the output already buffered. */
  private async *runSelfStarted(live: LiveProcess, req: EngineRequest, feed: AsyncIterator<SDKMessage>): AsyncGenerator<EngineEvent> {
    // The process's own backend and account: the chat may have moved to another account since it started.
    const { backend, account } = live;
    const clean = !req.workspaceRoot;
    const cwd = req.workspaceRoot ?? this.scratchFolder(req.chatId);
    // This process is already running the turn, and until `live.binding` is set its hooks refuse the
    // turn's calls ("No OtherBench reply is waiting"). So prepareReply's awaits (relayTools, and the media tools'
    // `limitsFor` under it) must stay store reads that settle at once: no network or disk I/O before the
    // binding is set. The binding is built by prepareReply itself, so it can't be set any sooner.
    const prepared = await prepareReply(this.deps, req, backend, account, clean);
    prepared.proc.live = live;
    live.binding = prepared.binding;
    live.last = { chatId: req.chatId, messageId: req.messageId, profileId: req.profile.id, policy: req.profile.toolPolicy, ctx: prepared.gateCtx, autoMode: prepared.autoMode, unattended: req.unattended === true };
    const mapper = replyMapper(live, req, prepared.helpers, prepared.binding.results);
    this.running.set(req.messageId, { live, req });
    let stopped!: () => void;
    const stoppedNow = new Promise<{ stopped: true }>((resolve) => (stopped = () => resolve({ stopped: true })));
    const onAbort = (): void => {
      stopTurn(live, req.messageId);
      stopped();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort();
    let pending: Promise<IteratorResult<SDKMessage>> | null = null;
    let ended = false;
    // The turn ended in its own successful result: notes still queued then run as a follow-on.
    let finished = false;
    // A rejected rate limit seen in the turn: its failure says when the limit resets.
    let rateLimitResetsAt: number | null = null;
    // A usage limit was reported in the turn (a rejected rate-limit event, or Claude Code's own limit message), reset time known or not.
    let rateLimited = false;
    try {
      yield { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: live.sessionId ?? '', backend, ...accountMeta(account), cwd, tools: [], mcpServers: [] } };
      for (;;) {
        pending ??= feed.next();
        const next = await Promise.race([pending, stoppedNow]);
        if ('stopped' in next) {
          yield* mapper.backgroundOpen() as EngineEvent[];
          break;
        }
        pending = null;
        if (next.done) {
          // The process ended (closed, or died) before the turn's result: the reply didn't finish.
          if (!req.signal.aborted) {
            const text = [live.failure instanceof Error ? live.failure.message : 'Claude Code ended before it finished this reply.', ...live.stderr].join('\n');
            yield { type: 'error', error: classifyClaudeCodeFailure(text, { backend, modelId: req.profile.modelId, rateLimitResetsAt, rateLimited }) };
          }
          break;
        }
        const picked = pickedNote(next.value);
        if (picked !== null) {
          yield { type: 'note-picked', noteId: picked };
          continue;
        }
        if ((next.value as { type?: unknown }).type === 'result') ended = true;
        for (const event of mapper.map(next.value)) {
          if (event.type === 'init') continue;
          if (event.type === 'rate-limited') {
            rateLimitResetsAt = event.resetsAt;
            rateLimited = true;
            continue;
          }
          if (event.type === 'command-error') continue;
          if (event.type === 'compacted') {
            if (event.trigger === 'auto') yield { type: 'notice', text: AUTO_COMPACTED };
            continue;
          }
          if (event.type === 'result-error') {
            if (!req.signal.aborted) yield { type: 'error', error: classifyClaudeCodeFailure(event.text, { backend, modelId: req.profile.modelId, rateLimitResetsAt, rateLimited }) };
            continue;
          }
          if (event.type === 'finish') finished = true;
          yield event;
        }
        if (ended) break;
      }
    } finally {
      this.running.delete(req.messageId);
      prepared.tickets.clear();
      prepared.binding.results.clear();
      req.signal.removeEventListener('abort', onAbort);
      live.binding = null;
      // It stayed pooled, so no release marks it as used just now.
      live.lastUsed = Date.now();
      if (!finished && !live.isClosed) cancelNotes(live, req.messageId);
      // Stopped mid-turn: read the rest in the background (the process stays pooled, as it already is).
      if (req.signal.aborted && !ended && !live.isClosed) void this.finishSelfStopped(live, feed, pending);
    }
  }

  /** After a self-started reply is stopped: reads its turn to the end; one that doesn't end in time closes the process. */
  private async finishSelfStopped(live: LiveProcess, feed: AsyncIterator<SDKMessage>, pending: Promise<IteratorResult<SDKMessage>> | null): Promise<void> {
    const timer = setTimeout(() => live.close(), INTERRUPT_GRACE_MS);
    timer.unref?.();
    try {
      await this.readUnshown(live, feed, pending);
    } catch {
      live.close();
    } finally {
      clearTimeout(timer);
    }
  }

  /** A user's reply on `live`: sends its message and reads its turn (see runTurn). */
  async *runReplyTurn(
    req: EngineRequest,
    plan: SessionPlan,
    backend: string,
    notice: PendingNotice,
    cwd: string,
    live: LiveProcess,
    reused: boolean,
    content: ContentBlock[],
    autoMode: boolean,
    helpers: HelperRegistry,
    tickets: ApprovalTickets,
    results: Map<string, unknown>,
    compaction: Compaction | null
  ): AsyncGenerator<EngineEvent, 'done' | 'missing-session'> {
    const flushNotice = function* (): Generator<EngineEvent> {
      const text = notice.text;
      if (text === null) return;
      notice.text = null;
      yield { type: 'notice', text };
    };
    const profile = req.profile;
    // The process's background tasks, for this chat; this reply's own helper cards are left to its mapper.
    live.background ??= new BackgroundTasks(req.chatId, (event) => this.backgroundHandler?.(event));
    live.background.current = req.messageId;
    live.onIdle = (message) => this.handleIdle(live, message);
    live.onClosed = (dropped) => this.reportDropped(live, dropped);
    live.onDropped = (dropped) => this.reportDropped(live, dropped);
    // This reply's turn, up to its own result: attached before the message
    // goes, so nothing of it is missed and nothing else reaches it.
    const uuid = randomUUID();
    const feed = live.attach(uuid)[Symbol.asyncIterator]();

    // Stopping a reply interrupts Claude Code's turn and keeps the process, so
    // its background helpers carry on and the next message continues the
    // session. The reply ends at once; the turn is read to its end in the
    // background (finishStopped), and one that doesn't end in time closes the process.
    let stopped!: () => void;
    const stoppedNow = new Promise<{ stopped: true }>((resolve) => (stopped = () => resolve({ stopped: true })));
    const onAbort = (): void => {
      stopTurn(live, req.messageId);
      stopped();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    live.input.push(userMessage(content, uuid));
    this.running.set(req.messageId, { live, req });

    const mapper = replyMapper(live, req, helpers, results);
    let sawInit = false;
    let finished = false;
    // The turn's own result arrived (a success or not): the process is in a known state.
    let ended = false;
    let rateLimitResetsAt: number | null = null;
    // A usage limit was reported in the turn (a rejected rate-limit event, or Claude Code's own limit message), reset time known or not.
    let rateLimited = false;
    let pending: Promise<IteratorResult<SDKMessage>> | null = null;
    try {
      while (!finished) {
        pending ??= feed.next();
        const next = await Promise.race([pending, stoppedNow]);
        if ('stopped' in next) {
          // Its helpers working in the background carry on: their cards say so rather than stopped.
          yield* mapper.backgroundOpen() as EngineEvent[];
          break;
        }
        pending = null;
        if (next.done) {
          // The output ended (the process died) unless this turn's result was the last thing.
          if (live.failure !== null && !ended) throw live.failure;
          break;
        }
        const picked = pickedNote(next.value);
        if (picked !== null) {
          yield { type: 'note-picked', noteId: picked };
          continue;
        }
        if ((next.value as { type?: unknown }).type === 'result') ended = true;
        for (const event of mapper.map(next.value)) {
          if (event.type === 'init') {
            live.sessionId = event.sessionId;
            // Claude Code repeats its init mid-turn after compacting, on the same session: only the
            // turn's first starts it. A later one can say another mode (Auto switched off since),
            // which isn't auto mode being unavailable.
            if (sawInit) continue;
            sawInit = true;
            if (autoMode && event.permissionMode !== 'auto') {
              // Claude Code started in another mode: auto mode isn't available
              // for this account or model. Stop before the model does any work,
              // and persist no session meta for this half-started session.
              live.close();
              yield* flushNotice();
              yield { type: 'error', error: autoModeUnavailable() };
              return 'done';
            }
            yield { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: event.sessionId, backend, ...accountMeta(loginAccount(req)), cwd, tools: event.tools, mcpServers: event.mcpServers } };
            yield* flushNotice();
          } else if (event.type === 'rate-limited') {
            rateLimitResetsAt = event.resetsAt;
            rateLimited = true;
          } else if (event.type === 'compacted') {
            if (event.trigger === 'auto') yield { type: 'notice', text: AUTO_COMPACTED };
            else if (compaction) Object.assign(compaction, { preTokens: event.preTokens, postTokens: event.postTokens });
          } else if (event.type === 'command-error') {
            // Why a /compact failed, in Claude Code's words; another command's is left out, as before.
            if (compaction) compaction.failure = event.text;
          } else if (event.type === 'result-error') {
            // A stopped reply's interrupted turn: its process carries on for the next message.
            if (req.signal.aborted) return 'done';
            live.close();
            if (!sawInit && !reused && plan.mode !== 'fresh' && isMissingSessionError(event.text)) return 'missing-session';
            yield* flushNotice();
            yield { type: 'error', error: classifyClaudeCodeFailure(event.text, { backend, modelId: profile.modelId, rateLimitResetsAt, rateLimited, autoMode }) };
            return 'done';
          } else {
            if (event.type === 'finish') {
              finished = true;
              if (compaction) {
                // The turn ended without the hook's summary: there is nothing to cut the chat at, so the
                // reply fails, with Claude Code's own reason when it gave one.
                if (compaction.summary === null) {
                  yield { type: 'error', error: { kind: 'unknown', retryable: false, message: compaction.failure ?? 'Claude Code finished without compacting.' } };
                  continue;
                }
                yield {
                  type: 'context-summary',
                  text: compaction.summary,
                  ...(compaction.preTokens !== undefined ? { preTokens: compaction.preTokens } : {}),
                  ...(typeof compaction.postTokens === 'number' ? { postTokens: compaction.postTokens } : {}),
                };
              }
            }
            yield event;
          }
        }
      }
      if (!finished) yield* flushNotice(); // a stream that ended without a result
    } catch (err) {
      live.close();
      if (req.signal.aborted) return 'done'; // TurnRunner marks the message cancelled
      const text = [err instanceof Error ? err.message : String(err), ...live.stderr].join('\n');
      if (!sawInit && !reused && plan.mode !== 'fresh' && isMissingSessionError(text)) return 'missing-session';
      yield* flushNotice();
      yield { type: 'error', error: classifyClaudeCodeFailure(text, { backend, modelId: profile.modelId, rateLimitResetsAt, rateLimited, autoMode }) };
    } finally {
      this.running.delete(req.messageId);
      tickets.clear();
      results.clear();
      req.signal.removeEventListener('abort', onAbort);
      if (req.signal.aborted && !ended && !live.isClosed) {
        // Stopped mid-turn: the process goes back to the pool at once, so the
        // session's next message waits for this turn to end in it (its feed is
        // still attached) rather than starting a second process on the
        // session. The turn is read to its end in the background.
        this.pool.release(live);
        void this.finishStopped(live, feed, pending);
      } else if (ended && !live.isClosed && (finished || req.signal.aborted)) {
        // A turn that reached its own result leaves its process waiting for the next message.
        this.pool.release(live);
        void this.rememberCommands(req.chatId, live);
      } else {
        live.close();
      }
      // A reply that didn't finish cleanly leaves no note to run after it (a closed process takes them with it).
      if (!finished && !live.isClosed) cancelNotes(live, req.messageId);
      if (live.isClosed) this.processes.delete(live);
    }
    return 'done';
  }

  /**
   * Reads the rest of a turn nobody shows (a declined self-start, a stopped
   * reply's): a note picked in it is reported dropped, since no reply will
   * fold it. True when the turn's result came.
   */
  private async readUnshown(live: LiveProcess, feed: AsyncIterator<SDKMessage>, pending: Promise<IteratorResult<SDKMessage>> | null = null): Promise<boolean> {
    let ended = false;
    for (let next = await (pending ?? feed.next()); !next.done; next = await feed.next()) {
      const picked = pickedNote(next.value);
      if (picked !== null) this.reportDropped(live, [picked]);
      else if ((next.value as { type?: unknown }).type === 'result') ended = true;
    }
    return ended;
  }

  /**
   * After a stop: reads the interrupted turn to its result (the process is
   * already pooled). One whose turn hasn't ended within INTERRUPT_GRACE_MS is
   * closed.
   */
  private async finishStopped(live: LiveProcess, feed: AsyncIterator<SDKMessage>, pending: Promise<IteratorResult<SDKMessage>> | null): Promise<void> {
    const timer = setTimeout(() => live.close(), INTERRUPT_GRACE_MS);
    timer.unref?.();
    let ended = false;
    try {
      ended = await this.readUnshown(live, feed, pending);
    } catch {
      ended = false;
    } finally {
      clearTimeout(timer);
      if (!ended) live.close();
      if (live.isClosed) this.processes.delete(live);
    }
  }
}
