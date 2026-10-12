import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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
