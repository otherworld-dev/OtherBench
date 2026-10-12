import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
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
