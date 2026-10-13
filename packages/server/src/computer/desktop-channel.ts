import { cardLine } from '@grunt/core/domain/card-text.js';
import { MAX_TOOL_IMAGE_BYTES } from '@grunt/core/domain/tool-images.js';

/**
 * The desktop shell's channel (spec 2026-10-12-computer-use-design section
 * 2). After the `{"port":N,"rpc":"<word>"}` announce line, this server writes
 * requests to its stdout and the shell answers on its stdin: one JSON object
 * per line, each starting `GRUNT-RPC `. Only the parent shell holds these
 * pipes; there is no network surface. A server started by hand has no channel.
 *
 *   server to shell   GRUNT-RPC <word> {"id":<n>,"method":"<m>","params":{...}}
 *   shell to server   GRUNT-RPC {"id":<n>,"result":<value>}
 *                     GRUNT-RPC {"id":<n>,"error":{"message":"..."}}
 *                     GRUNT-RPC {"event":"<name>","params":{...}}
 *
 * `<word>` is a random word made for this launch and told to the shell in
 * the announce line. The shell acts on no line without it, so text that
 * something else writes to this process's stdout (a dependency, a child
 * process that was handed the stream) can't pass for a request, whatever it
 * says. The shell's own lines carry no word: nothing else writes to stdin.
 *
 * The shell is trusted more than a model, and its lines are still read as
 * if they might be wrong: a line that is not a message is dropped, an answer
 * is matched to a call that is still waiting or dropped, and nothing the
 * shell sends decides how much this process holds. Every limit is here:
 *
 *   - a line that does not start with the prefix is known by its first ten
 *     bytes, and none of it is held;
 *   - one line is at most `MAX_RPC_LINE_BYTES` (the largest screenshot the
 *     app keeps, as base64, and 64 KiB over). A longer line is dropped while
 *     it arrives, so no more than that is ever held for a line;
 *   - at most `MAX_PENDING_CALLS` ordinary calls wait for an answer; the next
 *     is refused without being written. An end of session (`priority`) is
 *     never held back by that: it has `MAX_PRIORITY_CALLS` places of its own,
 *     so Stop reaches the shell however many other calls are waiting;
 *   - every call has a time limit, after which its place is free. A call may
 *     ask to be told of an answer that comes later (`late`): a note of it is
 *     kept for the time it names, at most `MAX_LATE_NOTES` of them;
 *   - every call still waiting is rejected when the shell's end closes, or
 *     when the stream this writes to reports an error.
 *
 * What a caller sees of a failure is a `DesktopChannelError` in this file's
 * own words. The shell's own error message is the one thing passed on, cut
 * to one clean line.
 */

export const RPC_PREFIX = 'GRUNT-RPC ';

/** How long a call waits for its answer unless it brings its own limit. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** How many ordinary calls may wait for an answer at once. */
export const MAX_PENDING_CALLS = 64;

/** How many `priority` calls (ends of session) may wait at once, beside the ordinary ones. */
export const MAX_PRIORITY_CALLS = 64;

/** How many calls that timed out are remembered for a late answer. One more, and the oldest note goes. */
export const MAX_LATE_NOTES = 16;

/**
 * The longest line read from the shell, in bytes, without its line end. The
 * one large thing the shell sends is a screenshot, and the app keeps no image
 * over `MAX_TOOL_IMAGE_BYTES`: that many bytes as base64, plus 64 KiB for the
 * rest of the message.
 */
export const MAX_RPC_LINE_BYTES = Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4 + 65_536;

/** The longest error message taken from the shell, in characters. */
const MAX_ERROR_TEXT = 300;

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
 *   - `gone`: the request was sent and the shell's end closed first.
 *
 * After `timeout` and `gone` nobody knows whether the shell acted.
 */
export type DesktopChannelFailure = 'not-sent' | 'shell' | 'timeout' | 'gone';

export class DesktopChannelError extends Error {
  constructor(
    readonly kind: DesktopChannelFailure,
    message: string
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
  answer: (result: unknown) => void;
  timer: NodeJS.Timeout;
}

/** What the driver needs of the channel; a test may stand in for it. */
export interface ShellChannel {
  readonly closed: boolean;
  call(method: string, params: unknown, options?: number | CallOptions): Promise<unknown>;
  onEvent(name: string, cb: (params: unknown) => void): () => void;
}

/** Where requests go. `on` is there for a real stream, whose write errors come as an event. */
export interface ChannelOutput {
  write(chunk: string): unknown;
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

export class DesktopChannel implements ShellChannel {
  private nextId = 1;
  private ended = false;
  private readonly pending = new Map<number, Pending>();
  private waitingOrdinary = 0;
  private waitingPriority = 0;
  private readonly late = new Map<number, LateNote>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly maxPriority: number;
  private readonly maxLineBytes: number;
  private readonly requestPrefix: string;
  /** The pieces of the line being read, and how many bytes they hold. */
  private parts: Buffer[] = [];
  private held = 0;
  /** How many of the line's first bytes have been checked against the prefix. */
  private checked = 0;
  /** The rest of the line being read is thrown away as it arrives: it is too long, or not a GRUNT-RPC line. */
  private skipping = false;
  private dropped = 0;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: ChannelOutput,
    options: DesktopChannelOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? MAX_PENDING_CALLS;
    this.maxPriority = options.maxPriority ?? MAX_PRIORITY_CALLS;
    this.maxLineBytes = options.maxLineBytes ?? MAX_RPC_LINE_BYTES;
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
        if (!this.ended) console.error('[grunt-server] the pipe to the desktop app failed:', err);
        this.end();
      });
    }
  }

  /** True once the shell's end has closed: nothing more is sent, and nothing more will come. */
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

  /** How many GRUNT-RPC lines were dropped for being longer than the limit. */
  get droppedLines(): number {
    return this.dropped;
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
        // The answer, if it ever comes, finds nothing waiting: it is dropped, or handed to whoever asked for it late.
        this.settle(id);
        if (late !== undefined) this.remember(id, late);
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
        console.error('[grunt-server] writing to the desktop app failed:', err);
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

  private remember(id: number, late: { forMs: number; answer: (result: unknown) => void }): void {
    if (this.ended) return;
    if (this.late.size >= MAX_LATE_NOTES) {
      const oldest = this.late.keys().next();
      if (!oldest.done) this.forget(oldest.value);
    }
    const timer = setTimeout(() => this.late.delete(id), late.forMs);
    timer.unref?.();
    this.late.set(id, { answer: late.answer, timer });
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
    if (this.ended) return;
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let from = 0;
    while (from < data.length) {
      const at = data.indexOf(NEWLINE, from);
      const piece = data.subarray(from, at === -1 ? data.length : at);
      if (!this.skipping && piece.length > 0) {
        if (!this.startsLikeOurs(piece)) {
          // Not a GRUNT-RPC line: dropped as it arrives, without a word.
          this.skipping = true;
          this.parts = [];
          this.held = 0;
        } else if (this.held + piece.length > this.maxLineBytes) {
          this.skipping = true;
          this.parts = [];
          this.held = 0;
          this.dropped += 1;
          // Said once: a shell that keeps doing it must not fill the log.
          if (this.dropped === 1) console.error(`[grunt-server] dropped a line from the desktop app that was longer than ${this.maxLineBytes} bytes.`);
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
    if (!line.startsWith(RPC_PREFIX)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(RPC_PREFIX.length));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const message = parsed as { id?: unknown; result?: unknown; error?: unknown; event?: unknown; params?: unknown };
    if (typeof message.event === 'string') {
      const name = message.event;
      // A name nobody listens for is ignored. `listeners` is a Map: no name the shell sends can reach anything else.
      for (const cb of [...(this.listeners.get(name) ?? [])]) {
        try {
          cb(message.params);
        } catch (err) {
          console.error(`[grunt-server] a desktop event listener for ${name} threw:`, err);
        }
      }
      return;
    }
    if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) return;
    const failed = message.error !== undefined && message.error !== null;
    const pending = this.settle(message.id);
    if (pending === undefined) {
      // An id nobody is waiting on: never sent, already answered, or given up on. Only a note left for it makes it anybody's.
      const note = this.forget(message.id);
      if (note === undefined || failed) return;
      try {
        note.answer(message.result);
      } catch (err) {
        console.error('[grunt-server] handling a late answer from the desktop app failed:', err);
      }
      return;
    }
    if (failed) {
      const said = typeof message.error === 'object' ? cardLine((message.error as { message?: unknown }).message, MAX_ERROR_TEXT) : '';
      pending.reject(new DesktopChannelError('shell', said || 'The desktop app refused the request.'));
    } else {
      pending.resolve(message.result);
    }
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    // A line that was cut off is not a message.
    this.parts = [];
    this.held = 0;
    for (const id of [...this.late.keys()]) this.forget(id);
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new DesktopChannelError('gone', GONE));
  }
}
