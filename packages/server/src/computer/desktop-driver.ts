import { cardLine } from '@grunt/core/domain/card-text.js';
import { COMPUTER_LIMITS, expectationOf } from '@grunt/core/domain/computer-apps.js';
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
 * How long after giving up on a start its answer is still recognised, so
 * that a yes which comes late is ended and not left as a session nobody is
 * watching. Ten minutes is the shell's own idle limit: a session older than
 * that has ended by itself. Only a note is kept for that time, not a place
 * among the waiting calls.
 */
export const START_LATE_WATCH_MS = 600_000;
/** How long the shell gets to confirm an end. Under `COMPUTER_END_TIMEOUT_MS` (sessions.ts), so this side's own answer is the one `ComputerSessions` sees. */
export const END_TIMEOUT_MS = 4000;
/** How long the shell gets to carry out one action (4000 typed characters, checked every 20, is the long one). */
export const ACT_TIMEOUT_MS = 60_000;
/** How many chats this side keeps a record for (a session, a start in flight, an end the shell has not confirmed). One chat controls the computer at a time, so this is never near. */
export const MAX_TRACKED_CHATS = 64;
/** How many of one chat's calls may wait behind the one the shell is working on. One more is refused. */
export const MAX_QUEUED_PER_CHAT = 16;
/** What a session token from the shell must look like: opaque, minted by the shell for one session, never reused. */
export const SESSION_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
/** The `code` of the shell's error for a request whose session token is not its live session for that chat. */
export const NO_SESSION_CODE = 'no-session';
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
/** What a call is refused with when too many of the chat's calls are already waiting. */
export const DESKTOP_BUSY_REASON = "The desktop app is still busy with this chat's earlier requests; nothing was sent.";
/** What a start throws while the shell has not confirmed an end this side asked for. */
export const DESKTOP_END_PENDING_REASON = "The desktop app hasn't confirmed that the last control session ended, so nothing was started.";
/** What a mouse action without a point is refused with. Core's `parseAction` can't build one, so it is a mistake in Grunt itself. */
export const DESKTOP_NO_POINT_REASON = 'Grunt tried to send a mouse action without a point. That is a mistake in Grunt, not in the request; nothing was done.';
/** What an action without the whole approved expectation is refused with. The tool always hands one, so it is a mistake in Grunt itself. */
export const DESKTOP_NO_EXPECTATION_REASON = 'Grunt tried to send an action without the app the person approved. That is a mistake in Grunt, not in the request; nothing was done.';
/** What a call is told when the shell says the chat's session is not its live one. */
export const DESKTOP_SESSION_GONE_REASON = "The desktop app no longer has this chat's control session, so nothing was done.";
/** Said after a call when this side has ended the chat's session because it could no longer be trusted, and the shell confirmed. */
export const DESKTOP_ENDED_AFTER = 'Grunt has ended the control session, so nothing more is done.';
/** The same, when the shell did not confirm that end. */
export const DESKTOP_END_UNCONFIRMED_AFTER = "Grunt asked the desktop app to end the control session and couldn't confirm that it did.";

const TOO_MANY_REASON = 'Grunt is keeping track of too many control sessions; stop one first.';
const START_TIMEOUT_REASON = "The desktop app didn't answer the request to control this computer in time, so nothing was started.";
const START_UNREADABLE_REASON = "The desktop app's answer couldn't be read, so nothing was started.";
const START_REFUSED_REASON = 'The desktop app refused to start controlling this computer.';
const START_UNCONFIRMED = "Grunt couldn't confirm that the desktop app cancelled it.";
const END_GONE_REASON = 'The desktop app went away before it confirmed that the control session ended.';
const END_REFUSED_REASON = "The desktop app couldn't end the control session.";
const END_UNREADABLE_REASON = "The desktop app's answer couldn't be read, so Grunt can't tell whether the control session ended.";
const ACT_REFUSED_REASON = 'The desktop app refused the action.';
const ACT_NOT_AN_ACTION_REASON = 'That is not an action Grunt can send.';
const ACT_UNREADABLE_REASON = "The desktop app's answer couldn't be read.";
const ACT_UNKNOWN = 'Whether the action was carried out is not known.';
const ACT_SESSION_ENDED = 'The control session ended while the desktop app was working.';
const SCREENSHOT_UNREADABLE_REASON = "The desktop app's screenshot couldn't be read.";
const CURSOR_UNREADABLE_REASON = "The cursor's position couldn't be read.";
const TARGET_UNREADABLE_REASON = "The desktop app's answer about the window couldn't be read.";
const UNREACHABLE_REASON = "The desktop app couldn't be reached.";

const STOP_REASONS: readonly string[] = ['hotkey', 'button', 'idle', 'quit'];
/** The acting names of the port: the ones that need a point, and the ones that go to the foreground window. */
const MOUSE_ACTIONS: readonly string[] = ['mouse_move', 'left_click', 'right_click', 'double_click', 'triple_click', 'scroll'];
const KEYBOARD_ACTIONS: readonly string[] = ['type', 'key'];

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

/** What this side knows of a chat's session. */
interface Session {
  /** The shell's token for it, sent with every request for the chat. */
  readonly token: string;
  /** Whether it has taken a screenshot, and how big the last one was. */
  shot: { width: number; height: number } | null;
  /** One of the chat's calls is with the shell. */
  busy: boolean;
  /** The chat's calls waiting their turn: told `true` to go, `false` when the session ended first. */
  readonly waiting: ((go: boolean) => void)[];
  /** Settles when the session is forgotten here: the call that is with the shell stops waiting for its answer. */
  readonly gone: Promise<void>;
  readonly end: () => void;
}

/** What `ask` gives when the session ended before the shell answered. */
const ENDED = Symbol('the session ended');
/** What `ask` gives when the session had ended before the request could be written: nothing was sent. */
const UNSENT = Symbol('the session had ended, nothing was sent');

type Turn = 'go' | 'full' | 'ended';

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

function timedOut(err: unknown): boolean {
  return err instanceof DesktopChannelError && err.kind === 'timeout';
}

/** The shell says the session this side named is not its live one for the chat. */
function noSession(err: unknown): boolean {
  return err instanceof DesktopChannelError && err.kind === 'shell' && err.code === NO_SESSION_CODE;
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

/** A whole number a coordinate or a size can be. */
function isPixel(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= COMPUTER_LIMITS.coordinateMax;
}

/** Why a point may not be used in this session, or null: it has to be two whole numbers inside the session's own last screenshot. */
function pointRefusal(session: Session, x: unknown, y: unknown): string | null {
  if (session.shot === null) return DESKTOP_NO_SCREENSHOT_REASON;
  const inside = (v: unknown, size: number): boolean => isPixel(v, 0) && v < size;
  return inside(x, session.shot.width) && inside(y, session.shot.height) ? null : DESKTOP_OUTSIDE_REASON;
}

/** Whether `expect` is the whole expectation core builds (`expectationOf`): every one of its five facts, well formed. */
function isWholeExpectation(expect: unknown): boolean {
  if (!isRecord(expect)) return false;
  return expectationOf({ app: expect['app'], appShellView: expect['shellView'], appWindow: expect['windowId'], appPid: expect['pid'], appStarted: expect['startedAt'] }) !== null;
}

/** The size a PNG states for itself in its header (IHDR), or null when the bytes don't begin as a PNG does. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  // 8 bytes of signature, then the first chunk: 4 of length, 'IHDR', 4 of width, 4 of height.
  if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * `ComputerDriver` over the desktop shell's channel (spec
 * 2026-10-12-computer-use-design section 2; the wire in full is
 * `shell-wire-spec.md`): the server's end of the calls the shell carries
 * out. Facts in, facts out. It decides nothing about apps, keys or risk,
 * describes nothing and repairs nothing: an action and an expectation go to
 * the shell exactly as handed, and what the shell says a target is comes
 * back exactly as sent, missing and mistyped facts included, so that core
 * (`classifyTarget`) is what refuses or asks every time.
 *
 * What it does own is the line itself, and there it fails closed. The shell
 * is the source of truth; nothing this side believes about it outlives an
 * error:
 *
 *   - It is available only after the shell answered the hello from Windows
 *     with computer use on, a shortcut list it can read and its word that it
 *     holds no session (`sessions: 0`), and only while the channel is open.
 *     The hello is said once per channel. A shell that has not said so is
 *     sent nothing else (but an end, when this side has something on record
 *     to end).
 *   - The shell's shortcuts are the last list it reported (the hello, then
 *     each `computer.shortcuts` event after it). No list, a list that can't
 *     be read, an event before the hello has answered, or a closed channel is
 *     `null`, never an empty list.
 *   - A session is the shell's token for it. The shell mints one with the
 *     yes to `computer.start` (the person answered its native dialog), and
 *     this side sends it with every later request for the chat. Without a
 *     token nothing but a start or an end is sent for a chat: no screenshot,
 *     no target, no action before the person has said yes.
 *   - A start always settles, and one chat has one start with the shell at a
 *     time. A dialog nobody answers in `START_TIMEOUT_MS` is given up on: the
 *     shell is told to end that chat's start, and a yes that comes later is
 *     ended again. Whenever a start did not end in a plain yes with a token
 *     while this side has, or may have, a session for the chat, the shell is
 *     told to end it. When the shell won't confirm that end, the start
 *     throws, so that `ComputerSessions` holds every other start back; and
 *     this side starts nothing itself until every end it asked for is
 *     confirmed.
 *   - An end is asked of the shell every time (it is a no-op there for a
 *     chat with no session), goes out even when the channel is full of other
 *     calls, and is confirmed by `{ ok: true }` and nothing else. This side
 *     forgets the chat's session first, before the shell answers: the
 *     chat's calls that were waiting are dropped unsent, and the answer to
 *     one the shell was working on is not used.
 *   - One of a chat's calls is with the shell at a time; the rest wait their
 *     turn, at most `MAX_QUEUED_PER_CHAT` of them. So a burst of calls can
 *     neither fill the channel nor carry on after Stop.
 *   - It keeps, per session, whether it has a screenshot of its own and how
 *     big it was, and refuses a point without one or outside it: the tool's
 *     own memory of the size can be stale. An action goes only with the whole
 *     approved expectation, which the shell checks again.
 *   - Drift. A call for a session that timed out, an answer that can't be
 *     read, or the shell's word that the token is not its live session, and
 *     this side's view of that session can't be trusted: the session is
 *     ended (here, and at the shell), `onLost` listeners (`ComputerSessions`)
 *     are told, and the next call needs a new start, with a new dialog. When
 *     the channel closes, for whatever reason, every session is lost at once
 *     and nothing is sent again: a new channel (a new server) and a new hello
 *     are the only way back.
 *   - Every failure is told in this file's own words (or the shell's error as
 *     one bounded line), never the channel's internals.
 */
export class DesktopComputerDriver implements ComputerDriver {
  private ready = false;
  /** The hello, once said: every later call gets the same one. */
  private said: Promise<void> | null = null;
  /** The shell has answered the hello with something readable. */
  private answered = false;
  private shortcuts: readonly string[] | null = null;
  /** Chats the shell said yes to and has not ended since. */
  private readonly sessions = new Map<string, Session>();
  /** The start each chat has with the shell right now. */
  private readonly starts = new Map<string, Promise<ComputerAnswer>>();
  /** The end each chat has with the shell right now. */
  private readonly ends = new Map<string, Promise<void>>();
  /** Chats the shell may still hold something for: an end it did not confirm. */
  private readonly doubtful = new Set<string>();
  private readonly stoppedListeners = new Set<(chatId: string, why: ComputerStopReason) => void>();
  private readonly resetListeners = new Set<() => void>();
  private readonly lostListeners = new Set<(chatId: string) => void>();
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
      // Not before the hello has answered: until then nothing is known of this shell, and the answer is `null`.
      if (!this.answered) return;
      // The whole list or none: a list that can't be read is not filtered down to the part that can.
      this.shortcuts = isRecord(params) ? shortcutList(params['shortcuts']) : null;
    });
    channel.onClose(() => this.channelLost());
  }

  /**
   * Asks the shell what it offers. Said once per channel, after the announce
   * line: a later call waits for that same hello and sends nothing. Never
   * throws. When the answer states `sessions: 0`, the shell holds no session
   * from before this server, and the reset listeners are told; an answer
   * without it confirms nothing of the kind, and leaves computer use off.
   */
  hello(): Promise<void> {
    this.said ??= this.sayHello();
    return this.said;
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

  ensureSession(chatId: string, chatTitle: string): Promise<ComputerAnswer> {
    // One start per chat with the shell at a time: whoever asks meanwhile gets its answer.
    const asking = this.starts.get(chatId);
    if (asking !== undefined) return asking;
    const off = this.unusable();
    if (off !== null) return Promise.resolve(refusal(off));
    if (!this.tracked(chatId) && this.sessions.size + this.starts.size + this.doubtful.size >= MAX_TRACKED_CHATS) return Promise.resolve(refusal(TOO_MANY_REASON));
    const start: Promise<ComputerAnswer> = this.start(chatId, chatTitle).finally(() => {
      if (this.starts.get(chatId) === start) this.starts.delete(chatId);
    });
    this.starts.set(chatId, start);
    return start;
  }

  /**
   * Tells the shell to end the chat's session (it releases what it pressed,
   * and cancels a start whose dialog is still up). This side's record goes
   * first, with every call of the chat that was waiting. Rejects unless the
   * shell confirmed with `{ ok: true }`. With nothing on record for the chat
   * and no shell to ask (the channel closed, or the shell never said computer
   * use is on), there is nothing to end and it resolves.
   */
  endSession(chatId: string): Promise<void> {
    return this.end(chatId);
  }

  async screenshot(chatId: string): Promise<ComputerScreenshot> {
    const session = this.sessionOf(chatId);
    return this.inTurn(session, async () => {
      // Whatever comes back, the shell's last screenshot is no longer the one this side knew the size of.
      session.shot = null;
      let answer: unknown;
      try {
        answer = await this.ask(chatId, session, 'computer.screenshot', { chatId, session: session.token }, this.callTimeoutMs);
      } catch (err) {
        throw new Error(await this.failed(chatId, err));
      }
      // The session ended while the shell was taking it: it is nobody's to look at.
      if (answer === ENDED || answer === UNSENT || this.sessions.get(chatId) !== session) throw new Error(COMPUTER_NO_SESSION_REASON);
      const read = this.readScreenshot(answer);
      if (read === null) throw new Error(await this.drift(chatId, SCREENSHOT_UNREADABLE_REASON));
      session.shot = { width: read.width, height: read.height };
      return read;
    });
  }

  async cursorPosition(chatId: string): Promise<{ x: number; y: number }> {
    const session = this.sessionOf(chatId);
    return this.inTurn(session, async () => {
      let answer: unknown;
      try {
        answer = await this.ask(chatId, session, 'computer.cursor', { chatId, session: session.token }, this.callTimeoutMs);
      } catch (err) {
        throw new Error(await this.failed(chatId, err));
      }
      if (answer === ENDED || answer === UNSENT || this.sessions.get(chatId) !== session) throw new Error(COMPUTER_NO_SESSION_REASON);
      const { x, y } = isRecord(answer) ? answer : { x: null, y: null };
      if (!isPixel(x, 0) || !isPixel(y, 0)) throw new Error(await this.drift(chatId, CURSOR_UNREADABLE_REASON));
      return { x, y };
    });
  }

  /**
   * What the shell says is under a point, or in the foreground, EXACTLY as
   * it said it: not one fact is defaulted, coerced, added or dropped here.
   * The port's type is what the shell is supposed to send, not something
   * this method has checked; core's `classifyTarget` takes it as `unknown`.
   * Only an answer that is not even an object is taken as one that can't be
   * read (and the session ended).
   */
  async target(chatId: string, at: { x: number; y: number } | 'foreground'): Promise<ComputerTarget | ComputerRefusal> {
    const off = this.unusable();
    if (off !== null) return { refuse: off };
    const session = this.sessions.get(chatId);
    if (session === undefined) return { refuse: COMPUTER_NO_SESSION_REASON };
    const turn = await this.enter(session);
    if (turn !== 'go') return { refuse: turn === 'full' ? DESKTOP_BUSY_REASON : COMPUTER_NO_SESSION_REASON };
    try {
      let params: Record<string, unknown>;
      if (at === 'foreground') {
        params = { chatId, session: session.token, foreground: true };
      } else {
        const point: { x?: unknown; y?: unknown } = isRecord(at) ? at : {};
        // Checked now, with the turn: a screenshot that was ahead in the queue has set the size.
        const why = pointRefusal(session, point.x, point.y);
        if (why !== null) return { refuse: why };
        params = { chatId, session: session.token, x: point.x, y: point.y };
      }
      let answer: unknown;
      try {
        answer = await this.ask(chatId, session, 'computer.target', params, this.callTimeoutMs);
      } catch (err) {
        throw new Error(await this.failed(chatId, err));
      }
      if (answer === ENDED || answer === UNSENT || this.sessions.get(chatId) !== session) return { refuse: COMPUTER_NO_SESSION_REASON };
      if (!isRecord(answer)) return { refuse: await this.drift(chatId, TARGET_UNREADABLE_REASON) };
      // Not a check: the facts go to core as the shell sent them, and core judges them.
      return answer as unknown as ComputerTarget | ComputerRefusal;
    } finally {
      this.leave(session);
    }
  }

  async act(chatId: string, action: ComputerAction, expect: ComputerExpectation): Promise<ComputerAnswer> {
    const off = this.unusable();
    if (off !== null) return refusal(off);
    const session = this.sessions.get(chatId);
    if (session === undefined) return refusal(COMPUTER_NO_SESSION_REASON);
    const fields: unknown = action;
    if (!isRecord(fields)) return refusal(ACT_NOT_AN_ACTION_REASON);
    const name = fields['action'];
    const mouse = typeof name === 'string' && MOUSE_ACTIONS.includes(name);
    if (!mouse && !(typeof name === 'string' && KEYBOARD_ACTIONS.includes(name))) return refusal(ACT_NOT_AN_ACTION_REASON);
    const point = fields['coordinate'];
    // A mouse action is never sent without its point: the shell must not be left to pick one.
    if (mouse && !(Array.isArray(point) && point.length === 2)) return refusal(DESKTOP_NO_POINT_REASON);
    // Nor any action without the whole approved app, window and run, which the shell checks again when it acts.
    if (!isWholeExpectation(expect)) return refusal(DESKTOP_NO_EXPECTATION_REASON);

    const turn = await this.enter(session);
    if (turn !== 'go') return refusal(turn === 'full' ? DESKTOP_BUSY_REASON : COMPUTER_NO_SESSION_REASON);
    try {
      if (mouse) {
        const [x, y] = point as unknown[];
        // Checked now, with the turn: a screenshot that was ahead in the queue has set the size.
        const why = pointRefusal(session, x, y);
        if (why !== null) return refusal(why);
      }
      let answer: unknown;
      try {
        // The action and the expectation as handed: this side adds nothing to them and takes nothing away.
        answer = await this.ask(chatId, session, 'computer.act', { chatId, session: session.token, action, expect }, this.actTimeoutMs);
      } catch (err) {
        if (noSession(err)) return refusal(await this.drift(chatId, DESKTOP_SESSION_GONE_REASON));
        if (!outcomeUnknown(err)) return refusal(failureText(err));
        // Gone: the channel closed, and every session with it.
        if (!timedOut(err)) return refusal(`${failureText(err)} ${ACT_UNKNOWN}`);
        // The shell may still be at it. The session is ended, so that nothing more lands after this action.
        return refusal(await this.drift(chatId, `${failureText(err)} ${ACT_UNKNOWN}`));
      }
      // The session ended before the request was written: nothing was done.
      if (answer === UNSENT) return refusal(COMPUTER_NO_SESSION_REASON);
      // The session ended while the shell was working: its answer, if it ever comes, is not this session's.
      if (answer === ENDED || this.sessions.get(chatId) !== session) return refusal(`${ACT_SESSION_ENDED} ${ACT_UNKNOWN}`);
      if (isRecord(answer) && answer['ok'] === true) return { ok: true };
      if (isRecord(answer) && answer['ok'] === false) return refusal(cardLine(answer['reason'], MAX_REASON) || ACT_REFUSED_REASON);
      return refusal(await this.drift(chatId, `${ACT_UNREADABLE_REASON} ${ACT_UNKNOWN}`));
    } finally {
      this.leave(session);
    }
  }

  onStopped(cb: (chatId: string, why: ComputerStopReason) => void): () => void {
    this.stoppedListeners.add(cb);
    return () => {
      this.stoppedListeners.delete(cb);
    };
  }

  /**
   * The shell answered the hello and said it holds no session at all
   * (`sessions: 0`), whatever this server had on record (an end it never
   * confirmed, a session it thought was running). Returns the unsubscribe.
   */
  onReset(cb: () => void): () => void {
    this.resetListeners.add(cb);
    return () => {
      this.resetListeners.delete(cb);
    };
  }

  /**
   * This side ended a chat's session itself, because its view of it could
   * no longer be trusted (a call that timed out, an answer it couldn't read,
   * the shell's word that the token is not its live session, the channel
   * closing). The end may or may not have been confirmed by the shell;
   * whoever listens asks for it with `endSession` (it is the same end).
   * Returns the unsubscribe.
   */
  onLost(cb: (chatId: string) => void): () => void {
    this.lostListeners.add(cb);
    return () => {
      this.lostListeners.delete(cb);
    };
  }

  private async sayHello(): Promise<void> {
    let answer: unknown;
    try {
      answer = await this.channel.call('computer.hello', {}, this.callTimeoutMs);
    } catch {
      answer = null;
    }
    if (!isRecord(answer) || this.isClosed()) return;
    this.answered = true;
    this.shortcuts = shortcutList(answer['shortcuts']);
    // Only the shell's own statement that it holds nothing is taken as that.
    const clean = answer['sessions'] === 0;
    // Every fact must be there and say so: anything missing, mistyped or unknown leaves computer use off.
    this.ready = clean && answer['available'] === true && answer['platform'] === 'win32' && this.shortcuts !== null;
    if (!clean) return;
    for (const chatId of [...this.sessions.keys()]) this.drop(chatId);
    this.doubtful.clear();
    for (const cb of [...this.resetListeners]) {
      try {
        cb();
      } catch (err) {
        console.error('[grunt-server] a computer-use reset listener failed:', err);
      }
    }
  }

  /** The channel closed: nothing more can be sent or read. Every session is lost, and the shell may still hold one (it must end them itself). */
  private channelLost(): void {
    this.ready = false;
    this.shortcuts = null;
    const lost = [...this.sessions.keys()];
    for (const chatId of lost) {
      this.doubtful.add(chatId);
      this.drop(chatId);
    }
    for (const chatId of lost) this.tellLost(chatId);
  }

  /** Why nothing can be asked of the shell right now, or null. */
  private unusable(): string | null {
    if (this.isClosed()) return DESKTOP_GONE_REASON;
    return this.ready ? null : DESKTOP_NOT_AVAILABLE_REASON;
  }

  private isClosed(): boolean {
    try {
      return this.channel.closed !== false;
    } catch {
      return true;
    }
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
    return this.sessions.has(chatId) || this.starts.has(chatId) || this.doubtful.has(chatId);
  }

  /** Forgets the chat's session. Its calls that were waiting their turn are told so and are never sent. */
  private drop(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session === undefined) return;
    this.sessions.delete(chatId);
    for (const waiter of session.waiting.splice(0)) waiter(false);
    session.end();
  }

  /**
   * Sends one of the chat's calls and waits for the shell's answer, or for
   * the session to be forgotten here, whichever comes first (`ENDED`): after
   * Stop nobody waits on the shell for what it was doing.
   *
   * The one place a request for a session is written. Every caller checked
   * the session and then awaited (its turn, at least), and an end can come in
   * that gap: so the session is checked again here, synchronously, right
   * before the write. One that is no longer the chat's live session gets
   * `UNSENT` and nothing is written, so no request with its token follows
   * the `computer.end` that ended it.
   */
  private ask(chatId: string, session: Session, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.sessions.get(chatId) !== session) return Promise.resolve(UNSENT);
    const asked = this.channel.call(method, params, timeoutMs);
    // If the session ends first, an answer or a failure that comes later is nobody's.
    asked.catch(() => {});
    return Promise.race([asked, session.gone.then(() => ENDED)]);
  }

  /** Waits for the chat's turn with the shell: one call at a time, a bounded few behind it. */
  private enter(session: Session): Promise<Turn> {
    if (!session.busy) {
      session.busy = true;
      return Promise.resolve('go');
    }
    if (session.waiting.length >= MAX_QUEUED_PER_CHAT) return Promise.resolve('full');
    return new Promise<Turn>((resolve) => {
      session.waiting.push((go) => resolve(go ? 'go' : 'ended'));
    });
  }

  /** Gives the turn to the next call that is waiting, if any. */
  private leave(session: Session): void {
    const next = session.waiting.shift();
    if (next !== undefined) next(true);
    else session.busy = false;
  }

  /** A look, in the chat's turn. Rejects when too many are waiting or the session ended first. */
  private async inTurn<T>(session: Session, work: () => Promise<T>): Promise<T> {
    const turn = await this.enter(session);
    if (turn !== 'go') throw new Error(turn === 'full' ? DESKTOP_BUSY_REASON : COMPUTER_NO_SESSION_REASON);
    try {
      return await work();
    } finally {
      this.leave(session);
    }
  }

  /** A screenshot answer as the port has it, or null when it is anything else. */
  private readScreenshot(answer: unknown): ComputerScreenshot | null {
    if (!isRecord(answer)) return null;
    const { png, width, height } = answer;
    if (typeof png !== 'string' || !isPixel(width, 1) || !isPixel(height, 1)) return null;
    // Core's one test for an image from a tool: strict base64, at most 5 MB, the type read from the bytes.
    const image = validateToolImage({ type: 'image', data: png, mimeType: 'image/png' });
    if (!image.ok || image.mime !== 'image/png') return null;
    // The size beside the image must be the image's own: a point is checked against the one and clicked in the other.
    const own = pngSize(image.bytes);
    if (own === null || own.width !== width || own.height !== height) return null;
    return { png: image.bytes, width, height };
  }

  /**
   * What a look's failed call comes to. A plain error from the shell, or a
   * request that never left, is told as it is and the session stays. A call
   * that timed out, or the shell's word that the token is not its live
   * session, ends the session (`drift`). After the channel closed every
   * session is gone anyway.
   */
  private async failed(chatId: string, err: unknown): Promise<string> {
    if (noSession(err)) return this.drift(chatId, DESKTOP_SESSION_GONE_REASON);
    if (timedOut(err) || !(err instanceof DesktopChannelError)) return this.drift(chatId, failureText(err));
    return failureText(err);
  }

  /**
   * This side's view of the chat's session can't be trusted any more: the
   * session is ended here and at the shell, the lost listeners are told, and
   * the next call needs a new start. Answers `reason` with what came of the
   * end.
   */
  private async drift(chatId: string, reason: string): Promise<string> {
    const had = this.sessions.has(chatId);
    const ending = this.end(chatId).then(
      () => true,
      () => false
    );
    if (had) this.tellLost(chatId);
    return `${reason} ${(await ending) ? DESKTOP_ENDED_AFTER : DESKTOP_END_UNCONFIRMED_AFTER}`;
  }

  private tellLost(chatId: string): void {
    for (const cb of [...this.lostListeners]) {
      try {
        cb(chatId);
      } catch (err) {
        console.error('[grunt-server] a computer-use lost-session listener failed:', err);
      }
    }
  }

  private async start(chatId: string, chatTitle: string): Promise<ComputerAnswer> {
    // Nothing is started while the shell may still hold something this side asked it to end.
    for (const waiting of [...this.doubtful]) {
      try {
        await this.end(waiting);
      } catch {
        // The first one that fails is enough: the rest would only make the caller wait longer for the same answer.
        throw new Error(DESKTOP_END_PENDING_REASON);
      }
    }
    let answer: unknown;
    try {
      answer = await this.channel.call(
        'computer.start',
        { chatId, title: chatTitle },
        // Given up on at the limit, its place freed; only a note is kept, so that an answer that still comes is seen.
        { timeoutMs: this.startTimeoutMs, late: { forMs: this.startLateMs, answer: (late) => this.lateStart(chatId, late) } }
      );
    } catch (err) {
      if (outcomeUnknown(err)) return this.startUnknown(chatId, timedOut(err) ? START_TIMEOUT_REASON : failureText(err));
      // The shell said no in its own words, or the request never left.
      return this.notStarted(chatId, failureText(err));
    }
    if (isRecord(answer) && answer['ok'] === true) {
      const token = answer['session'];
      // A yes without a token this side can use is not a session it can name: the shell may hold one, so it is ended.
      if (typeof token !== 'string' || !SESSION_TOKEN.test(token)) return this.startUnknown(chatId, START_UNREADABLE_REASON);
      const current = this.sessions.get(chatId);
      if (current === undefined || current.token !== token) {
        // A new token is a new session: whatever this side knew of an older one (its screenshot, its queue) goes.
        this.drop(chatId);
        let end: () => void = () => {};
        const gone = new Promise<void>((resolve) => {
          end = resolve;
        });
        this.sessions.set(chatId, { token, shot: null, busy: false, waiting: [], gone, end });
      }
      return { ok: true };
    }
    if (isRecord(answer) && answer['ok'] === false) return this.notStarted(chatId, cardLine(answer['reason'], MAX_REASON) || START_REFUSED_REASON);
    return this.startUnknown(chatId, START_UNREADABLE_REASON);
  }

  /**
   * A start that was refused, or never left. With no session on record for
   * the chat, that is all there is to it. With one, the caller is about to
   * be told there is no session while the shell holds it: so it is ended.
   */
  private notStarted(chatId: string, reason: string): Promise<ComputerAnswer> {
    return this.sessions.has(chatId) ? this.startUnknown(chatId, reason) : Promise.resolve(refusal(reason));
  }

  /**
   * Nobody knows whether the shell holds a session for the chat. It is told
   * to end it: confirmed, the start is refused with `reason`; not confirmed,
   * this throws, and the chat stays on record as one the shell may hold.
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
      console.error(`[grunt-server] the desktop app answered a control request Grunt had given up on (chat ${chatId}), and didn't confirm ending it: ${failureText(err)}`);
    });
  }

  private end(chatId: string): Promise<void> {
    const known = this.tracked(chatId);
    const token = this.sessions.get(chatId)?.token;
    // First, and before anything is awaited: nothing more is looked at, sent or done for the chat from here.
    this.drop(chatId);
    const closed = this.isClosed();
    if (!known && (closed || !this.ready)) return Promise.resolve();
    if (known) this.doubtful.add(chatId);
    // One end per chat with the shell at a time: whoever asks meanwhile gets its answer.
    const ending = this.ends.get(chatId);
    if (ending !== undefined) return ending;
    if (closed) return Promise.reject(new Error(END_GONE_REASON));
    const asked: Promise<void> = this.askToEnd(chatId, token).finally(() => {
      if (this.ends.get(chatId) === asked) this.ends.delete(chatId);
    });
    this.ends.set(chatId, asked);
    return asked;
  }

  private async askToEnd(chatId: string, token: string | undefined): Promise<void> {
    let answer: unknown;
    try {
      // `priority`: an end is sent however many other calls are waiting on the shell. The token, when this side has one, is for the shell's log:
      // an end ends whatever the chat has there, a start whose dialog is up included.
      answer = await this.channel.call('computer.end', token === undefined ? { chatId } : { chatId, session: token }, { timeoutMs: this.endTimeoutMs, priority: true });
    } catch (err) {
      throw new Error(failureText(err));
    }
    if (!isRecord(answer)) throw new Error(END_UNREADABLE_REASON);
    // The shell says so itself when it could not end it (a key it pressed would not come up).
    if (answer['ok'] === false) throw new Error(cardLine(answer['reason'], MAX_REASON) || END_REFUSED_REASON);
    // Confirmed by a plain yes and nothing else: this is the answer that lets the next start through.
    if (answer['ok'] !== true) throw new Error(END_UNREADABLE_REASON);
    this.doubtful.delete(chatId);
    // Whatever a start answered in the meantime, the shell has now ended it.
    this.drop(chatId);
  }

  /** `computer.stopped`: the shell ended a session itself. A stop is taken whatever reason comes with it; a chat id that can't be read is not. */
  private shellStopped(params: unknown): void {
    if (!isRecord(params)) return;
    const chatId = params['chatId'];
    if (!isChatId(chatId)) return;
    const said = params['why'];
    const why = (typeof said === 'string' && STOP_REASONS.includes(said) ? said : 'button') as ComputerStopReason;
    this.drop(chatId);
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
