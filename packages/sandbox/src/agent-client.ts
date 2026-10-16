import { SANDBOX_MAX_OUTPUT_BYTES, SandboxError } from '@otherbench/core/ports/sandbox.js';
import type { AgentChannel, AgentExit } from './agent-channel.js';
import type { AgentMessage } from './protocol.js';

/** The distro's first start can take a few seconds; a minute means something is wrong. */
export const READY_TIMEOUT_MS = 60_000;
/**
 * How long close() waits for the agent to exit before killing it. The agent
 * itself waits up to ~2.5 s for a command in flight (SIGTERM, then SIGKILL after
 * 2 s) and then resets the runtime, so this has to leave it that time.
 */
export const CLOSE_GRACE_MS = 5000;
/**
 * How long a cancelled command gets to report: the agent's SIGTERM, 2 s, SIGKILL
 * and clean-up, with room to spare. Past it the agent is stopped, so a wedged
 * one can't hold a run forever.
 */
export const CANCEL_WATCHDOG_MS = 5000;
/**
 * Once the agent says it is putting a run's protected files back ('restoring'), a cancel or a close waits
 * up to this long from then instead: each file it removes or rewrites is a round trip to Windows, and an
 * agent stopped halfway leaves the folder unguarded.
 */
export const RESTORE_GRACE_MS = 60_000;
/** After killing a wedged agent, how long a run waits for it to exit before giving up on it anyway. */
const KILL_EXIT_WAIT_MS = 5000;
/** The longest the agent lets a command run, whatever a run asks for. */
const AGENT_MAX_TIMEOUT_MS = 600_000;

export interface AgentInit {
  home: string;
  tmpRoot: string;
  allowedHosts: string[];
}

/** One command for the agent: Linux paths, already worked out by WslSandbox. */
export interface AgentRun {
  command: string;
  cwd: string;
  timeoutMs: number;
  readPaths: string[];
  writePaths: string[];
  /** Read-only folders, including any inside a writable one: the runtime refuses writes there. */
  denyWritePaths: string[];
  allowedHosts: string[];
  signal: AbortSignal;
  /**
   * Whether the command may reach this host. `askSignal` aborts when the question
   * stops mattering (the turn was stopped, or the command ended, or the agent
   * went away): take the network card down then; any answer is ignored.
   */
  askHost(host: string, port: number | undefined, askSignal: AbortSignal): Promise<boolean>;
  /**
   * Called (before the run settles) with the writable folders, as Linux paths, whose protected files the
   * agent couldn't confirm it put back: it said so, or it died or was stopped after the run was sent and
   * before it reported the run.
   */
  onUnguarded?(linuxPaths: string[]): void;
}

export interface AgentOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  output: string;
}

interface Current {
  id: number;
  run: AgentRun;
  output: string;
  bytes: number;
  truncated: boolean;
  /** Questions about hosts that have been put to the run's askHost and not answered. */
  asks: Set<AbortController>;
  /** When the agent said it started putting the run's protected files back, or null. */
  restoringSince: number | null;
  /** Set when this client killed the agent over this run: the error the run fails with once the agent is gone. */
  stoppedWith: string | null;
  /** After the restore starts: a cancel's watchdog starts over with the restore's grace. */
  rearm(): void;
  abortAsks(): void;
  resolve(outcome: AgentOutcome): void;
  reject(err: Error): void;
}

const NOT_STARTED = 'The turn was cancelled before this command started, so it was not run.';

/** The longest prefix of `text` that is at most `maxBytes` of UTF-8, cut between characters. */
function fitBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    bytes += Buffer.byteLength(ch, 'utf8');
    if (bytes > maxBytes) break;
    end += ch.length;
  }
  return text.slice(0, end);
}

/**
 * One chat's agent (spec 2026-10-12-sandbox-design §2, agent-client):
 * request ids, output under the 100 KB cap, cancel, and the "may this host
 * be reached?" round trip. Commands run one at a time: the runtime's ask
 * callback doesn't say which command is asking, so with one command running
 * the question can only be that command's, and each run brings its own
 * profile's allowlist (a compare turn's variants share the chat's agent).
 * The agent refuses a second run while one is in flight, so the next run is
 * sent only once the previous one has reported done or failed.
 */
export class AgentClient {
  readonly ready: Promise<void>;
  readonly exited: Promise<AgentExit>;
  lastUsed: number;
  private isAlive = true;
  private closing = false;
  private queued = 0;
  private current: Current | null = null;
  /** Ids are safe non-negative integers; the agent names the run's temp folder after one. */
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly channel: AgentChannel,
    init: AgentInit,
    private readonly now: () => number = Date.now,
    readyTimeoutMs: number = READY_TIMEOUT_MS,
    private readonly cancelWatchdogMs: number = CANCEL_WATCHDOG_MS,
    private readonly restoreGraceMs: number = RESTORE_GRACE_MS
  ) {
    this.lastUsed = now();
    let markExited!: (e: AgentExit) => void;
    this.exited = new Promise<AgentExit>((resolve) => (markExited = resolve));
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SandboxError('agent_failed', `The sandbox didn't start within ${Math.round(readyTimeoutMs / 1000)} s.`));
        channel.kill();
      }, readyTimeoutMs);
      channel.onMessage((m) => {
        if (m.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (m.type === 'fatal') {
          clearTimeout(timer);
          reject(new SandboxError('agent_failed', `The sandbox couldn't start: ${m.message}`));
        } else {
          this.handle(m);
        }
      });
      channel.onExit((e) => {
        clearTimeout(timer);
        this.isAlive = false;
        const err = new SandboxError('agent_failed', `The sandbox stopped (exit ${String(e.code)})${e.detail.trim() ? `: ${e.detail.trim()}` : '.'}`);
        reject(err);
        const cur = this.current;
        if (cur) {
          // Gone before reporting the run: whatever its command did to protected files may still be there.
          this.unguarded(cur, cur.run.writePaths);
          cur.reject(cur.stoppedWith ? new SandboxError('agent_failed', cur.stoppedWith) : err);
        }
        markExited(e);
      });
    });
    this.ready.catch(() => undefined);
    channel.send({ type: 'init', home: init.home, tmpRoot: init.tmpRoot, allowedHosts: [...init.allowedHosts] });
  }

  get alive(): boolean {
    return this.isAlive;
  }

  /** Running or waiting to run a command. */
  get busy(): boolean {
    return this.queued > 0;
  }

  run(run: AgentRun): Promise<AgentOutcome> {
    this.queued += 1;
    let sent = false;
    const task = this.chain.then(() => this.start(run, () => (sent = true)));
    this.chain = task.catch(() => undefined);
    // Until the command is with the agent (where a cancel takes over), a stopped
    // turn doesn't wait for the agent to start or for the commands ahead of it.
    let onAbort = (): void => undefined;
    const waiting = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        if (!sent) reject(new SandboxError('aborted', NOT_STARTED));
      };
      if (run.signal.aborted) onAbort();
      else run.signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([task, waiting]).finally(() => {
      run.signal.removeEventListener('abort', onAbort);
      this.queued -= 1;
      this.lastUsed = this.now();
    });
  }

  /** Asks the agent to stop (it stops its commands and the runtime), and kills it after `graceMs`. */
  async close(graceMs: number = CLOSE_GRACE_MS): Promise<void> {
    if (!this.isAlive) return;
    this.closing = true;
    // The agent refuses what it was asked, and the command is going away.
    this.current?.abortAsks();
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const expire = (): void => {
        // Putting a run's protected files back: given up to restoreGraceMs from when that started.
        const since = this.current?.restoringSince ?? null;
        const left = since === null ? 0 : since + this.restoreGraceMs - this.now();
        if (left > 0) {
          timer = setTimeout(expire, left);
          return;
        }
        this.channel.kill();
        resolve();
      };
      timer = setTimeout(expire, graceMs);
      this.channel.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
      this.channel.send({ type: 'close' });
    });
  }

  /** Tells the run's owner which of its folders are unguarded (once per run, only folders it could write). */
  private unguarded(cur: Current, linuxPaths: readonly string[]): void {
    const paths = linuxPaths.filter((p) => cur.run.writePaths.includes(p));
    if (paths.length > 0) cur.run.onUnguarded?.(paths);
  }

  private async start(run: AgentRun, markSent: () => void): Promise<AgentOutcome> {
    await this.ready;
    if (run.signal.aborted) throw new SandboxError('aborted', NOT_STARTED);
    if (!this.isAlive || this.closing) throw new SandboxError('agent_failed', 'The sandbox stopped before this command could start.');
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<AgentOutcome>((resolve, reject) => {
      let watchdog: NodeJS.Timeout | undefined;
      const cur: Current = {
        id,
        run,
        output: '',
        bytes: 0,
        truncated: false,
        asks: new Set(),
        restoringSince: null,
        stoppedWith: null,
        rearm: () => undefined,
        abortAsks: () => {
          for (const ask of cur.asks) ask.abort();
          cur.asks.clear();
        },
        resolve: (outcome) => {
          settle();
          resolve(outcome);
        },
        reject: (err) => {
          settle();
          reject(err);
        },
      };
      let cancelled = false;
      // The agent answers a cancel with done; if it doesn't, it is stopped, and the run fails once it is gone
      // (never sooner: until then it may still be putting protected files back).
      const stop = (): void => {
        cur.stoppedWith = "The sandbox didn't stop the command after it was cancelled, so it was stopped.";
        this.channel.kill();
        watchdog = setTimeout(() => {
          this.unguarded(cur, run.writePaths);
          cur.reject(new SandboxError('agent_failed', cur.stoppedWith ?? ''));
        }, KILL_EXIT_WAIT_MS);
      };
      const armWatchdog = (): void => {
        clearTimeout(watchdog);
        // Once the restore has started, it gets up to restoreGraceMs from then.
        const ms = cur.restoringSince === null ? this.cancelWatchdogMs : Math.max(0, cur.restoringSince + this.restoreGraceMs - this.now());
        watchdog = setTimeout(stop, ms);
      };
      cur.rearm = () => {
        if (cancelled) armWatchdog();
      };
      const onAbort = (): void => {
        cur.abortAsks();
        this.channel.send({ type: 'cancel', id });
        if (!cancelled) {
          cancelled = true;
          armWatchdog();
        }
      };
      const settle = (): void => {
        clearTimeout(watchdog);
        run.signal.removeEventListener('abort', onAbort);
        cur.abortAsks();
        this.current = null;
      };
      run.signal.addEventListener('abort', onAbort, { once: true });
      this.current = cur;
      markSent();
      this.channel.send({
        type: 'run',
        id,
        command: run.command,
        cwd: run.cwd,
        timeoutMs: run.timeoutMs,
        readPaths: run.readPaths,
        writePaths: run.writePaths,
        denyWritePaths: run.denyWritePaths,
        allowedHosts: run.allowedHosts,
      });
    });
  }

  private handle(m: AgentMessage): void {
    const cur = this.current;
    switch (m.type) {
      case 'output': {
        if (!cur || m.id !== cur.id || cur.truncated) {
          if (cur && m.id === cur.id) cur.truncated = true;
          return;
        }
        const bytes = Buffer.byteLength(m.chunk, 'utf8');
        if (cur.bytes + bytes > SANDBOX_MAX_OUTPUT_BYTES) {
          const kept = fitBytes(m.chunk, SANDBOX_MAX_OUTPUT_BYTES - cur.bytes);
          cur.output += kept;
          cur.bytes += Buffer.byteLength(kept, 'utf8');
          cur.truncated = true;
        } else {
          cur.output += m.chunk;
          cur.bytes += bytes;
        }
        return;
      }
      case 'restoring':
        if (cur && m.id === cur.id && cur.restoringSince === null) {
          cur.restoringSince = this.now();
          cur.rearm();
        }
        return;
      case 'done': {
        if (!cur || m.id !== cur.id) return;
        this.unguarded(cur, m.unguarded);
        const truncated = cur.truncated || m.truncated;
        let output = cur.output;
        if (truncated) output += `\n\n[... output truncated: combined stdout+stderr exceeded the ${SANDBOX_MAX_OUTPUT_BYTES / 1024}KB cap ...]`;
        if (m.timedOut) output += `\n\n[... command killed after exceeding its ${Math.min(cur.run.timeoutMs, AGENT_MAX_TIMEOUT_MS)}ms timeout ...]`;
        if (m.note) output += `\n\n${m.note}`;
        cur.resolve({ exitCode: m.exitCode, signal: m.signal, timedOut: m.timedOut, truncated, output });
        return;
      }
      case 'failed':
        if (cur && m.id === cur.id) {
          this.unguarded(cur, m.unguarded);
          cur.reject(new SandboxError('agent_failed', m.message));
        }
        return;
      case 'ask': {
        const askId = m.askId;
        const answer = (allowed: boolean): void => this.channel.send({ type: 'answer', askId, allowed });
        if (!cur || cur.run.signal.aborted) {
          answer(false);
          return;
        }
        const question = new AbortController();
        cur.asks.add(question);
        // Whatever comes back after the question stopped mattering is not sent: the agent has answered no itself.
        const respond = (allowed: boolean): void => {
          cur.asks.delete(question);
          if (!question.signal.aborted) answer(allowed);
        };
        let pending: Promise<boolean>;
        try {
          pending = cur.run.askHost(m.host, m.port ?? undefined, question.signal);
        } catch {
          respond(false);
          return;
        }
        Promise.resolve(pending).then(respond, () => respond(false));
        return;
      }
      default:
        return;
    }
  }
}
