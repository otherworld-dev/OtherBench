import { cardLine } from '@grunt/core/domain/card-text.js';
import { MAX_TOOL_IMAGE_BYTES } from '@grunt/core/domain/tool-images.js';

/**
 * The desktop shell's channel (spec 2026-10-12-computer-use-design section
 * 2). After the `{"port":N}` announce line, this server writes requests to
 * its stdout and the shell answers on its stdin: one JSON object per line,
 * each starting `GRUNT-RPC `, so a stray write by a dependency can't be
 * mistaken for one. Only the parent shell holds these pipes; there is no
 * network surface. A server started by hand has no channel.
 *
 *   server to shell   GRUNT-RPC {"id":<n>,"method":"<m>","params":{...}}
 *   shell to server   GRUNT-RPC {"id":<n>,"result":<value>}
 *                     GRUNT-RPC {"id":<n>,"error":{"message":"..."}}
 *                     GRUNT-RPC {"event":"<name>","params":{...}}
 *
 * The shell is trusted more than a model, and its lines are still read as
 * if they might be wrong: a line that is not a message is dropped, an answer
 * is matched to a call that is still waiting or dropped, and nothing the
 * shell sends decides how much this process holds. Every limit is here:
 *
 *   - one line is at most `MAX_RPC_LINE_BYTES` (the largest screenshot the
 *     app keeps, as base64, and 64 KiB over). A longer line is dropped while
 *     it arrives, so no more than that is ever held for a line;
 *   - at most `MAX_PENDING_CALLS` calls wait for an answer; the next is
 *     refused without being written;
 *   - every call has a time limit, and every call still waiting is rejected
 *     when the shell's end closes.
 *
 * What a caller sees of a failure is a `DesktopChannelError` in this file's
 * own words. The shell's own error message is the one thing passed on, cut
 * to one clean line.
 */

export const RPC_PREFIX = 'GRUNT-RPC ';

/** How long a call waits for its answer unless it brings its own limit. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** How many calls may wait for an answer at once. */
export const MAX_PENDING_CALLS = 64;

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
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

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
  /** See `MAX_RPC_LINE_BYTES`; tests lower it. */
  maxLineBytes?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: DesktopChannelError) => void;
  timer: NodeJS.Timeout;
}

/** What the driver needs of the channel; a test may stand in for it. */
export interface ShellChannel {
  readonly closed: boolean;
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  onEvent(name: string, cb: (params: unknown) => void): () => void;
}

export class DesktopChannel implements ShellChannel {
  private nextId = 1;
  private ended = false;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly maxLineBytes: number;
  /** The pieces of the line being read, and how many bytes they hold. */
  private parts: Buffer[] = [];
  private held = 0;
  /** The line being read is already too long: the rest of it is thrown away as it arrives. */
  private skipping = false;
  private dropped = 0;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: { write(chunk: string): unknown },
    options: DesktopChannelOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? MAX_PENDING_CALLS;
    this.maxLineBytes = options.maxLineBytes ?? MAX_RPC_LINE_BYTES;
    // The same stream as exitOnStdinClose (desktop.ts) listens to; both see its end.
    input.on('data', (chunk: Buffer | string) => this.read(chunk));
    const end = (): void => this.end();
    input.on('end', end);
    input.on('close', end);
    input.on('error', end);
  }

  /** True once the shell's end has closed: nothing more is sent, and nothing more will come. */
  get closed(): boolean {
    return this.ended;
  }

  /** How many calls are waiting for an answer. */
  get pendingCalls(): number {
    return this.pending.size;
  }

  /** How many bytes of an unfinished line are held. Never more than the line limit. */
  get bufferedBytes(): number {
    return this.held;
  }

  /** How many lines were dropped for being longer than the limit. */
  get droppedLines(): number {
    return this.dropped;
  }

  /**
   * Sends one request and waits for its answer. Resolves with the shell's
   * `result` exactly as it parsed, which the caller must check: it is
   * `unknown`. Rejects with a `DesktopChannelError`, never anything else.
   */
  call(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.ended) return Promise.reject(new DesktopChannelError('not-sent', GONE));
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new DesktopChannelError('not-sent', 'The desktop app has too many requests waiting; nothing was sent.'));
    }
    const id = this.nextId++;
    let line: string;
    try {
      line = `${RPC_PREFIX}${JSON.stringify({ id, method, params })}\n`;
    } catch {
      return Promise.reject(new DesktopChannelError('not-sent', "The request couldn't be sent to the desktop app."));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The answer, if it ever comes, finds nothing waiting and is dropped.
        this.pending.delete(id);
        reject(new DesktopChannelError('timeout', "The desktop app didn't answer in time."));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.output.write(line);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        console.error('[grunt-server] writing to the desktop app failed:', err);
        reject(new DesktopChannelError('not-sent', "The request couldn't be sent to the desktop app."));
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

  /** Splits what arrives into lines, holding no more of one line than the limit. */
  private read(chunk: Buffer | string): void {
    if (this.ended) return;
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let from = 0;
    while (from < data.length) {
      const at = data.indexOf(NEWLINE, from);
      const piece = data.subarray(from, at === -1 ? data.length : at);
      if (!this.skipping) {
        if (this.held + piece.length > this.maxLineBytes) {
          this.skipping = true;
          this.parts = [];
          this.held = 0;
          this.dropped += 1;
          // Said once: a shell that keeps doing it must not fill the log.
          if (this.dropped === 1) console.error(`[grunt-server] dropped a line from the desktop app that was longer than ${this.maxLineBytes} bytes.`);
        } else if (piece.length > 0) {
          this.parts.push(piece);
          this.held += piece.length;
        }
      }
      if (at === -1) return;
      if (this.skipping) {
        this.skipping = false;
      } else {
        const line = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.held);
        this.parts = [];
        this.held = 0;
        this.receive(line);
      }
      from = at + 1;
    }
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
    // An id nobody is waiting on: never sent, already answered, or given up on.
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined && message.error !== null) {
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
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new DesktopChannelError('gone', GONE));
    }
    this.pending.clear();
  }
}
