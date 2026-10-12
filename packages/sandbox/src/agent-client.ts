import { SANDBOX_MAX_OUTPUT_BYTES, SandboxError } from '@grunt/core/ports/sandbox.js';
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
  askHost(host: string, port: number | undefined): Promise<boolean>;
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
    readyTimeoutMs: number = READY_TIMEOUT_MS
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
        this.current?.reject(err);
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
    const task = this.chain.then(() => this.start(run));
    this.chain = task.catch(() => undefined);
    return task.finally(() => {
      this.queued -= 1;
      this.lastUsed = this.now();
    });
  }

  /** Asks the agent to stop (it stops its commands and the runtime), and kills it after `graceMs`. */
  async close(graceMs: number = CLOSE_GRACE_MS): Promise<void> {
    if (!this.isAlive) return;
    this.closing = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.channel.kill();
        resolve();
      }, graceMs);
      this.channel.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
      this.channel.send({ type: 'close' });
    });
  }

  private async start(run: AgentRun): Promise<AgentOutcome> {
    await this.ready;
    if (!this.isAlive || this.closing) throw new SandboxError('agent_failed', 'The sandbox stopped before this command could start.');
    if (run.signal.aborted) throw new SandboxError('aborted', NOT_STARTED);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<AgentOutcome>((resolve, reject) => {
      const onAbort = (): void => this.channel.send({ type: 'cancel', id });
      run.signal.addEventListener('abort', onAbort, { once: true });
      const settle = (): void => {
        run.signal.removeEventListener('abort', onAbort);
        this.current = null;
      };
      this.current = {
        id,
        run,
        output: '',
        bytes: 0,
        truncated: false,
        resolve: (outcome) => {
          settle();
          resolve(outcome);
        },
        reject: (err) => {
          settle();
          reject(err);
        },
      };
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
      case 'done': {
        if (!cur || m.id !== cur.id) return;
        const truncated = cur.truncated || m.truncated;
        let output = cur.output;
        if (truncated) output += `\n\n[... output truncated: combined stdout+stderr exceeded the ${SANDBOX_MAX_OUTPUT_BYTES / 1024}KB cap ...]`;
        if (m.timedOut) output += `\n\n[... command killed after exceeding its ${Math.min(cur.run.timeoutMs, AGENT_MAX_TIMEOUT_MS)}ms timeout ...]`;
        if (m.note) output += `\n\n${m.note}`;
        cur.resolve({ exitCode: m.exitCode, signal: m.signal, timedOut: m.timedOut, truncated, output });
        return;
      }
      case 'failed':
        if (cur && m.id === cur.id) cur.reject(new SandboxError('agent_failed', m.message));
        return;
      case 'ask': {
        const askId = m.askId;
        const answer = (allowed: boolean): void => this.channel.send({ type: 'answer', askId, allowed });
        if (!cur || cur.run.signal.aborted) {
          answer(false);
          return;
        }
        cur.run.askHost(m.host, m.port ?? undefined).then(answer, () => answer(false));
        return;
      }
      default:
        return;
    }
  }
}
