import { DEFAULT_SCRYPT, passwordProblem, PasswordFile, type ScryptParams } from './password.js';

export interface PasswordCommandIo {
  stdin: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => unknown };
  stdout: { write(chunk: string): unknown };
  /** Asks twice without echo when true; else reads the first line of stdin. */
  isTTY: boolean;
}

export class PasswordCommandError extends Error {}

/** The first line of a piped stdin, without its `\n` or `\r\n`; null when there's nothing at all. */
function readFirstLine(stdin: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      stdin.pause();
      resolve(value);
    };
    const onData = (chunk: string | Buffer): void => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl !== -1) finish(buffer.slice(0, nl).replace(/\r$/, ''));
    };
    const onEnd = (): void => finish(buffer === '' ? null : buffer.replace(/\r$/, ''));
    const onError = (err: Error): void => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      reject(new PasswordCommandError(`Could not read the password: ${err.message}`));
    };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
    stdin.resume();
  });
}

/**
 * One line typed on a terminal in raw mode, never echoed. Backspace works;
 * Ctrl+C cancels; other control characters and escape sequences (arrow keys,
 * Delete) are ignored; the stream ending or failing mid-prompt is an error.
 */
function readHidden(io: PasswordCommandIo, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    io.stdout.write(prompt);
    let value = '';
    let done = false;
    // 0: plain input; 1: just after ESC; 2: inside a `[`/`O` sequence, up to its final byte.
    let escape: 0 | 1 | 2 = 0;
    const finish = (err: Error | null): void => {
      if (done) return;
      done = true;
      io.stdin.removeListener('data', onData);
      io.stdin.removeListener('end', onClosed);
      io.stdin.removeListener('close', onClosed);
      io.stdin.removeListener('error', onError);
      io.stdin.setRawMode?.(false);
      io.stdin.pause();
      io.stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onClosed = (): void => finish(new PasswordCommandError('Input closed. Nothing was changed.'));
    const onError = (err: Error): void => finish(new PasswordCommandError(`Could not read the password: ${err.message}`));
    const onData = (chunk: string | Buffer): void => {
      for (const ch of chunk.toString()) {
        if (escape === 1) {
          escape = ch === '[' || ch === 'O' ? 2 : 0;
          continue;
        }
        if (escape === 2) {
          if (ch >= '@' && ch <= '~') escape = 0;
          continue;
        }
        if (ch === '\r' || ch === '\n') return finish(null);
        if (ch === '\u0003') return finish(new PasswordCommandError('Cancelled. Nothing was changed.'));
        if (ch === '\u001b') {
          escape = 1;
          continue;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
      }
    };
    io.stdin.setEncoding('utf8');
    io.stdin.setRawMode?.(true);
    io.stdin.on('data', onData);
    io.stdin.on('end', onClosed);
    io.stdin.on('close', onClosed);
    io.stdin.on('error', onError);
    io.stdin.resume();
  });
}

/**
 * `otherbench password [--db <path>]` (spec §1): sets the sign-in password in
 * `login.json`. Works while the server runs; the server sees the new epoch
 * within a second and every device is signed out.
 */
export async function runPasswordCommand(loginPath: string, io: PasswordCommandIo, scrypt: ScryptParams = DEFAULT_SCRYPT): Promise<void> {
  let password: string;
  if (io.isTTY) {
    const first = await readHidden(io, 'New password for signing in to OtherBench: ');
    const second = await readHidden(io, 'Again: ');
    if (first !== second) throw new PasswordCommandError("The passwords don't match. Nothing was changed.");
    password = first;
  } else {
    const line = await readFirstLine(io.stdin);
    if (line === null || line === '') throw new PasswordCommandError('No password given: type it, or pipe it in on the first line.');
    password = line;
  }
  const problem = passwordProblem(password);
  if (problem) throw new PasswordCommandError(problem);
  await new PasswordFile(loginPath, Date.now, scrypt).write(password);
  io.stdout.write('Password set. Devices signed in to this server are signed out.\n');
}
