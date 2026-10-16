import { cardLine } from '@otherbench/core/domain/card-text.js';
import { MAX_TOOL_IMAGE_BYTES } from '@otherbench/core/domain/tool-images.js';

/**
 * The desktop shell's channel (spec 2026-10-12-computer-use-design section
 * 2; the wire in full is `.superpowers/sdd/2026-10-12-computer-use/
 * shell-wire-spec.md`). After the `{"port":N,"rpc":"<word>"}` announce line,
 * this server writes requests to its stdout and the shell answers on its
 * stdin: one JSON object per line, each starting `OTHERBENCH-RPC `. Only the
 * parent shell holds these pipes; there is no network surface. A server
 * started by hand has no channel.
 *
 *   server to shell   OTHERBENCH-RPC <word> {"id":<n>,"method":"<m>","params":{...}}
 *                     OTHERBENCH-RPC <word> {"method":"computer.close","params":{}}
 *   shell to server   OTHERBENCH-RPC {"id":<n>,"result":<value>}
 *                     OTHERBENCH-RPC {"id":<n>,"error":{"message":"...","code":"..."}}
 *                     OTHERBENCH-RPC {"event":"<name>","params":{...}}
 *
 * `<word>` is a random word made for this launch and told to the shell in
 * the announce line. The shell acts on no line without it, so text that
 * something else writes to this process's stdout (a dependency, a child
 * process that was handed the stream) can't pass for a request, whatever it
 * says. The shell's own lines carry no word: nothing else writes to stdin.
 *
 * The shell is trusted more than a model, and its lines are still read as
 * if they might be wrong. A line that does not start with the prefix is not
 * the channel's and is ignored. A line that does, and is not exactly a
 * message (too long, not JSON, not an object, an answer to no request or to
 * one already answered, an event in a flood) means the two ends are out of
 * step: the channel CLOSES, which ends every session (the driver's part),
 * and the shell is told so with a last `computer.close` line. Every limit:
 *
 *   - a line that does not start with the prefix is known by its first ten
 *     bytes, and none of it is held;
 *   - one line is at most `MAX_RPC_LINE_BYTES` (the largest screenshot the
 *     app keeps, as base64, and 64 KiB over). A longer one closes the channel
 *     as it arrives, so no more than that is ever held;
 *   - at most `MAX_PENDING_CALLS` ordinary calls wait for an answer; the next
 *     is refused without being written. An end of session (`priority`) is
 *     never held back by that: it has `MAX_PRIORITY_CALLS` places of its own,
 *     so Stop reaches the shell however many other calls are waiting;
 *   - every call has a time limit, after which its place is free. A note of
 *     it is kept for a while (`late`, or `LATE_GRACE_MS`), at most
 *     `MAX_LATE_NOTES` of them, so that its answer, if it still comes, is
 *     known for a late one and not taken for a protocol error;
 *   - at most `MAX_EVENTS_PER_SECOND` events a second; one more closes the
 *     channel;
 *   - every call still waiting is rejected when the channel closes, for any
 *     reason: the shell's end closed, the stream this writes to reported an
 *     error, or a frame was out of step.
 *
 * What a caller sees of a failure is a `DesktopChannelError` in this file's
 * own words. The shell's own error message is the one thing passed on, cut
 * to one clean line, with its `code` when it is one of a few plain words.
 */

export const RPC_PREFIX = 'OTHERBENCH-RPC ';

/** How long a call waits for its answer unless it brings its own limit. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** How many ordinary calls may wait for an answer at once. */
export const MAX_PENDING_CALLS = 64;

/** How many `priority` calls (ends of session) may wait at once, beside the ordinary ones. */
export const MAX_PRIORITY_CALLS = 64;

/** How many calls that timed out are remembered for a late answer. One more, and the oldest note goes. */
export const MAX_LATE_NOTES = 64;

/** How long a call that timed out is remembered, unless it asked for longer (`late`). Ten minutes is the shell's own idle limit. */
export const LATE_GRACE_MS = 600_000;

/** How many events the shell may send in one second. One more is a flood, and the channel closes. */
export const MAX_EVENTS_PER_SECOND = 100;

/**
 * The longest line read from the shell, in bytes, without its line end. The
 * one large thing the shell sends is a screenshot, and the app keeps no image
 * over `MAX_TOOL_IMAGE_BYTES`: that many bytes as base64, plus 64 KiB for the
 * rest of the message.
 */
export const MAX_RPC_LINE_BYTES = Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4 + 65_536;

/** The longest error message taken from the shell, in characters. */
const MAX_ERROR_TEXT = 300;
/** The longest event name the shell may send. */
const MAX_EVENT_NAME = 64;
/** An error `code` from the shell is kept only when it is one plain word like this. */
const ERROR_CODE = /^[a-z][a-z0-9-]{0,31}$/;

const GONE = 'The desktop app went away.';
const NOT_WRITTEN = "The request couldn't be sent to the desktop app.";
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const PREFIX_BYTES = Buffer.from(RPC_PREFIX, 'utf8');

/**
 * Why a call failed, which says whether the shell can have acted on it:
 *
 *   - `not-sent`: the request never left (the channel was closed, too many
 *     calls were waiting, or it could not be written). Nothing happened.
 *   - `shell`: the shell answered with an error, in its own words. It did
 *     not do what was asked.
 *   - `timeout`: the request was sent and no answer came in time.
 *   - `gone`: the request was sent and the channel closed first.
 *
 * After `timeout` and `gone` nobody knows whether the shell acted.
 */
export type DesktopChannelFailure = 'not-sent' | 'shell' | 'timeout' | 'gone';

export class DesktopChannelError extends Error {
  constructor(
    readonly kind: DesktopChannelFailure,
    message: string,
    /** For `shell`: the error's `code`, when the shell gave one that is a plain word (`no-session`). */
    readonly code?: string
  ) {
    super(message);
    this.name = 'DesktopChannelError';
  }
}

export interface DesktopChannelOptions {
  /** Per-call time limit unless a call passes its own (`DEFAULT_CALL_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** See `MAX_PENDING_CALLS`; tests lower it. */
  maxPending?: number;
  /** See `MAX_PRIORITY_CALLS`; tests lower it. */
  maxPriority?: number;
  /** See `MAX_RPC_LINE_BYTES`; tests lower it. */
  maxLineBytes?: number;
  /** See `MAX_EVENTS_PER_SECOND`; tests lower it. */
  maxEventsPerSecond?: number;
  /** See `LATE_GRACE_MS`; tests shorten it. */
  lateGraceMs?: number;
  /** This launch's word, written after the prefix of every request (letters and digits only). The CLI always gives one; without it requests carry the bare prefix. */
  nonce?: string;
}

export interface CallOptions {
  /** This call's own time limit. */
  timeoutMs?: number;
  /** An end of session: sent even when every ordinary place is taken. */
  priority?: boolean;
  /**
   * Asks to be handed the answer if it comes after the time limit, within
   * `forMs` of it. The call still rejects and frees its place at the limit;
   * only a note is kept. An error that comes late is not handed on: it is
   * the shell saying it did not do it.
   */
  late?: { forMs: number; answer: (result: unknown) => void };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: DesktopChannelError) => void;
  timer: NodeJS.Timeout;
  priority: boolean;
}

interface LateNote {
  answer: ((result: unknown) => void) | null;
  timer: NodeJS.Timeout;
}

/** What the driver needs of the channel; a test may stand in for it. */
export interface ShellChannel {
  readonly closed: boolean;
  call(method: string, params: unknown, options?: number | CallOptions): Promise<unknown>;
  onEvent(name: string, cb: (params: unknown) => void): () => void;
  /** Called once, when the channel closes for any reason (and at once for a channel that already has). Returns the unsubscribe. */
  onClose(cb: () => void): () => void;
}

/** Where requests go. `on` is there for a real stream, whose write errors come as an event. */
export interface ChannelOutput {
  write(chunk: string): unknown;
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DesktopChannel implements ShellChannel {
  private nextId = 1;
  private ended = false;
  private readonly pending = new Map<number, Pending>();
  private waitingOrdinary = 0;
  private waitingPriority = 0;
  private readonly late = new Map<number, LateNote>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly closeListeners = new Set<() => void>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly maxPriority: number;
  private readonly maxLineBytes: number;
  private readonly maxEvents: number;
  private readonly lateGraceMs: number;
  private readonly requestPrefix: string;
  /** The pieces of the line being read, and how many bytes they hold. */
  private parts: Buffer[] = [];
  private held = 0;
  /** How many of the line's first bytes have been checked against the prefix. */
  private checked = 0;
  /** The rest of the line being read is thrown away as it arrives: it is not a OTHERBENCH-RPC line. */
  private skipping = false;
  /** Events counted in the second that began at `eventWindow`. */
  private eventWindow = 0;
  private events = 0;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: ChannelOutput,
    options: DesktopChannelOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? MAX_PENDING_CALLS;
    this.maxPriority = options.maxPriority ?? MAX_PRIORITY_CALLS;
    this.maxLineBytes = options.maxLineBytes ?? MAX_RPC_LINE_BYTES;
    this.maxEvents = options.maxEventsPerSecond ?? MAX_EVENTS_PER_SECOND;
    this.lateGraceMs = options.lateGraceMs ?? LATE_GRACE_MS;
    if (options.nonce !== undefined && !/^[A-Za-z0-9]{1,128}$/.test(options.nonce)) throw new Error('The channel nonce must be 1 to 128 letters and digits.');
    this.requestPrefix = options.nonce !== undefined ? `${RPC_PREFIX}${options.nonce} ` : RPC_PREFIX;
    // The same stream as exitOnStdinClose (desktop.ts) listens to; both see its end.
    input.on('data', (chunk: Buffer | string) => this.read(chunk));
    const end = (): void => this.end();
    input.on('end', end);
    input.on('close', end);
    input.on('error', end);
    // A write that fails later (EPIPE: the shell stopped reading) comes as an event. Unheard, it would take the process down.
    if (typeof output.on === 'function') {
      output.on('error', (err) => {
        if (!this.ended) console.error('[otherbench-server] the pipe to the desktop app failed:', err);
        this.end();
      });
    }
  }

  /** True once the channel has closed: nothing more is sent, and nothing more is read. */
  get closed(): boolean {
    return this.ended;
  }

  /** How many calls are waiting for an answer. */
  get pendingCalls(): number {
    return this.pending.size;
  }

  /** How many calls that timed out are remembered for a late answer. */
  get lateNotes(): number {
    return this.late.size;
  }

  /** How many bytes of an unfinished line are held. Never more than the line limit. */
  get bufferedBytes(): number {
    return this.held;
  }

  /**
   * Sends one request and waits for its answer. Resolves with the shell's
   * `result` exactly as it parsed, which the caller must check: it is
   * `unknown`. Rejects with a `DesktopChannelError`, never anything else.
   * A number for `options` is the time limit.
   */
  call(method: string, params: unknown, options: number | CallOptions = {}): Promise<unknown> {
    const { timeoutMs = this.timeoutMs, priority = false, late }: CallOptions = typeof options === 'number' ? { timeoutMs: options } : options;
    if (this.ended) return Promise.reject(new DesktopChannelError('not-sent', GONE));
    if (priority ? this.waitingPriority >= this.maxPriority : this.waitingOrdinary >= this.maxPending) {
      return Promise.reject(new DesktopChannelError('not-sent', 'The desktop app has too many requests waiting; nothing was sent.'));
    }
    const id = this.nextId++;
    let line: string;
    try {
      line = `${this.requestPrefix}${JSON.stringify({ id, method, params })}\n`;
    } catch {
      return Promise.reject(new DesktopChannelError('not-sent', NOT_WRITTEN));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The answer, if it still comes, is known for a late one: handed to whoever asked for it, or dropped.
        this.settle(id);
        this.remember(id, late);
        reject(new DesktopChannelError('timeout', "The desktop app didn't answer in time."));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, priority });
      if (priority) this.waitingPriority += 1;
      else this.waitingOrdinary += 1;
      try {
        this.output.write(line);
      } catch (err) {
        this.settle(id);
        console.error('[otherbench-server] writing to the desktop app failed:', err);
        reject(new DesktopChannelError('not-sent', NOT_WRITTEN));
      }
    });
  }

  /** Listens for one of the shell's events by its exact name. `params` is `unknown`: the listener checks it. Returns the unsubscribe. */
  onEvent(name: string, cb: (params: unknown) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  onClose(cb: () => void): () => void {
    if (this.ended) {
      queueMicrotask(() => this.tell(cb));
      return () => {};
    }
    this.closeListeners.add(cb);
    return () => {
      this.closeListeners.delete(cb);
    };
  }

  /** Takes a call out of the waiting ones. The pending entry, or undefined when it was not waiting. */
  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.priority) this.waitingPriority -= 1;
    else this.waitingOrdinary -= 1;
    return pending;
  }

  private remember(id: number, late: CallOptions['late']): void {
    if (this.ended) return;
    if (this.late.size >= MAX_LATE_NOTES) {
      const oldest = this.late.keys().next();
      if (!oldest.done) this.forget(oldest.value);
    }
    const timer = setTimeout(() => this.late.delete(id), late?.forMs ?? this.lateGraceMs);
    timer.unref?.();
    this.late.set(id, { answer: late?.answer ?? null, timer });
  }

  private forget(id: number): LateNote | undefined {
    const note = this.late.get(id);
    if (note === undefined) return undefined;
    this.late.delete(id);
    clearTimeout(note.timer);
    return note;
  }

  /** Splits what arrives into lines, holding no more of one line than the limit and nothing of a line that is not for this channel. */
  private read(chunk: Buffer | string): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let from = 0;
    while (from < data.length && !this.ended) {
      const at = data.indexOf(NEWLINE, from);
      const piece = data.subarray(from, at === -1 ? data.length : at);
      if (!this.skipping && piece.length > 0) {
        if (!this.startsLikeOurs(piece)) {
          // Not a OTHERBENCH-RPC line: ignored as it arrives, without a word.
          this.skipping = true;
          this.parts = [];
          this.held = 0;
        } else if (this.held + piece.length > this.maxLineBytes) {
          this.fail(`a line from it was longer than ${this.maxLineBytes} bytes`);
          return;
        } else {
          this.parts.push(piece);
          this.held += piece.length;
        }
      }
      if (at === -1) return;
      const line = this.skipping ? null : this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.held);
      this.skipping = false;
      this.parts = [];
      this.held = 0;
      this.checked = 0;
      if (line !== null) this.receive(line);
      from = at + 1;
    }
  }

  /** Checks the next bytes of the line being read against the prefix, as far as the prefix goes. False at the first byte that differs. */
  private startsLikeOurs(piece: Buffer): boolean {
    const upTo = Math.min(piece.length, PREFIX_BYTES.length - this.checked);
    for (let i = 0; i < upTo; i += 1) {
      if (piece[i] !== PREFIX_BYTES[this.checked + i]) return false;
    }
    this.checked += Math.max(upTo, 0);
    return true;
  }

  private receive(bytes: Buffer): void {
    const end = bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN ? bytes.length - 1 : bytes.length;
    const line = bytes.toString('utf8', 0, end);
    // Shorter than the prefix (`OTHERBENCH-RPC` and nothing more): not one of the channel's lines.
    if (!line.startsWith(RPC_PREFIX)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(RPC_PREFIX.length));
    } catch {
      this.fail('a message from it was not JSON');
      return;
    }
    if (!isRecord(parsed)) {
      this.fail('a message from it was not an object');
      return;
    }
    if ('event' in parsed) {
      this.receiveEvent(parsed);
      return;
    }
    const { id } = parsed;
    const hasResult = 'result' in parsed;
    const hasError = 'error' in parsed;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || hasResult === hasError || (hasError && !isRecord(parsed['error']))) {
      this.fail('a message from it was not an answer it could read');
      return;
    }
    const pending = this.settle(id);
    if (pending === undefined) {
      // Not waiting: given up on (a note says so), or never asked, or answered already. Only the first is anybody's.
      const note = this.forget(id);
      if (note === undefined) {
        this.fail('it answered a request that was not waiting for an answer');
        return;
      }
      if (hasError || note.answer === null) return;
      try {
        note.answer(parsed['result']);
      } catch (err) {
        console.error('[otherbench-server] handling a late answer from the desktop app failed:', err);
      }
      return;
    }
    if (hasError) {
      const error = parsed['error'] as Record<string, unknown>;
      const said = cardLine(error['message'], MAX_ERROR_TEXT);
      const code = typeof error['code'] === 'string' && ERROR_CODE.test(error['code']) ? error['code'] : undefined;
      pending.reject(new DesktopChannelError('shell', said || 'The desktop app refused the request.', code));
    } else {
      pending.resolve(parsed['result']);
    }
  }

  private receiveEvent(message: Record<string, unknown>): void {
    const name = message['event'];
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_EVENT_NAME || 'id' in message) {
      this.fail('a message from it was not an event it could read');
      return;
    }
    const now = Date.now();
    if (now - this.eventWindow >= 1000) {
      this.eventWindow = now;
      this.events = 0;
    }
    this.events += 1;
    if (this.events > this.maxEvents) {
      this.fail(`it sent more than ${this.maxEvents} events in a second`);
      return;
    }
    // A name nobody listens for is ignored. `listeners` is a Map: no name the shell sends can reach anything else.
    for (const cb of [...(this.listeners.get(name) ?? [])]) {
      try {
        cb(message['params']);
      } catch (err) {
        console.error(`[otherbench-server] a desktop event listener for ${name} threw:`, err);
      }
    }
  }

  /**
   * The two ends are out of step: the channel closes. The shell is told with
   * a last line (it ends every session it holds and reads nothing more), and
   * everything waiting here is rejected. `why` is this file's own words.
   */
  private fail(why: string): void {
    if (this.ended) return;
    console.error(`[otherbench-server] closed the channel to the desktop app: ${why}.`);
    try {
      this.output.write(`${this.requestPrefix}${JSON.stringify({ method: 'computer.close', params: {} })}\n`);
    } catch {
      // It is closing anyway; the shell also ends every session when this process's pipes close.
    }
    this.end();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    // A line that was cut off is not a message.
    this.parts = [];
    this.held = 0;
    for (const id of [...this.late.keys()]) this.forget(id);
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new DesktopChannelError('gone', GONE));
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const cb of listeners) this.tell(cb);
  }

  private tell(cb: () => void): void {
    try {
      cb();
    } catch (err) {
      console.error('[otherbench-server] a desktop channel close listener threw:', err);
    }
  }
}
