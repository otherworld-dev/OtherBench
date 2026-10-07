import { createHash } from 'node:crypto';
import type { HookCallback, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Gate } from './approval.js';

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

/** What one reply binds a live process's hooks to while it runs. */
export interface TurnBinding {
  gate: Gate;
  /** Audits auto-mode classifier blocks (only set when the process runs in auto mode). */
  permissionDenied?: HookCallback;
}

/**
 * One Claude Code process kept alive between replies (spec amendment:
 * live sessions). Its options -- and so its hooks -- are fixed when it
 * starts, so the hooks call through `binding`, which each reply sets for its
 * own approvals context and clears when it ends.
 */
export class LiveProcess {
  sessionId: string | null = null;
  busy = true;
  lastUsed = Date.now();
  binding: TurnBinding | null = null;
  readonly stderr: string[] = [];
  readonly iterator: AsyncIterator<SDKMessage>;
  private closed = false;
  idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly key: string,
    readonly input: PromptQueue,
    readonly abortController: AbortController,
    stream: AsyncIterable<SDKMessage>
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
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
    this.input.end();
    this.abortController.abort();
  }
}

/**
 * The options that fix a process's behaviour for its whole life. A reply can
 * reuse a live process only when these are identical; anything else -- a
 * different model, folder, tool policy, auto mode, system prompt (which
 * carries project memory), extra folders, thinking budget, effort, backend or credentials -- starts
 * a fresh process. `connection` stands in for the child environment, which
 * can't be compared whole: the Agent SDK itself changes the server's
 * environment (`CLAUDE_AGENT_SDK_VERSION`) each time it starts a process.
 * Hashed, so no second plaintext copy of a credential is kept.
 */
export function liveKey(options: Options, connection: { backend: string; token: string | null }): string {
  const { cwd, additionalDirectories, model, permissionMode, disallowedTools, systemPrompt, strictMcpConfig, thinking, effort, settingSources, settings } = options;
  return createHash('sha256')
    .update(JSON.stringify({ connection, cwd, additionalDirectories, model, permissionMode, disallowedTools, systemPrompt, strictMcpConfig, thinking, effort, settingSources, settings }))
    .digest('hex');
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

  /** The idle process on `sessionId`, if its options match `key`; it's now busy. A mismatched one is closed. */
  take(sessionId: string, key: string): LiveProcess | null {
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

  /** Makes room for one more process: closes the longest-idle ones past the cap. */
  makeRoom(): void {
    while (this.idle.size >= this.max) {
      let oldest: [string, LiveProcess] | null = null;
      for (const entry of this.idle) if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry;
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
    live.idleTimer = setTimeout(() => {
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
