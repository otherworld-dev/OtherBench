import { PassThrough } from 'node:stream';
import { FAKE_COMPUTER_APP, FAKE_PNG } from '@grunt/core/testing/fake-computer.js';
import { DesktopChannel, RPC_PREFIX, type DesktopChannelOptions } from '../../src/computer/desktop-channel.js';
import { DesktopComputerDriver, type DesktopComputerDriverOptions } from '../../src/computer/desktop-driver.js';

/**
 * A stand-in for the desktop shell, in memory: it reads the `GRUNT-RPC`
 * lines this server would write to its stdout and answers on what would be
 * its stdin. It touches nothing: no window, no key, no screen. Tests for the
 * channel's other end (`DesktopComputerDriver`, the container, the CLI) use
 * this and nothing else.
 *
 * Left alone it behaves as the real shell must (and as core's
 * `FakeComputerDriver` does): a hello drops every session; a start gives the
 * chat a session; everything else needs one. A test changes what it answers
 * through the fields below, or takes a request over altogether with
 * `override`.
 */

/** What the stand-in says to a chat that has no session. */
export const SHELL_NO_SESSION = 'Grunt is not controlling this computer for that chat.';

/** A Windows shell with computer use switched on and one shortcut registered. */
export const HELLO_ON = Object.freeze({ platform: 'win32', version: '0.1.0', available: true, shortcuts: Object.freeze(['Ctrl+Shift+Space']) });
/** The shell as it ships: computer use off. */
export const HELLO_OFF = Object.freeze({ platform: 'win32', version: '0.1.0', available: false, shortcuts: Object.freeze(['Ctrl+Shift+Space']) });

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
  /** The chats the shell holds a session for. */
  readonly sessions = new Set<string>();
  hello: unknown = HELLO_ON;
  /** What a start answers for a chat with no session (the native dialog's answer). */
  startAnswer: unknown = { ok: true };
  screenshot: unknown = { png: FAKE_PNG.toString('base64'), width: 1366, height: 768 };
  cursor: unknown = { x: 3, y: 4 };
  target: unknown = FAKE_COMPUTER_APP;
  actAnswer: unknown = { ok: true };
  endAnswer: unknown = {};
  /** Takes a request over when it returns something; `undefined` leaves it to the shell's own behaviour. */
  override: (method: string, params: Record<string, unknown>) => ShellAnswer | undefined = () => undefined;

  /** What this server writes to: its stdout. */
  readonly toShell = {
    write: (line: string): boolean => {
      this.lines.push(line);
      if (!line.startsWith(RPC_PREFIX) || !line.endsWith('\n')) throw new Error(`not a GRUNT-RPC line: ${line}`);
      const request = JSON.parse(line.slice(RPC_PREFIX.length)) as ShellRequest;
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
    const has = this.sessions.has(chatId);
    switch (method) {
      case 'computer.hello':
        // A hello is a new server on the line: the shell keeps no session from before it.
        this.sessions.clear();
        return { result: this.hello };
      case 'computer.start': {
        if (has) return { result: { ok: true } };
        const answer = this.startAnswer;
        if (typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === true) this.sessions.add(chatId);
        return { result: answer };
      }
      case 'computer.end':
        this.sessions.delete(chatId);
        return { result: this.endAnswer };
      case 'computer.screenshot':
        return has ? { result: this.screenshot } : { error: { message: SHELL_NO_SESSION } };
      case 'computer.cursor':
        return has ? { result: this.cursor } : { error: { message: SHELL_NO_SESSION } };
      case 'computer.target':
        return { result: has ? this.target : { refuse: SHELL_NO_SESSION } };
      case 'computer.act':
        return { result: has ? this.actAnswer : { ok: false, reason: SHELL_NO_SESSION } };
      default:
        return { error: { message: `The shell has no method ${method}.` } };
    }
  }
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
