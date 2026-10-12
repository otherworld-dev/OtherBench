import { SandboxError } from '@grunt/core/ports/sandbox.js';
import type { AgentClient, AgentOutcome, AgentRun } from './agent-client.js';

export const MAX_AGENTS = 6;
export const AGENT_IDLE_MS = 15 * 60_000;
export const BUSY_WAIT_MS = 30_000;

const NOT_STARTED = 'The command was cancelled before the sandbox started it, so it was not run.';

export interface AgentPoolOptions {
  /** Starts a chat's agent (it sends init itself). */
  start(chatId: string): AgentClient;
  maxAgents?: number;
  idleMs?: number;
  busyWaitMs?: number;
  /** A chat's agent was closed (idle, to make room, released): its mounts can go. */
  onClosed?(chatId: string): void;
  /** A chat's agent died on its own (`wsl --shutdown`, a crash): whatever killed it may have taken every mount with it. */
  onDied?(chatId: string): void;
}

interface Entry {
  client: AgentClient;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Callers that have been handed this agent and not yet given it a command. The
   * client only counts as busy once it has one, so without this an agent could be
   * closed to make room in the gap between being found and being used.
   */
  leases: Set<object>;
}

interface Starting {
  promise: Promise<Entry>;
  /** The callers waiting on this start; each holds a lease on the agent once it exists. */
  interested: Set<object>;
  /** Aborted when nobody waits for the start any more, or the pool is releasing/closing. */
  cancel: AbortController;
  /** Past the wait for a free slot: its agent process exists (or is being started). */
  spawned: boolean;
}

/**
 * The chats' agents (spec 2026-10-12-sandbox-design, "Agent processes"): one
 * per chat with a sandboxed command running or recently run, closed after
 * 15 minutes idle; at most 6, the one idle longest closing first; if all 6
 * are busy a new chat's command waits up to 30 s, then is refused as busy.
 * An agent that fails to start is tried once more.
 *
 * An agent that is shutting down still counts against the limit and still holds
 * its chat: that chat's next agent is not started until `onClosed` has run, so
 * the mounts torn down for the old one can't be pulled from under the new one.
 */
export class AgentPool {
  private readonly agents = new Map<string, Entry>();
  private readonly starting = new Map<string, Starting>();
  /** Agents being closed, by chat, until their close has finished and `onClosed` has run. */
  private readonly closing = new Map<string, Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private readonly maxAgents: number;
  private readonly idleMs: number;
  private readonly busyWaitMs: number;

  constructor(private readonly opts: AgentPoolOptions) {
    this.maxAgents = opts.maxAgents ?? MAX_AGENTS;
    this.idleMs = opts.idleMs ?? AGENT_IDLE_MS;
    this.busyWaitMs = opts.busyWaitMs ?? BUSY_WAIT_MS;
  }

  has(chatId: string): boolean {
    return this.agents.has(chatId) || this.starting.has(chatId);
  }

  get size(): number {
    return this.agents.size + this.starting.size;
  }

  async run(chatId: string, run: AgentRun): Promise<AgentOutcome> {
    const lease = {};
    const entry = await this.acquire(chatId, run.signal, lease);
    try {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
      const outcome = entry.client.run(run);
      // The client is busy from here on, which is what keeps it from being closed.
      entry.leases.delete(lease);
      return await outcome;
    } finally {
      entry.leases.delete(lease);
      this.scheduleIdle(chatId, entry);
      this.wake();
    }
  }

  async release(chatId: string): Promise<void> {
    const starting = this.starting.get(chatId);
    if (starting) {
      starting.cancel.abort();
      await starting.promise.catch(() => undefined);
    }
    const entry = this.agents.get(chatId);
    if (entry) await this.closeEntry(chatId, entry);
    await this.closing.get(chatId);
  }

  async closeAll(): Promise<void> {
    for (const starting of this.starting.values()) starting.cancel.abort();
    await Promise.all([...this.starting.values()].map((s) => s.promise.catch(() => undefined)));
    await Promise.all([...this.agents].map(([chatId, entry]) => this.closeEntry(chatId, entry)));
    await Promise.all([...this.closing.values()]);
  }

  /** The chat's agent with `lease` held on it (the caller releases it), starting one if need be. */
  private acquire(chatId: string, signal: AbortSignal, lease: object): Promise<Entry> {
    if (signal.aborted) return Promise.reject(new SandboxError('aborted', NOT_STARTED));
    const existing = this.agents.get(chatId);
    if (existing?.client.alive) {
      existing.leases.add(lease);
      return Promise.resolve(existing);
    }
    // Died since its last command: say so, and start afresh.
    if (existing) this.died(chatId, existing);
    let start = this.starting.get(chatId);
    if (!start) {
      const created: Starting = { promise: undefined as unknown as Promise<Entry>, interested: new Set(), cancel: new AbortController(), spawned: false };
      created.promise = this.startAgent(chatId, created);
      created.promise.catch(() => undefined);
      this.starting.set(chatId, created);
      start = created;
    }
    const starting = start;
    starting.interested.add(lease);
    return new Promise<Entry>((resolve, reject) => {
      let gone = false;
      const onAbort = (): void => {
        gone = true;
        starting.interested.delete(lease);
        // Nobody left who wants this agent: don't keep waiting for room to start it.
        if (starting.interested.size === 0) starting.cancel.abort();
        reject(new SandboxError('aborted', NOT_STARTED));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      starting.promise.then(
        (entry) => {
          signal.removeEventListener('abort', onAbort);
          if (gone) {
            // Stopped while the agent started: it stays, idle, for the chat's next command.
            entry.leases.delete(lease);
            this.scheduleIdle(chatId, entry);
          } else {
            resolve(entry);
          }
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          if (!gone) reject(err);
        }
      );
    });
  }

  private async startAgent(chatId: string, start: Starting): Promise<Entry> {
    try {
      await this.closing.get(chatId);
      await this.makeRoom(start);
      let failure: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const client = this.opts.start(chatId);
        try {
          await client.ready;
          const entry: Entry = { client, idleTimer: undefined, leases: new Set(start.interested) };
          this.agents.set(chatId, entry);
          this.starting.delete(chatId);
          void client.exited.then(() => this.died(chatId, entry));
          this.scheduleIdle(chatId, entry);
          return entry;
        } catch (err) {
          failure = err;
          await client.close(0).catch(() => undefined);
        }
      }
      throw failure instanceof Error ? failure : new SandboxError('agent_failed', String(failure));
    } finally {
      if (this.starting.get(chatId) === start) this.starting.delete(chatId);
      start.spawned = false;
      this.wake();
    }
  }

  /** Agents that hold a process: running, starting up, or shutting down. */
  private inUse(): number {
    let starting = 0;
    for (const s of this.starting.values()) if (s.spawned) starting += 1;
    return this.agents.size + this.closing.size + starting;
  }

  private async makeRoom(start: Starting): Promise<void> {
    const deadline = Date.now() + this.busyWaitMs;
    const { signal } = start.cancel;
    for (;;) {
      if (signal.aborted) throw new SandboxError('aborted', NOT_STARTED);
      if (this.inUse() < this.maxAgents) {
        start.spawned = true;
        return;
      }
      const idle = [...this.agents].filter(([, e]) => !e.client.busy && e.leases.size === 0).sort(([, a], [, b]) => a.client.lastUsed - b.client.lastUsed)[0];
      if (idle) {
        await this.closeEntry(idle[0], idle[1]);
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        const n = this.inUse();
        throw new SandboxError('busy', `The sandbox is already running commands in ${n} other chat${n === 1 ? '' : 's'}. Try again when one finishes.`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => done(), left);
        const done = (): void => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        this.waiters.add(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
  }

  private closeEntry(chatId: string, entry: Entry): Promise<void> {
    if (this.agents.get(chatId) !== entry) return this.closing.get(chatId) ?? Promise.resolve();
    clearTimeout(entry.idleTimer);
    this.agents.delete(chatId);
    if (!entry.client.alive) {
      // Already gone: that is a death, not a close.
      this.opts.onDied?.(chatId);
      this.wake();
      return Promise.resolve();
    }
    const done = (async (): Promise<void> => {
      try {
        await entry.client.close();
      } finally {
        this.closing.delete(chatId);
        try {
          this.opts.onClosed?.(chatId);
        } finally {
          this.wake();
        }
      }
    })();
    this.closing.set(chatId, done);
    return done;
  }

  /** The chat's agent exited by itself (nobody closed it): forget it and report it. */
  private died(chatId: string, entry: Entry): void {
    if (this.agents.get(chatId) !== entry) return;
    clearTimeout(entry.idleTimer);
    this.agents.delete(chatId);
    this.opts.onDied?.(chatId);
    this.wake();
  }

  private scheduleIdle(chatId: string, entry: Entry): void {
    if (this.agents.get(chatId) !== entry || entry.client.busy || entry.leases.size > 0) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.client.busy || entry.leases.size > 0) return;
      void this.closeEntry(chatId, entry);
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
