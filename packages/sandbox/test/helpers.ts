import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

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
