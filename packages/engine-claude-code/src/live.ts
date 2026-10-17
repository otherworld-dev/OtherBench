import { createHash } from 'node:crypto';
import type { HookCallback, Options, SDKMessage, SDKUserMessage, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { ToolPolicy } from '@otherbench/core/types/config.js';
import type { Gate } from './approval.js';
import type { BackgroundTasks } from './background.js';
import type { ApprovalTickets } from './tickets.js';

/** How long a Claude Code process with no reply in progress stays alive for the next message. */
export const LIVE_IDLE_MS = 30 * 60_000;

/** At most this many live processes; starting another closes the longest-idle one. Each runs its own MCP servers. */
export const MAX_LIVE = 3;

/** An input stream that stays open: each message pushed is the next user turn of the same process. */
export class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(message: SDKUserMessage): void {
    this.queued.push(message);
    this.wake?.();
  }

  /** Ends the input; the process finishes what it's doing and exits. */
  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.queued.length > 0) yield this.queued.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

/** What a live process reads from: Claude Code's output, and the controls of the query that produces it. */
export type LiveQuery = AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
  stopTask?(taskId: string): Promise<unknown>;
  /** Switches the running Claude Code's permission mode (what VS Code does when its mode changes). */
  setPermissionMode?(mode: PermissionMode): Promise<unknown>;
};

/**
 * One turn's share of a process's output: the messages from when a reply
 * attaches to its own result. Read once.
 */
export class TurnFeed implements AsyncIterable<SDKMessage> {
  private readonly queued: SDKMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(message: SDKMessage): void {
    this.queued.push(message);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    for (;;) {
      while (this.queued.length > 0) yield this.queued.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

/** The prefix of the id a turn Claude Code started by itself is attached under (it answers no message of ours). */
export const SELF_TURN_PREFIX = 'self-';

/**
 * Whether `msg` is the result of the turn that answered the message `uuid`.
 * A result naming no message (an older Claude Code) counts, except one of a
 * turn Claude Code ran by itself (`origin.kind` 'task-notification'), which
 * ends only a self-started turn: a user's reply that caught the start of such
 * a turn carries on to its own result.
 */
function resultFor(msg: SDKMessage, uuid: string): boolean {
  const m = msg as unknown as { type?: unknown; user_message_uuid?: unknown; user_message_uuids?: unknown; origin?: { kind?: unknown } };
  if (m.type !== 'result') return false;
  if (m.origin?.kind === 'task-notification') return uuid.startsWith(SELF_TURN_PREFIX);
  const named = [...(typeof m.user_message_uuid === 'string' ? [m.user_message_uuid] : []), ...(Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [])];
  return named.length === 0 || named.includes(uuid);
}

/** What one reply binds a live process's hooks to while it runs. */
export interface TurnBinding {
  gate: Gate;
  /** Audits auto-mode classifier blocks (only set when the process runs in auto mode). */
  permissionDenied?: HookCallback;
  /** Runs an `artifact` call for this reply (Deck #896); absent when the profile turns artifacts off. */
  artifact?: (args: unknown) => Promise<unknown>;
  /** Runs a `recall` call for this reply (spec 2026-10-09-recall-design); absent when the profile turns recall off. */
  recall?: (args: unknown) => Promise<unknown>;
  /** Runs a propose_plan call for this reply (spec 2026-10-12-thread-cards-design); absent when the reply isn't planning. */
  plan?: (args: unknown) => Promise<unknown>;
  /** Runs a relayed MCP tool's (already approved) call for this reply, with the reply's tool context. */
  relay?: (spec: ToolSpec, args: unknown) => Promise<unknown>;
  /** This reply's approval tickets for relayed calls with `describeCall` (tickets.ts); cleared when the reply ends. */
  tickets?: ApprovalTickets;
  /** Keeps the summary of a /compact this reply sent (the PostCompact hook, manual trigger); absent when the reply isn't one. */
  compacted?: (summary: string) => void;
}

/** Which of OtherBench's own tools a process's server carries; fixed when it starts. */
export interface OtherBenchServerSwitches {
  artifacts: boolean;
  recall: boolean;
  /** propose_plan, for a reply in Plan mode. */
  plan: boolean;
  /** `buildRelay(...).hash` of the relayed MCP tools; '' for none (relay.ts). */
  relay: string;
}

/**
 * One Claude Code process kept alive between replies (spec amendment:
 * live sessions). Its options -- and so its hooks -- are fixed when it
 * starts, so the hooks call through `binding`, which each reply sets for its
 * own approvals context and clears when it ends.
 *
 * Its output is read for its whole life, by one reader (spec
 * 2026-10-17-claude-background-helpers-design): a reply that `attach`es gets
 * its turn up to its own result, and anything else -- what Claude Code does
 * between replies -- goes to `onIdle`. So output from a turn a reply didn't
 * start never reaches it.
 */
export class LiveProcess {
  sessionId: string | null = null;
  busy = true;
  lastUsed = Date.now();
  binding: TurnBinding | null = null;
  /** Claude Code's name for this process's artifact tool (Deck #896), or null when its OtherBench server has none. */
  artifactTool: string | null = null;
  /** Claude Code's name for this process's recall tool, or null when its OtherBench server has none. */
  recallTool: string | null = null;
  /** Claude Code's name for this process's plan tool, or null when its server has none. */
  planTool: string | null = null;
  /** Claude Code's name for each relayed MCP tool on this process's OtherBench server -> the API model's name for it. */
  relayNames = new Map<string, string>();
  readonly stderr: string[] = [];
  private closed = false;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Where output goes while no reply is attached (the engine's background handling). */
  onIdle: (message: SDKMessage) => void = () => {};
  /** Why the output ended, when it ended with an error. */
  failure: unknown = null;
  /**
   * The permission mode Claude Code is running in, as it last said (each
   * turn's init and its status messages), or as it was started or last
   * switched. A reply's gate hands calls to the classifier only while this is 'auto'.
   */
  permissionMode: string | null = null;
  /** Whether this process can run in auto mode at all (it runs on the Claude login). */
  canAuto = false;
  /**
   * The chat's Auto as last set for this process, recorded the moment it
   * changes: calls go to the classifier only while this is on AND Claude Code
   * is in auto mode, so switching Auto off holds even before (or if never)
   * Claude Code confirms the switch.
   */
  wantsAuto = false;
  /** The background tasks this process is running for its chat (set by its first reply). */
  background: BackgroundTasks | null = null;
  /**
   * The reply that ran last (a user's or a self-started one): what its
   * helpers' calls between replies are gated with, and what a turn Claude
   * Code starts by itself follows.
   */
  last: { chatId: string; messageId: string; profileId: string; policy: ToolPolicy; ctx: ToolContext; autoMode: boolean; unattended: boolean } | null = null;
  private attached: { uuid: string; feed: TurnFeed } | null = null;
  private freeWaiters: (() => void)[] = [];
  private outputEnded = false;

  constructor(
    readonly key: string,
    readonly input: PromptQueue,
    readonly abortController: AbortController,
    readonly query: LiveQuery
  ) {
    void this.pump(query[Symbol.asyncIterator]());
  }

  /** The one reader of this process's output. */
  private async pump(iterator: AsyncIterator<SDKMessage>): Promise<void> {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        // The background tasks see everything, in the order it came.
        this.background?.handle(next.value);
        this.noteMode(next.value);
        const turn = this.attached;
        if (turn && (next.value as { type?: unknown }).type === 'result' && !resultFor(next.value, turn.uuid)) {
          // Another turn's result (one Claude Code ran by itself) never ends this reply.
          this.onIdle(next.value);
        } else if (turn) {
          turn.feed.push(next.value);
          if (resultFor(next.value, turn.uuid)) this.detach();
        } else {
          this.onIdle(next.value);
        }
      }
    } catch (err) {
      this.failure = err;
    } finally {
      this.outputEnded = true;
      this.detach();
    }
  }

  /** Keeps the mode Claude Code reports: at the start of each turn (init) and when it changes (status). */
  private noteMode(message: SDKMessage): void {
    const m = message as unknown as { type?: unknown; subtype?: unknown; permissionMode?: unknown };
    if (m.type === 'system' && (m.subtype === 'init' || m.subtype === 'status') && typeof m.permissionMode === 'string') this.permissionMode = m.permissionMode;
  }

  /**
   * Switches the running Claude Code to `mode`. False when this Claude Code
   * can't be switched (it has no setPermissionMode), or the switch failed.
   */
  async switchMode(mode: PermissionMode): Promise<boolean> {
    if (!this.query.setPermissionMode || this.closed) return false;
    try {
      await this.query.setPermissionMode(mode);
    } catch (err) {
      console.error('[engine-claude-code] could not switch Claude Code to ' + mode + ' mode:', err);
      return false;
    }
    this.permissionMode = mode;
    return true;
  }

  /** The output of the turn answering the message `uuid`, up to its result. Attach before sending that message. */
  attach(uuid: string): TurnFeed {
    const feed = new TurnFeed();
    if (this.outputEnded) {
      feed.end();
      return feed;
    }
    this.attached?.feed.end();
    this.attached = { uuid, feed };
    return feed;
  }

  get isAttached(): boolean {
    return this.attached !== null;
  }

  /** Resolves once no reply is attached. */
  whenFree(): Promise<void> {
    if (!this.attached) return Promise.resolve();
    return new Promise((resolve) => this.freeWaiters.push(resolve));
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached.feed.end();
    this.attached = null;
    if (this.background) this.background.current = null;
    const waiters = this.freeWaiters;
    this.freeWaiters = [];
    for (const wake of waiters) wake();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Stops the process for good: input ended, child killed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.binding = null;
    // Whatever was reading this process's turn learns it's over, and its background tasks end with it.
    this.detach();
    this.background?.closeAll();
    this.input.end();
    this.abortController.abort();
  }
}

/**
 * The options that fix a process's behaviour for its whole life. A reply can
 * reuse a live process only when these are identical; anything else -- a
 * different model, folder, tool policy, Plan mode, system prompt (which
 * carries project memory), extra folders, thinking budget, effort, backend or credentials -- starts
 * a fresh process. `connection` stands in for the child environment, which
 * can't be compared whole: the Agent SDK itself changes the server's
 * environment (`CLAUDE_AGENT_SDK_VERSION`) each time it starts a process.
 * Hashed, so no second plaintext copy of a credential is kept.
 */
export function liveKey(options: Options, connection: { backend: string; token: string | null }, own: OtherBenchServerSwitches): string {
  // The permission mode is left out: Auto is switched on a live process (LiveProcess.switchMode), as VS Code does.
  const { cwd, additionalDirectories, model, tools, disallowedTools, systemPrompt, strictMcpConfig, thinking, effort, settingSources, settings } = options;
  return createHash('sha256')
    .update(JSON.stringify({ connection, artifacts: own.artifacts, recall: own.recall, plan: own.plan, relay: own.relay, cwd, additionalDirectories, model, tools, disallowedTools, systemPrompt, strictMcpConfig, thinking, effort, settingSources, settings }))
    .digest('hex');
}

/** Resolves when `signal` aborts (never, without one). */
function abortedPromise(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

/**
 * The idle live processes, by Claude Code session id. A reply that continues
 * session S (the session planner already checked S's tip is the message being
 * answered) takes S's process if its options match; otherwise it starts a new
 * one, which joins the pool when its reply finishes. Idle processes close
 * after `idleMs`, and the longest-idle goes first when more than `max` exist.
 */
export class LivePool {
  private readonly idle = new Map<string, LiveProcess>();

  constructor(
    private readonly idleMs = LIVE_IDLE_MS,
    private readonly max = MAX_LIVE
  ) {}

  /**
   * The pooled process on `sessionId`, if its options match `key`; it's now
   * busy. One running a turn Claude Code started by itself is waited for
   * first, unless `signal` (the reply's) aborts meanwhile: then nothing is
   * taken and the process stays for the next message. A mismatched one is
   * closed.
   */
  async takeWhenFree(sessionId: string, key: string, signal?: AbortSignal): Promise<LiveProcess | null> {
    const waiting = this.idle.get(sessionId);
    if (waiting?.isAttached) {
      await Promise.race([waiting.whenFree(), abortedPromise(signal)]);
      if (signal?.aborted) return null;
    }
    const live = this.idle.get(sessionId);
    if (!live) return null;
    this.idle.delete(sessionId);
    clearTimeout(live.idleTimer);
    if (live.isClosed || live.key !== key) {
      live.close();
      return null;
    }
    live.busy = true;
    return live;
  }

  /**
   * Makes room for one more process: closes the longest-idle ones past the
   * cap, any running background tasks last. One running a turn (a stopped
   * reply's, or one Claude Code started by itself) is never closed: the cap
   * is exceeded until it ends.
   */
  makeRoom(): void {
    while (this.idle.size >= this.max) {
      let oldest: [string, LiveProcess] | null = null;
      const rank = (live: LiveProcess): number => (live.background?.running ? 1 : 0);
      for (const entry of this.idle) {
        if (entry[1].isAttached) continue;
        if (!oldest || rank(entry[1]) < rank(oldest[1]) || (rank(entry[1]) === rank(oldest[1]) && entry[1].lastUsed < oldest[1].lastUsed)) oldest = entry;
      }
      if (!oldest) return;
      this.idle.delete(oldest[0]);
      oldest[1].close();
    }
  }

  /** A finished reply hands its process back, ready for the session's next message. */
  release(live: LiveProcess): void {
    live.busy = false;
    live.binding = null;
    live.lastUsed = Date.now();
    if (live.isClosed || !live.sessionId) {
      live.close();
      return;
    }
    const previous = this.idle.get(live.sessionId);
    if (previous && previous !== live) {
      this.idle.delete(live.sessionId);
      previous.close();
    }
    this.makeRoom();
    if (this.max <= 0) {
      live.close();
      return;
    }
    this.idle.set(live.sessionId, live);
    this.armIdleTimer(live);
  }

  /** Closes an idle process after idleMs, unless it has background tasks running (then it looks again later). */
  private armIdleTimer(live: LiveProcess): void {
    live.idleTimer = setTimeout(() => {
      if (live.background?.running || live.isAttached) {
        this.armIdleTimer(live);
        return;
      }
      if (this.idle.get(live.sessionId!) === live) this.idle.delete(live.sessionId!);
      live.close();
    }, this.idleMs);
    live.idleTimer.unref?.();
  }

  /** How many processes are waiting for their next message. */
  get size(): number {
    return this.idle.size;
  }

  /** Closes every idle process (server shutdown). */
  closeAll(): void {
    for (const live of this.idle.values()) live.close();
    this.idle.clear();
  }
}
