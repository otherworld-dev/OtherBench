import { cardLine } from '@grunt/core/domain/card-text.js';
import { COMPUTER_LIMITS } from '@grunt/core/domain/computer-apps.js';
import { validateToolImage } from '@grunt/core/domain/tool-images.js';
import type {
  ComputerAction,
  ComputerAnswer,
  ComputerDriver,
  ComputerExpectation,
  ComputerRefusal,
  ComputerScreenshot,
  ComputerStopReason,
  ComputerTarget,
} from '@grunt/core/ports/computer.js';
import { DEFAULT_CALL_TIMEOUT_MS, DesktopChannelError, type ShellChannel } from './desktop-channel.js';
import { COMPUTER_NO_SESSION_REASON } from './sessions.js';

/** `computer.start` waits on a person at the shell's native dialog: how long before this side gives up on it. */
export const START_TIMEOUT_MS = 120_000;
/**
 * How long after giving up on a start its answer is still listened for, so
 * that a yes which comes late is ended and not left as a session nobody is
 * watching. Ten minutes is the shell's own idle limit: a session older than
 * that has ended by itself.
 */
export const START_LATE_WATCH_MS = 600_000;
/** How long the shell gets to confirm an end. Under `COMPUTER_END_TIMEOUT_MS` (sessions.ts), so this side's own answer is the one `ComputerSessions` sees. */
export const END_TIMEOUT_MS = 4000;
/** How long the shell gets to carry out one action (4000 typed characters, checked every 20, is the long one). */
export const ACT_TIMEOUT_MS = 60_000;
/** How many chats this side keeps a record for (a session, a start in flight, an end the shell has not confirmed). One chat controls the computer at a time, so this is never near. */
export const MAX_TRACKED_CHATS = 64;
/** A shortcut list longer than this, or with a longer entry, is not taken as a list. */
export const MAX_SHORTCUTS = 64;
export const MAX_SHORTCUT_LENGTH = 256;

/** The longest text taken from the shell into a reason, in characters. */
const MAX_REASON = 300;
/** The longest chat id taken from one of the shell's events. */
const MAX_CHAT_ID = 128;

export const DESKTOP_NOT_AVAILABLE_REASON = "Computer use isn't available in the desktop app right now.";
export const DESKTOP_GONE_REASON = 'The desktop app went away.';
/** What a point is refused with while the chat's session has no screenshot of its own. */
export const DESKTOP_NO_SCREENSHOT_REASON = 'Take a screenshot first: this control session has not taken one yet.';
/** What a point that is not inside the session's last screenshot is refused with. */
export const DESKTOP_OUTSIDE_REASON = 'That point is not inside the last screenshot. Take a screenshot and try again.';

const TOO_MANY_REASON = 'Grunt is keeping track of too many control sessions; stop one first.';
const START_TIMEOUT_REASON = "The desktop app didn't answer the request to control this computer in time, so nothing was started.";
const START_UNREADABLE_REASON = "The desktop app's answer couldn't be read, so nothing was started.";
const START_RESET_REASON = 'The desktop app started over while Grunt was asking, so nothing was started.';
const START_REFUSED_REASON = 'The desktop app refused to start controlling this computer.';
const START_UNCONFIRMED = "Grunt couldn't confirm that the desktop app cancelled it.";
const END_GONE_REASON = 'The desktop app went away before it confirmed that the control session ended.';
const END_REFUSED_REASON = "The desktop app couldn't end the control session.";
const END_UNREADABLE_REASON = "The desktop app's answer couldn't be read, so Grunt can't tell whether the control session ended.";
const ACT_REFUSED_REASON = 'The desktop app refused the action.';
const ACT_NOT_AN_ACTION_REASON = 'That is not an action Grunt can send.';
const ACT_UNREADABLE_REASON = "The desktop app's answer couldn't be read.";
const ACT_UNKNOWN = 'Whether the action was carried out is not known.';
const SCREENSHOT_UNREADABLE_REASON = "The desktop app's screenshot couldn't be read.";
const CURSOR_UNREADABLE_REASON = "The cursor's position couldn't be read.";
const UNREACHABLE_REASON = "The desktop app couldn't be reached.";

const STOP_REASONS: readonly string[] = ['hotkey', 'button', 'idle', 'quit'];

export interface DesktopComputerDriverOptions {
  /** See `START_TIMEOUT_MS`; tests shorten it. */
  startTimeoutMs?: number;
  /** See `START_LATE_WATCH_MS`; tests shorten it. */
  startLateMs?: number;
  /** See `END_TIMEOUT_MS`; tests shorten it. */
  endTimeoutMs?: number;
  /** See `ACT_TIMEOUT_MS`; tests shorten it. */
  actTimeoutMs?: number;
  /** The limit for hello, a screenshot, the cursor and a target (`DEFAULT_CALL_TIMEOUT_MS`); tests shorten it. */
  callTimeoutMs?: number;
}

/** What this side knows of a chat's session: whether it has taken a screenshot, and how big the last one was. */
interface Session {
  shot: { width: number; height: number } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const refusal = (reason: string): ComputerAnswer => ({ ok: false, reason });

/** A failed call in clean words: the channel's own, or the shell's error as the channel bounded it. Never the cause itself. */
function failureText(err: unknown): string {
  return err instanceof DesktopChannelError ? err.message : UNREACHABLE_REASON;
}

/** After these nobody knows whether the shell acted on the request. */
function outcomeUnknown(err: unknown): boolean {
  return !(err instanceof DesktopChannelError) || err.kind === 'timeout' || err.kind === 'gone';
}

/** The shell's shortcut list when it is one: an array of strings of a sane size, copied and frozen. Anything else is no list. */
function shortcutList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SHORTCUTS) return null;
  const list: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || entry.length > MAX_SHORTCUT_LENGTH) return null;
    list.push(entry);
  }
  return Object.freeze(list);
}

/** A chat id from the shell that is safe to hand on and to log: one short clean line, exactly as sent. */
function isChatId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CHAT_ID && cardLine(value, MAX_CHAT_ID) === value;
}

/** Why a point may not be used in this session, or null: it has to be two whole numbers inside the session's own last screenshot. */
function pointRefusal(session: Session, x: unknown, y: unknown): string | null {
  if (session.shot === null) return DESKTOP_NO_SCREENSHOT_REASON;
  const inside = (v: unknown, size: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < size;
  return inside(x, session.shot.width) && inside(y, session.shot.height) ? null : DESKTOP_OUTSIDE_REASON;
}

/**
 * `ComputerDriver` over the desktop shell's channel (spec
 * 2026-10-12-computer-use-design section 2): the server's end of the calls
 * the shell carries out. Facts in, facts out. It decides nothing about apps,
 * keys or risk, describes nothing and repairs nothing: an action and an
 * expectation go to the shell exactly as handed, and what the shell says a
 * target is comes back exactly as sent, missing and mistyped facts included,
 * so that core (`classifyTarget`) is what refuses or asks every time.
 *
 * What it does own is the line itself, and there it fails closed:
 *
 *   - It is available only after the shell said hello from Windows with
 *     computer use on, and only while the channel is open. A shell that has
 *     not said so is sent nothing but the hello (and an end, when this side
 *     has something on record to end).
 *   - The shell's shortcuts are the last list it reported (the hello, then
 *     each `computer.shortcuts` event). No list, a list that can't be read,
 *     or a closed channel is `null`, never an empty list.
 *   - A start always settles. A dialog nobody answers in `START_TIMEOUT_MS`
 *     is given up on: the shell is told to end that chat's start, and a yes
 *     that comes later is ended again. When nobody can say what came of a
 *     start and the shell won't confirm the end either, it throws, so that
 *     `ComputerSessions` holds every other start back until an end succeeds.
 *   - An end is asked of the shell every time (it is a no-op there for a
 *     chat with no session) and rejects unless the shell confirmed it. This
 *     side forgets the chat's session first, before the shell answers.
 *   - It keeps, per chat, whether the session has a screenshot of its own
 *     and how big it was, and refuses a point without one or outside it:
 *     the tool's own memory of the size can be stale.
 *   - Every answer is checked for its shape before it is used, and every
 *     failure is told in this file's own words (or the shell's error as one
 *     bounded line), never the channel's internals.
 *   - A hello the shell answers means a shell that holds no session (it
 *     drops them all when it reads one): this side's records go, and
 *     `onReset` listeners are told (`ComputerSessions`).
 */
export class DesktopComputerDriver implements ComputerDriver {
  private ready = false;
  private shortcuts: readonly string[] | null = null;
  /** Counts hellos the shell answered: a start asked before one is not a session after it. */
  private epoch = 0;
  /** Chats the shell said yes to and has not ended since. */
  private readonly sessions = new Map<string, Session>();
  /** Chats with a start the shell has not answered yet, and how many. */
  private readonly starting = new Map<string, number>();
  /** Chats the shell may still hold something for: an end it did not confirm. */
  private readonly doubtful = new Set<string>();
  private readonly stoppedListeners = new Set<(chatId: string, why: ComputerStopReason) => void>();
  private readonly resetListeners = new Set<() => void>();
  private readonly startTimeoutMs: number;
  private readonly startLateMs: number;
  private readonly endTimeoutMs: number;
  private readonly actTimeoutMs: number;
  private readonly callTimeoutMs: number;

  constructor(
    private readonly channel: ShellChannel,
    options: DesktopComputerDriverOptions = {}
  ) {
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.startLateMs = options.startLateMs ?? START_LATE_WATCH_MS;
    this.endTimeoutMs = options.endTimeoutMs ?? END_TIMEOUT_MS;
    this.actTimeoutMs = options.actTimeoutMs ?? ACT_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    channel.onEvent('computer.stopped', (params) => this.shellStopped(params));
    channel.onEvent('computer.shortcuts', (params) => {
      // The whole list or none: a list that can't be read is not filtered down to the part that can.
      this.shortcuts = isRecord(params) ? shortcutList(params['shortcuts']) : null;
    });
  }

  /**
   * Asks the shell what it offers. Called once, after the announce line; it
   * may be called again. Never throws. An answer means the shell holds no
   * session any more (it drops them all on a hello), so this side's records
   * go and the reset listeners are told.
   */
  async hello(): Promise<void> {
    let answer: unknown;
    try {
      answer = await this.channel.call('computer.hello', {}, this.callTimeoutMs);
    } catch {
      answer = null;
    }
    if (!isRecord(answer)) {
      this.ready = false;
      this.shortcuts = null;
      return;
    }
    this.epoch += 1;
    this.sessions.clear();
    this.doubtful.clear();
    this.ready = answer['available'] === true && answer['platform'] === 'win32';
    this.shortcuts = shortcutList(answer['shortcuts']);
    for (const cb of [...this.resetListeners]) {
      try {
        cb();
      } catch (err) {
        console.error('[grunt-server] a computer-use reset listener failed:', err);
      }
    }
  }

  available(): boolean {
    try {
      return this.ready && this.channel.closed === false;
    } catch {
      return false;
    }
  }

  reservedKeys(): readonly string[] | null {
    try {
      return this.channel.closed === false ? this.shortcuts : null;
    } catch {
      return null;
    }
  }

  async ensureSession(chatId: string, chatTitle: string): Promise<ComputerAnswer> {
    const off = this.unusable();
    if (off !== null) return refusal(off);
    if (!this.tracked(chatId) && this.sessions.size + this.starting.size + this.doubtful.size >= MAX_TRACKED_CHATS) return refusal(TOO_MANY_REASON);

    const epoch = this.epoch;
    this.starting.set(chatId, (this.starting.get(chatId) ?? 0) + 1);
    // The channel goes on listening after this side has given up, so a late answer is still seen (`lateStart`).
    const asked = this.channel.call('computer.start', { chatId, title: chatTitle }, this.startTimeoutMs + this.startLateMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    type Outcome = { kind: 'answer'; value: unknown } | { kind: 'failed'; err: unknown } | { kind: 'timeout' };
    const outcome = await Promise.race<Outcome>([
      asked.then(
        (value): Outcome => ({ kind: 'answer', value }),
        (err: unknown): Outcome => ({ kind: 'failed', err })
      ),
      new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), this.startTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const left = (this.starting.get(chatId) ?? 1) - 1;
    if (left > 0) this.starting.set(chatId, left);
    else this.starting.delete(chatId);

    if (outcome.kind === 'timeout') {
      void asked.then(
        (late) => this.lateStart(chatId, late),
        () => {}
      );
      return this.startUnknown(chatId, START_TIMEOUT_REASON);
    }
    if (outcome.kind === 'failed') {
      if (outcomeUnknown(outcome.err)) return this.startUnknown(chatId, failureText(outcome.err));
      // The shell said no in its own words, or the request never left: there is no session to end.
      if (outcome.err instanceof DesktopChannelError && outcome.err.kind === 'shell') this.sessions.delete(chatId);
      return refusal(failureText(outcome.err));
    }
    const answer = outcome.value;
    if (isRecord(answer) && answer['ok'] === true) {
      if (epoch !== this.epoch) return this.startUnknown(chatId, START_RESET_REASON);
      if (!this.sessions.has(chatId)) this.sessions.set(chatId, { shot: null });
      return { ok: true };
    }
    if (isRecord(answer) && answer['ok'] === false) {
      this.sessions.delete(chatId);
      return refusal(cardLine(answer['reason'], MAX_REASON) || START_REFUSED_REASON);
    }
    return this.startUnknown(chatId, START_UNREADABLE_REASON);
  }

  /**
   * Tells the shell to end the chat's session (it releases what it pressed,
   * and cancels a start whose dialog is still up). This side's record goes
   * first. Rejects unless the shell confirmed. With nothing on record for
   * the chat and no shell to ask (the channel closed, or the shell never
   * said computer use is on), there is nothing to end and it resolves.
   */
  async endSession(chatId: string): Promise<void> {
    await this.end(chatId);
  }

  async screenshot(chatId: string): Promise<ComputerScreenshot> {
    const session = this.sessionOf(chatId);
    // Whatever comes back, the shell's last screenshot is no longer the one this side knew the size of.
    session.shot = null;
    let answer: unknown;
    try {
      answer = await this.channel.call('computer.screenshot', { chatId }, this.callTimeoutMs);
    } catch (err) {
      throw new Error(failureText(err));
    }
    if (!isRecord(answer)) throw new Error(SCREENSHOT_UNREADABLE_REASON);
    const { png, width, height } = answer;
    const size = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= COMPUTER_LIMITS.coordinateMax;
    if (typeof png !== 'string' || !size(width) || !size(height)) throw new Error(SCREENSHOT_UNREADABLE_REASON);
    // Core's one test for an image from a tool: strict base64, at most 5 MB, the type read from the bytes.
    const image = validateToolImage({ type: 'image', data: png, mimeType: 'image/png' });
    if (!image.ok || image.mime !== 'image/png') throw new Error(SCREENSHOT_UNREADABLE_REASON);
    // The session ended while the shell was taking it: it is nobody's to look at.
    if (this.sessions.get(chatId) !== session) throw new Error(COMPUTER_NO_SESSION_REASON);
    session.shot = { width, height };
    return { png: image.bytes, width, height };
  }

  async cursorPosition(chatId: string): Promise<{ x: number; y: number }> {
    const session = this.sessionOf(chatId);
    let answer: unknown;
    try {
      answer = await this.channel.call('computer.cursor', { chatId }, this.callTimeoutMs);
    } catch (err) {
      throw new Error(failureText(err));
    }
    if (!isRecord(answer)) throw new Error(CURSOR_UNREADABLE_REASON);
    const { x, y } = answer;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error(CURSOR_UNREADABLE_REASON);
    if (this.sessions.get(chatId) !== session) throw new Error(COMPUTER_NO_SESSION_REASON);
    return { x, y };
  }

  /**
   * What the shell says is under a point, or in the foreground, EXACTLY as
   * it said it: not one fact is defaulted, coerced, added or dropped here.
   * The port's type is what the shell is supposed to send, not something
   * this method has checked; core's `classifyTarget` takes it as `unknown`.
   */
  async target(chatId: string, at: { x: number; y: number } | 'foreground'): Promise<ComputerTarget | ComputerRefusal> {
    const off = this.unusable();
    if (off !== null) return { refuse: off };
    const session = this.sessions.get(chatId);
    if (session === undefined) return { refuse: COMPUTER_NO_SESSION_REASON };
    let params: Record<string, unknown>;
    if (at === 'foreground') {
      params = { chatId, foreground: true };
    } else {
      const point: { x?: unknown; y?: unknown } = isRecord(at) ? at : {};
      const why = pointRefusal(session, point.x, point.y);
      if (why !== null) return { refuse: why };
      params = { chatId, x: point.x, y: point.y };
    }
    let answer: unknown;
    try {
      answer = await this.channel.call('computer.target', params, this.callTimeoutMs);
    } catch (err) {
      throw new Error(failureText(err));
    }
    if (this.sessions.get(chatId) !== session) return { refuse: COMPUTER_NO_SESSION_REASON };
    return answer as ComputerTarget | ComputerRefusal;
  }

  async act(chatId: string, action: ComputerAction, expect: ComputerExpectation): Promise<ComputerAnswer> {
    const off = this.unusable();
    if (off !== null) return refusal(off);
    const session = this.sessions.get(chatId);
    if (session === undefined) return refusal(COMPUTER_NO_SESSION_REASON);
    if (!isRecord(action)) return refusal(ACT_NOT_AN_ACTION_REASON);
    if ('coordinate' in action) {
      const point: unknown = action['coordinate'];
      const [x, y]: unknown[] = Array.isArray(point) && point.length === 2 ? point : [];
      const why = pointRefusal(session, x, y);
      if (why !== null) return refusal(why);
    }
    let answer: unknown;
    try {
      // The action and the expectation as handed: this side adds nothing to them and takes nothing away.
      answer = await this.channel.call('computer.act', { chatId, action, expect }, this.actTimeoutMs);
    } catch (err) {
      return refusal(outcomeUnknown(err) ? `${failureText(err)} ${ACT_UNKNOWN}` : failureText(err));
    }
    if (isRecord(answer) && answer['ok'] === true) return { ok: true };
    if (isRecord(answer) && answer['ok'] === false) return refusal(cardLine(answer['reason'], MAX_REASON) || ACT_REFUSED_REASON);
    return refusal(`${ACT_UNREADABLE_REASON} ${ACT_UNKNOWN}`);
  }

  onStopped(cb: (chatId: string, why: ComputerStopReason) => void): () => void {
    this.stoppedListeners.add(cb);
    return () => {
      this.stoppedListeners.delete(cb);
    };
  }

  /**
   * The shell answered a hello: it holds no session at all, whatever this
   * server had on record (an end it never confirmed, a session it thought
   * was running). Returns the unsubscribe.
   */
  onReset(cb: () => void): () => void {
    this.resetListeners.add(cb);
    return () => {
      this.resetListeners.delete(cb);
    };
  }

  /** Why nothing can be asked of the shell right now, or null. */
  private unusable(): string | null {
    let closed: boolean;
    try {
      closed = this.channel.closed !== false;
    } catch {
      closed = true;
    }
    if (closed) return DESKTOP_GONE_REASON;
    return this.ready ? null : DESKTOP_NOT_AVAILABLE_REASON;
  }

  /** The chat's session, for a look. Throws when there is none here or nothing can be asked. */
  private sessionOf(chatId: string): Session {
    const off = this.unusable();
    if (off !== null) throw new Error(off);
    const session = this.sessions.get(chatId);
    if (session === undefined) throw new Error(COMPUTER_NO_SESSION_REASON);
    return session;
  }

  /** Whether this side has anything on record for the chat that the shell may hold. */
  private tracked(chatId: string): boolean {
    return this.sessions.has(chatId) || this.starting.has(chatId) || this.doubtful.has(chatId);
  }

  /**
   * Nobody knows whether a session came of a start. The shell is told to end
   * it: confirmed, the start is refused with `reason`; not confirmed, this
   * throws, and the chat stays on record as one the shell may hold.
   */
  private async startUnknown(chatId: string, reason: string): Promise<ComputerAnswer> {
    this.doubtful.add(chatId);
    try {
      await this.end(chatId);
    } catch {
      throw new Error(`${reason} ${START_UNCONFIRMED}`);
    }
    return refusal(reason);
  }

  /** The answer to a start this side had given up on. Anything but a plain no is ended, unless a newer start has made a session since. */
  private lateStart(chatId: string, late: unknown): void {
    if (isRecord(late) && late['ok'] === false) return;
    if (this.sessions.has(chatId)) return;
    this.doubtful.add(chatId);
    this.end(chatId).catch((err: unknown) => {
      console.error(`[grunt-server] the desktop app answered a control request Grunt had given up on (chat ${chatId}), and didn't confirm ending it:`, err);
    });
  }

  private async end(chatId: string): Promise<void> {
    const known = this.tracked(chatId);
    // First, and before anything is awaited: nothing more is looked at or done for the chat from here.
    this.sessions.delete(chatId);
    let closed: boolean;
    try {
      closed = this.channel.closed !== false;
    } catch {
      closed = true;
    }
    if (!known && (closed || !this.ready)) return;
    if (known) this.doubtful.add(chatId);
    if (closed) throw new Error(END_GONE_REASON);
    let answer: unknown;
    try {
      answer = await this.channel.call('computer.end', { chatId }, this.endTimeoutMs);
    } catch (err) {
      throw new Error(failureText(err));
    }
    if (!isRecord(answer)) throw new Error(END_UNREADABLE_REASON);
    // The shell says so itself when it could not end it (a key it pressed would not come up).
    if (answer['ok'] === false) throw new Error(cardLine(answer['reason'], MAX_REASON) || END_REFUSED_REASON);
    this.doubtful.delete(chatId);
    // Whatever a start answered in the meantime, the shell has now ended it.
    this.sessions.delete(chatId);
  }

  /** `computer.stopped`: the shell ended a session itself. A stop is taken whatever reason comes with it; a chat id that can't be read is not. */
  private shellStopped(params: unknown): void {
    if (!isRecord(params)) return;
    const chatId = params['chatId'];
    if (!isChatId(chatId)) return;
    const said = params['why'];
    const why = (typeof said === 'string' && STOP_REASONS.includes(said) ? said : 'button') as ComputerStopReason;
    this.sessions.delete(chatId);
    this.doubtful.delete(chatId);
    for (const cb of [...this.stoppedListeners]) {
      try {
        cb(chatId, why);
      } catch (err) {
        console.error('[grunt-server] a computer-use stopped listener failed:', err);
      }
    }
  }
}
