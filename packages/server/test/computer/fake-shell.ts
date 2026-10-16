import { PassThrough } from 'node:stream';
import { crc32 } from 'node:zlib';
import { FAKE_COMPUTER_APP, FAKE_PNG } from '@otherbench/core/testing/fake-computer.js';
import { DesktopChannel, RPC_PREFIX, type DesktopChannelOptions } from '../../src/computer/desktop-channel.js';
import { DesktopComputerDriver, type DesktopComputerDriverOptions } from '../../src/computer/desktop-driver.js';

/**
 * A stand-in for the desktop shell, in memory: it reads the `OTHERBENCH-RPC`
 * lines this server would write to its stdout and answers on what would be
 * its stdin. It touches nothing: no window, no key, no screen. Tests for the
 * channel's other end (`DesktopComputerDriver`, the container, the CLI) use
 * this and nothing else.
 *
 * Left alone it behaves as the real shell must (shell-wire-spec.md, and as
 * core's `FakeComputerDriver` does): a hello drops every session; a start's
 * yes gives the chat a session and a fresh token; everything else needs the
 * chat's live token, or is answered with the `no-session` error; a
 * `computer.close` line ends every session. A test changes what it answers
 * through the fields below, or takes a request over altogether with
 * `override`.
 */

/** What the stand-in says to a chat that has no session, or names one that is not its live one. */
export const SHELL_NO_SESSION = 'OtherBench is not controlling this computer for that chat.';

let minted = 0;
/** A fresh session token, as the shell mints one: never reused. */
export function mintToken(): string {
  minted += 1;
  return `session_${String(minted).padStart(8, '0')}_fake`;
}

/** The chats the stand-in holds a session for, each with its token. `add` mints one. */
export class ShellSessions extends Map<string, string> {
  add(chatId: string, token = mintToken()): this {
    return this.set(chatId, token);
  }
}

/** A Windows shell with computer use switched on, one shortcut registered, and no session held. */
export const HELLO_ON = Object.freeze({ platform: 'win32', version: '0.1.0', available: true, shortcuts: Object.freeze(['Ctrl+Shift+Space']), sessions: 0 });
/** The shell as it ships: computer use off. */
export const HELLO_OFF = Object.freeze({ platform: 'win32', version: '0.1.0', available: false, shortcuts: Object.freeze(['Ctrl+Shift+Space']), sessions: 0 });

/**
 * `FAKE_PNG` with another size written into its header (and the header's
 * checksum to match): the bytes of a screenshot that says it is `width` by
 * `height`. Nothing is drawn and nothing is captured.
 */
export function pngOf(width: number, height: number, bytes = FAKE_PNG.length): Buffer {
  const png = Buffer.alloc(Math.max(bytes, FAKE_PNG.length));
  FAKE_PNG.copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  return png;
}

/** A screenshot answer of that size. */
export function shotOf(width: number, height: number): { png: string; width: number; height: number } {
  return { png: pngOf(width, height).toString('base64'), width, height };
}

/** `'silent'`: the request is read and never answered (the test may answer it later with `answer`). */
export type ShellAnswer = { result: unknown } | { error: unknown } | 'silent';

export interface ShellRequest {
  id: number;
  method: string;
  params: unknown;
}

export class FakeShell {
  /** What the shell writes: this server's stdin. */
  readonly fromShell = new PassThrough();
  /** Every line this server wrote, exactly as written. */
  readonly lines: string[] = [];
  /** Every request, parsed, in the order it arrived. */
  readonly asked: ShellRequest[] = [];
  /** The chats the shell holds a session for, with the token it gave each. */
  readonly sessions = new ShellSessions();
  /** Notifications (lines with no id) this server wrote, such as `computer.close`. */
  readonly notified: { method: string; params: unknown }[] = [];
  /** This launch's word, when the channel writes one after the prefix. */
  nonce: string | null = null;
  hello: unknown = HELLO_ON;
  /** What a start answers for a chat with no session (the native dialog's answer). */
  startAnswer: unknown = { ok: true };
  screenshot: unknown = shotOf(1366, 768);
  cursor: unknown = { x: 3, y: 4 };
  target: unknown = FAKE_COMPUTER_APP;
  actAnswer: unknown = { ok: true };
  endAnswer: unknown = { ok: true };
  /** Takes a request over when it returns something; `undefined` leaves it to the shell's own behaviour. */
  override: (method: string, params: Record<string, unknown>) => ShellAnswer | undefined = () => undefined;

  private readonly pipeErrors: ((err: Error) => void)[] = [];

  /** What this server writes to: its stdout. Its write errors come as an event, as a real pipe's do. */
  readonly toShell = {
    on: (event: 'error', listener: (err: Error) => void): void => {
      if (event === 'error') this.pipeErrors.push(listener);
    },
    write: (line: string): boolean => {
      this.lines.push(line);
      if (!line.startsWith(RPC_PREFIX) || !line.endsWith('\n')) throw new Error(`not a OTHERBENCH-RPC line: ${line}`);
      let body = line.slice(RPC_PREFIX.length);
      if (this.nonce !== null) {
        if (!body.startsWith(`${this.nonce} `)) throw new Error(`a OTHERBENCH-RPC line without this launch's word: ${line}`);
        body = body.slice(this.nonce.length + 1);
      }
      const request = JSON.parse(body) as ShellRequest;
      if (request.id === undefined) {
        // A notification. `computer.close`: the server is done with this channel, and the shell ends every session.
        this.notified.push({ method: request.method, params: request.params });
        if (request.method === 'computer.close') this.sessions.clear();
        return true;
      }
      this.asked.push(request);
      const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
      const answer = this.override(request.method, params) ?? this.behave(request.method, params);
      if (answer !== 'silent') queueMicrotask(() => this.send({ id: request.id, ...answer }));
      return true;
    },
  };

  /** Writes one message to this server, as the shell would. */
  send(body: unknown): void {
    if (!this.fromShell.writableEnded) this.fromShell.write(`${RPC_PREFIX}${JSON.stringify(body)}\n`);
  }

  event(name: string, params: unknown): void {
    this.send({ event: name, params });
  }

  /** Answers a request that was left `'silent'`. */
  answer(id: number, result: unknown): void {
    this.send({ id, result });
  }

  /** The shell exits: this server's stdin ends. */
  close(): void {
    this.fromShell.end();
  }

  /** The shell stops reading: a write to it fails later, as EPIPE does. */
  breakPipe(): void {
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    for (const listener of this.pipeErrors) listener(err);
  }

  /** The token of the chat's live session, or undefined. */
  tokenOf(chatId: string): string | undefined {
    return this.sessions.get(chatId);
  }

  /** The parameters of every request for `method`, in order. */
  sent(method: string): unknown[] {
    return this.asked.filter((r) => r.method === method).map((r) => r.params);
  }

  methods(): string[] {
    return this.asked.map((r) => r.method);
  }

  /** The id of the last request for `method`. */
  idOf(method: string): number {
    const found = this.asked.filter((r) => r.method === method).at(-1);
    if (!found) throw new Error(`no ${method} request was sent`);
    return found.id;
  }

  private behave(method: string, params: Record<string, unknown>): ShellAnswer {
    const chatId = String(params['chatId']);
    // A request names the chat's live session by its token; anything else is no session at all.
    const has = this.sessions.has(chatId) && params['session'] === this.sessions.get(chatId);
    const noSession = { error: { message: SHELL_NO_SESSION, code: 'no-session' } };
    switch (method) {
      case 'computer.hello':
        // A hello is a new server on the line: the shell keeps no session from before it.
        this.sessions.clear();
        return { result: this.hello };
      case 'computer.start': {
        const live = this.sessions.get(chatId);
        if (live !== undefined) return { result: { ok: true, session: live } };
        const answer = this.startAnswer;
        if (typeof answer !== 'object' || answer === null || (answer as { ok?: unknown }).ok !== true) return { result: answer };
        // A yes mints the session's token, unless the test set one (or a wrong one) itself.
        const token = 'session' in answer ? (answer as { session?: unknown }).session : mintToken();
        this.sessions.set(chatId, String(token));
        return { result: { ...answer, session: token } };
      }
      case 'computer.end':
        this.sessions.delete(chatId);
        return { result: this.endAnswer };
      case 'computer.screenshot':
        return has ? { result: this.screenshot } : noSession;
      case 'computer.cursor':
        return has ? { result: this.cursor } : noSession;
      case 'computer.target':
        return has ? { result: this.target } : noSession;
      case 'computer.act':
        return has ? { result: this.actAnswer } : noSession;
      default:
        return { error: { message: `The shell has no method ${method}.` } };
    }
  }
}

/** The chat of every `computer.end` the shell was sent, in order. */
export function endedChats(shell: FakeShell): string[] {
  return shell.sent('computer.end').map((p) => (p as { chatId: string }).chatId);
}

export interface Connected {
  shell: FakeShell;
  channel: DesktopChannel;
  driver: DesktopComputerDriver;
}

/** A driver on a channel to a stand-in shell that has not been said hello to yet. */
export function connect(options: { driver?: DesktopComputerDriverOptions; channel?: DesktopChannelOptions; shell?: FakeShell } = {}): Connected {
  const shell = options.shell ?? new FakeShell();
  const channel = new DesktopChannel(shell.fromShell, shell.toShell, options.channel);
  const driver = new DesktopComputerDriver(channel, options.driver);
  return { shell, channel, driver };
}

/** The same, after the hello: the shell said computer use is on. */
export async function connected(options: { driver?: DesktopComputerDriverOptions; channel?: DesktopChannelOptions; shell?: FakeShell } = {}): Promise<Connected> {
  const made = connect(options);
  await made.driver.hello();
  return made;
}
