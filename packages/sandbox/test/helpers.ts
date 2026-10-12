import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { AgentChannel, AgentExit } from '../src/agent-channel.js';
import { AgentClient, type AgentInit } from '../src/agent-client.js';
import type { AgentMessage, HostMessage } from '../src/protocol.js';
import { INSTALL_DIR, NODE_SHA256, NODE_VERSION } from '../src/setup.js';
import type { WslResult, WslRunner, WslUser } from '../src/wsl.js';

export interface FakeChild {
  child: ChildProcessWithoutNullStreams;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  /** Ends the output streams and emits 'close' with this code on the next turn. */
  exit(code: number | null): void;
  /** Everything written to the child's stdin so far. */
  written(): string;
}

/** A child process stand-in: streams you can write to, and an exit you control. kill() exits it with null. */
export function fakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = '';
  stdin.on('data', (d: Buffer) => {
    input += d.toString('utf8');
  });
  const fake: FakeChild = {
    child: Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      pid: 4242,
      kill: (): boolean => {
        fake.killed = true;
        fake.exit(null);
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams,
    stdin,
    stdout,
    stderr,
    killed: false,
    exit: (code) => {
      stdout.end();
      stderr.end();
      setImmediate(() => emitter.emit('close', code, code === null ? 'SIGTERM' : null));
    },
    written: () => input,
  };
  return fake;
}

export type WslCall = { kind: 'wsl'; args: string[] } | { kind: 'exec'; user: WslUser; argv: string[] };

/** A WslRunner that runs nothing: records every call and answers success unless `answer` says otherwise. */
export class FakeWsl implements WslRunner {
  readonly calls: WslCall[] = [];
  constructor(private readonly answer: (call: WslCall) => Partial<WslResult> | undefined = () => undefined) {}
  async wsl(args: string[]): Promise<WslResult> {
    return this.reply({ kind: 'wsl', args });
  }
  async exec(user: WslUser, argv: string[]): Promise<WslResult> {
    return this.reply({ kind: 'exec', user, argv });
  }
  spawn(): never {
    throw new Error('FakeWsl starts no agents: pass startAgent instead.');
  }
  /** Every call as one line: `wsl --list --quiet` or `root: /bin/mkdir -p /x`. */
  get commands(): string[] {
    return this.calls.map((c) => (c.kind === 'wsl' ? `wsl ${c.args.join(' ')}` : `${c.user}: ${c.argv.join(' ')}`));
  }
  private reply(call: WslCall): WslResult {
    this.calls.push(call);
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...this.answer(call) };
  }
}

/** The build folder happyWsl's mktemp makes. */
export const STAGING = '/opt/.grunt-sandbox.AbC123';

/** A distro where every setup step works. `override` answers first, for the step a test wants to fail. */
export function happyWsl(opts: { distros?: string; user?: boolean; node?: boolean; override?: (call: WslCall) => Partial<WslResult> | undefined } = {}): FakeWsl {
  let nodeInstalled = opts.node === true;
  return new FakeWsl((call) => {
    const overridden = opts.override?.(call);
    if (overridden) return overridden;
    if (call.kind === 'wsl') {
      if (call.args[0] === '--version') return { stdout: 'WSL version: 2.7.3.0\r\nKernel version: 6.6.87.2-1\r\n' };
      if (call.args[0] === '--list') return { stdout: opts.distros ?? 'Ubuntu\r\n' };
      return undefined;
    }
    const [program, ...rest] = call.argv;
    if (program === '/usr/bin/test') return { code: 1 }; // no WSLInterop entry: interop is off
    if (program === '/usr/bin/id') return opts.user === true ? { stdout: '1000\n' } : { code: 1, stderr: "id: 'grunt': no such user" };
    if (program === '/usr/bin/mktemp') return { stdout: `${STAGING}\n` };
    if (program === '/usr/bin/find' && (rest[0] === INSTALL_DIR || rest[0] === `${STAGING}/tree`)) return { stdout: '' }; // nothing in the install belongs to anyone but root
    if (program === '/usr/bin/sha256sum') return { stdout: `${NODE_SHA256}  ${rest[0] ?? ''}\n` };
    if (program === '/bin/tar') {
      nodeInstalled = true;
      return undefined;
    }
    if (program?.endsWith('/node/bin/node')) return nodeInstalled ? { stdout: `${NODE_VERSION}\n` } : { code: 127, stderr: 'No such file or directory' };
    if (program === '/bin/cat' && rest[0] === '/etc/os-release') return { stdout: 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.5 LTS"\n' };
    if (program === '/bin/cat') return { stdout: '{"name":"@anthropic-ai/sandbox-runtime","version":"0.0.79"}' };
    if (program === '/usr/sbin/ip') return { stdout: 'default via 172.20.48.1 dev eth0 proto kernel\n' };
    return undefined;
  });
}

const MOUNT_SH = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'mount.sh');
/** Git Bash on Windows (never System32\bash.exe, which would run in a WSL distro); /bin/bash elsewhere. */
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
export const hasBash = existsSync(BASH);

export interface ScriptResult {
  code: number | null;
  out: string;
  err: string;
}

/**
 * mount.sh in dry-run mode. `mounted` pretends the target is already mounted in that mode
 * (GRUNT_MOUNT_DRY_RUN_MOUNTED); `sim` sets the other GRUNT_MOUNT_DRY_RUN_* variables that
 * simulate the filesystem (SYMLINK, GRUNT_OWNED, WRITABLE, READONLY).
 */
export function runMountScript(args: string[], mounted?: string, sim: Record<string, string> = {}): ScriptResult {
  const env: NodeJS.ProcessEnv = { ...process.env, GRUNT_MOUNT_DRY_RUN: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('GRUNT_MOUNT_DRY_RUN_')) delete env[key];
  if (mounted) env['GRUNT_MOUNT_DRY_RUN_MOUNTED'] = mounted;
  for (const [key, value] of Object.entries(sim)) env[`GRUNT_MOUNT_DRY_RUN_${key}`] = value;
  const r = spawnSync(BASH, [MOUNT_SH, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/**
 * Like runMountScript() for `mount`, but the paths travel in the environment: Git Bash on Windows
 * re-parses a command-line argument (it splits one at a newline and drops apostrophes), the
 * real caller (wsl.exe --exec) doesn't.
 */
export function runMountScriptWithEnvPaths(win: string, target: string, mode = 'ro'): ScriptResult {
  const env: NodeJS.ProcessEnv = { ...process.env, GRUNT_MOUNT_DRY_RUN: '1', TEST_WIN: win, TEST_TARGET: target, TEST_MODE: mode, TEST_SCRIPT: MOUNT_SH };
  for (const key of Object.keys(env)) if (key.startsWith('GRUNT_MOUNT_DRY_RUN_')) delete env[key];
  // exec "$BASH": a bare `bash` would be found through PATH, and on Windows that can be System32\bash.exe (WSL).
  const r = spawnSync(BASH, ['-c', 'exec "$BASH" "$TEST_SCRIPT" mount "$TEST_WIN" "$TEST_TARGET" "$TEST_MODE"'], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export type RunMessage = Extract<HostMessage, { type: 'run' }>;

export interface AgentScript {
  /** What the agent answers to init. Default 'ready'. */
  ready?: 'ready' | 'fatal' | 'silent';
  /** Don't exit on close (an agent that hangs). */
  ignoreClose?: boolean;
  /**
   * On close, report a command still running as done (killed by SIGTERM), then exit a little later, as the real
   * agent does (it resets the runtime in between).
   */
  finishOnClose?: boolean;
  /** What the agent does with a run. Default: finishes it with "ok\n", exit 0. */
  onRun?: (msg: RunMessage, channel: FakeChannel) => void;
}

/** An AgentChannel with a scripted agent on the other end. */
export class FakeChannel implements AgentChannel {
  readonly sent: HostMessage[] = [];
  killed = false;
  private readonly messageListeners: ((m: AgentMessage) => void)[] = [];
  private readonly exitListeners: ((e: AgentExit) => void)[] = [];
  private exited = false;
  /** Runs sent and not yet reported done. */
  private readonly open = new Set<number>();

  constructor(private readonly script: AgentScript = {}) {}

  send(m: HostMessage): void {
    this.sent.push(m);
    if (m.type === 'init') {
      const ready = this.script.ready ?? 'ready';
      if (ready === 'ready') queueMicrotask(() => this.emit({ type: 'ready' }));
      if (ready === 'fatal') queueMicrotask(() => this.emit({ type: 'fatal', message: 'bwrap: No permissions to create new namespace' }));
    }
    if (m.type === 'run') this.open.add(m.id);
    if (m.type === 'close' && this.script.finishOnClose === true) {
      for (const id of [...this.open]) this.emit({ type: 'done', id, exitCode: null, signal: 'SIGTERM', timedOut: false, truncated: false, note: '', unguarded: [] });
    }
    if (m.type === 'run') (this.script.onRun ?? ((msg, ch) => queueMicrotask(() => ch.finish(msg.id, 'ok\n'))))(m, this);
    if (m.type === 'close' && this.script.ignoreClose !== true) {
      if (this.script.finishOnClose === true) setTimeout(() => this.emitExit(0), 20);
      else queueMicrotask(() => this.emitExit(0));
    }
  }
  onMessage(cb: (m: AgentMessage) => void): void {
    this.messageListeners.push(cb);
  }
  onExit(cb: (e: AgentExit) => void): void {
    this.exitListeners.push(cb);
  }
  kill(): void {
    this.killed = true;
    this.emitExit(null, 'killed');
  }
  emit(m: AgentMessage): void {
    if (m.type === 'done') this.open.delete(m.id);
    for (const cb of this.messageListeners) cb(m);
  }
  emitExit(code: number | null, detail = ''): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitListeners) cb({ code, detail });
  }
  /** The agent finishing run `id`: its output, then done with this exit code. */
  finish(id: number, output = '', exitCode = 0, unguarded: string[] = []): void {
    if (output) this.emit({ type: 'output', id, chunk: output });
    this.emit({ type: 'done', id, exitCode, signal: null, timedOut: false, truncated: false, note: '', unguarded });
  }
  runs(): RunMessage[] {
    return this.sent.filter((m): m is RunMessage => m.type === 'run');
  }
}

export function scriptedAgent(
  script: AgentScript = {},
  init: AgentInit = { home: '/home/grunt/chats/c1', tmpRoot: '/tmp/grunt-chats/c1', allowedHosts: [] }
): { client: AgentClient; channel: FakeChannel } {
  const channel = new FakeChannel(script);
  return { channel, client: new AgentClient(channel, init) };
}
