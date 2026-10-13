import { actionSummary, chatTitleForDialog, desktopTextForResult } from '@grunt/core/domain/computer-apps.js';
import type { TurnRunner } from '@grunt/core/domain/turn.js';
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
import type { AppEvent } from '@grunt/core/types/events.js';
import type { AppEventBus } from '../stream/events.js';

type SessionEvent = Extract<AppEvent, { type: 'computer-session' }>;
type StoppedListener = (chatId: string, why: ComputerStopReason) => void;

/** What an error from the driver said, for a log line: core's one clean bounded line of it, never the error itself. */
function driverSaid(err: unknown): string {
  return desktopTextForResult(err instanceof Error ? err.message : String(err)) || 'no reason was given';
}

/** What a second chat is told while another one is in control, or is being asked about. */
export const COMPUTER_OTHER_CHAT_REASON = 'Another chat is controlling this computer. Stop it first.';
/** What every call but `ensureSession` answers (or rejects with) for a chat this server has no control session for. */
export const COMPUTER_NO_SESSION_REASON = 'Grunt is not controlling this computer for this chat.';
/** What a start answers when it was stopped, or its reply ended, before the person said OK. */
export const COMPUTER_START_STOPPED_REASON = 'Control was stopped before it started, so Grunt is not controlling this computer.';
/** What a start answers once the server is shutting down. */
export const COMPUTER_SHUTTING_DOWN_REASON = 'Grunt is shutting down, so it is not controlling this computer.';
/** What a start answers while the desktop app has not confirmed that an earlier session ended. It says what to do: the same start is refused again until the desktop app answers. */
export const COMPUTER_END_UNCONFIRMED_REASON =
  "Grunt couldn't confirm that the last control session was stopped, so nothing was started. Try again in a moment; if this keeps happening, restart Grunt.";
/** What another chat is told while a start is still waiting for an earlier end to be confirmed: no chat is in control then, so "stop it first" would be wrong. */
export const COMPUTER_CONFIRMING_REASON = 'Grunt is still confirming that the last control session was stopped. Try again in a moment.';

/** How long the driver is given to answer an end of session before the end counts as unconfirmed. */
export const COMPUTER_END_TIMEOUT_MS = 5000;

export interface ComputerSessionsDeps {
  emit: (event: SessionEvent) => void;
  /** Cancels every reply running in the chat (Stop, spec 2026-10-12-computer-use-design section 1). */
  cancelChat: (chatId: string) => void;
  /**
   * Whether the chat's row is still there. A chat can go without its own
   * delete route running (its profile or connection is deleted, a paired
   * machine deletes it): a session must not outlive it. Without this, nothing
   * is ever ended for a missing chat.
   */
  chatExists?: (chatId: string) => boolean;
}

export interface ComputerSessionsOptions {
  /** See `COMPUTER_END_TIMEOUT_MS`; tests shorten it. */
  endTimeoutMs?: number;
}

/**
 * What a driver may offer beside the port: its word that the desktop app
 * holds no session at all any more. The desktop driver gives it whenever the
 * shell answers a hello (desktop-driver.ts): a shell that answers one has
 * dropped every session it had. The fake driver has no such thing to say.
 */
export interface ComputerDriverResets {
  /** Returns the unsubscribe. */
  onReset(cb: () => void): () => void;
}

/**
 * What a driver may offer beside the port: its word that it ended a chat's
 * session itself, because its view of it could no longer be trusted (the
 * desktop driver, after a call timed out, an answer it couldn't read, the
 * shell's word that the session is not its live one, or the channel
 * closing). The shell may still hold it: ending it is asked of the driver
 * like any other end, and an end it can't confirm is unconfirmed.
 */
export interface ComputerDriverLosses {
  /** Returns the unsubscribe. */
  onLost(cb: (chatId: string) => void): () => void;
}

/** Cancels each reply the app-wide stream says is running in `chatId`. */
export function cancelChatReplies(events: AppEventBus, turnRunner: Pick<TurnRunner, 'cancel'>, chatId: string): void {
  for (const turn of events.runningTurns()) if (turn.chatId === chatId) turnRunner.cancel(turn.messageId);
}

/**
 * Tells `sessions` whenever a chat's last running reply has finished, so a
 * start nobody is waiting on any more, or a session that was started and
 * never used, does not outlive the reply it was for (`replyEnded`). A chat
 * with another reply still running (a compare variant) is left alone.
 * Returns the unsubscribe.
 */
export function endSessionsLeftWithoutAReply(events: AppEventBus, sessions: Pick<ComputerSessions, 'replyEnded'>): () => void {
  return events.subscribe((e) => {
    if (e.type === 'turn-finished' && !events.runningTurns().some((turn) => turn.chatId === e.chatId)) sessions.replyEnded(e.chatId);
  });
}

/**
 * Has `sessions` look for a holder whose chat is gone (`endIfChatGone`)
 * whenever the app-wide stream says chats may have gone: a chat was deleted
 * through the store, or changes from a paired machine were applied (a
 * delete of the chat, or of its profile or connection, cascades inside the
 * database and announces nothing of its own). Returns the unsubscribe.
 */
export function endSessionsOfChatsThatAreGone(events: AppEventBus, sessions: Pick<ComputerSessions, 'endIfChatGone'>): () => void {
  return events.subscribe((e) => {
    if (e.type === 'chat-deleted' || e.type === 'sync-applied') void sessions.endIfChatGone();
  });
}

/** A start the driver has not answered yet: the native dialog may be up. */
interface Start {
  readonly chatId: string;
  /** Stopped, or left without a reply, while it waited. An OK that comes now is ended, not kept. */
  abandoned: boolean;
  /** It is waiting for earlier ends to be confirmed: the driver has not been asked yet, and no dialog is up. */
  confirming: boolean;
  /** What every caller for this chat gets: one dialog, one answer. */
  readonly answer: Promise<ComputerAnswer>;
}

/**
 * The server's view of computer-use control (spec
 * 2026-10-12-computer-use-design section 7). It wraps the real (or fake)
 * driver and is itself the `ComputerDriver` the tool is given, so that:
 *
 *   - one chat at a time is in control, and one native dialog at a time is
 *     up: calls for the same chat made together share one start, and another
 *     chat is refused without the shell being asked;
 *   - every start, every action that was carried out and every end is
 *     announced as a `computer-session` app event (the thread banner);
 *   - a stop ends the session and cancels the chat's running reply, whether
 *     it comes from the shell (hotkey, the bar's Stop, idle, quit) or from
 *     the web app, and its own stopped listeners (the tool) hear of every
 *     end, including the ones the server makes itself.
 *
 * It decides nothing about apps and changes nothing on the way through: an
 * action, an expectation, a target, a refusal and the shell's shortcut list
 * are passed on as they are (the list `null` included), and a refusal is
 * never tried again. `lastAction` is core's `actionSummary` of the action
 * handed to `act`, which never holds typed text; nothing the driver says
 * about an app goes into an event.
 *
 * Stop is absolute. The server's own record of the session is cleared
 * first, before the driver is even told, and every call but `ensureSession`
 * is answered without the driver for a chat that has no session here. So
 * once a session has ended, by any route, nothing more reaches the driver
 * for it: not a call made in the same moment, and not one that was waiting
 * on the start dialog. Keys the driver itself had pressed are released by
 * the driver's own `endSession`, which is called at once.
 *
 * And it stays stopped. The driver is given `COMPUTER_END_TIMEOUT_MS` to
 * answer an end. An end it did not confirm (it threw, or did not answer in
 * time) is remembered: the shell may still hold that session, and it would
 * answer the chat's next start with a plain OK and no native dialog. So
 * before the driver is asked to start anything, for any chat, every end
 * still in flight is waited for and every unconfirmed one is tried again;
 * unless they all succeed the start is refused. Until then no chat is in
 * control here, so nothing is looked at or done for any chat either. The
 * one other thing that confirms such an end is the driver's word that the
 * shell holds no session at all any more (`shellReset`).
 *
 * A start that outlives what asked for it is ended rather than kept: when
 * Stop comes, the shell says stopped, the server shuts down or the chat's
 * last reply finishes while the dialog is still up, an OK that arrives later
 * ends the session it has just made. The same goes for a session that was
 * started and never used by the time its chat has no reply running (the
 * dialog was answered after the reply was stopped, and the tool then did
 * nothing). A session that was used stays for the chat's next reply, as the
 * spec has it, until Stop, the shell's idle limit or quit.
 *
 * A session does not outlive its chat. Stopping never depends on the chat's
 * row: `stop` works for any id. Whoever removes chats calls `endIfChatGone`
 * afterwards (the profile and connection routes, and the app-wide stream's
 * chat-deleted and sync-applied events), and as a backstop every start and
 * every call first ends a holder whose chat is no longer there.
 *
 * The port's stop reasons are the shell's. For an end the server makes
 * itself `'button'` stands in, and `'quit'` for shutdown.
 */
export class ComputerSessions implements ComputerDriver {
  /** The chat in control, as this server knows it. */
  private active: string | null = null;
  /** Counts sessions, so an answer that comes back late can be told from a later session of the same chat. */
  private generation = 0;
  /** Whether the session in control has been looked through, asked about or acted in since it started. */
  private used = false;
  private starting: Start | null = null;
  private disposed = false;
  /** Ends the driver has been told of and has not answered yet. */
  private readonly ending = new Set<Promise<boolean>>();
  /** Chats whose end the driver did not confirm: it may still hold a session for them. */
  private readonly unconfirmed = new Set<string>();
  private readonly endTimeoutMs: number;
  private readonly stoppedListeners = new Set<StoppedListener>();
  private readonly offStopped: () => void;
  private readonly offReset: () => void;
  private readonly offLost: () => void;

  constructor(
    private readonly driver: ComputerDriver & Partial<ComputerDriverResets> & Partial<ComputerDriverLosses>,
    private readonly deps: ComputerSessionsDeps,
    options: ComputerSessionsOptions = {}
  ) {
    this.endTimeoutMs = options.endTimeoutMs ?? COMPUTER_END_TIMEOUT_MS;
    this.offReset = typeof driver.onReset === 'function' ? driver.onReset(() => this.shellReset()) : () => {};
    this.offLost = typeof driver.onLost === 'function' ? driver.onLost((chatId) => this.driverLost(chatId)) : () => {};
    this.offStopped = driver.onStopped((chatId, why) => {
      // The shell's own word that this chat's session is over.
      this.unconfirmed.delete(chatId);
      this.release(chatId);
      this.notifyStopped(chatId, why);
      // Also for a chat this server has no record of (a late OK after a start that timed out left the
      // shell with a session): its reply must not go on and bring up a new dialog.
      this.cancelReplies(chatId);
    });
  }

  /** Whether the tool can be offered. A driver that can't say counts as no. */
  available(): boolean {
    try {
      return this.driver.available() === true;
    } catch (err) {
      console.error(`[grunt-server] the desktop app couldn't say whether computer use is available: ${driverSaid(err)}`);
      return false;
    }
  }

  activeChat(): string | null {
    return this.active;
  }

  /** The chat that holds the computer: the one in control, or the one whose start dialog may be up. */
  holder(): string | null {
    return this.starting !== null ? this.starting.chatId : this.active;
  }

  ensureSession(chatId: string, chatTitle: string): Promise<ComputerAnswer> {
    if (this.disposed) return Promise.resolve({ ok: false, reason: COMPUTER_SHUTTING_DOWN_REASON });
    this.dropGoneHolder();
    const holder = this.holder();
    if (holder !== null && holder !== chatId) {
      // While the other chat's start only waits for an earlier end, nobody is in control and there is nothing to stop.
      const confirming = this.active === null && this.starting !== null && this.starting.confirming;
      return Promise.resolve({ ok: false, reason: confirming ? COMPUTER_CONFIRMING_REASON : COMPUTER_OTHER_CHAT_REASON });
    }
    // One dialog per chat: whoever asks while it is up gets its answer.
    if (this.starting !== null) return this.starting.answer;

    let settle: (answer: ComputerAnswer) => void = () => {};
    let fail: (err: unknown) => void = () => {};
    const answer = new Promise<ComputerAnswer>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const start: Start = { chatId, abandoned: false, confirming: false, answer };
    this.starting = start;
    // The title goes into the shell's native dialog. Whoever asks, the driver gets core's one clean line of it
    // (the computer tool passes it that way already; this is the last thing of Grunt's between a title and the shell).
    this.begin(start, chatTitleForDialog(chatTitle)).then(settle, fail);
    return answer;
  }

  async endSession(chatId: string): Promise<void> {
    if (this.release(chatId)) this.notifyStopped(chatId, 'button');
    if (this.heldByAnother(chatId)) return;
    await this.tracked(this.tellDriverToEnd(chatId));
  }

  /**
   * Stop from the web app, or the chat is going: end the session and cancel
   * the chat's replies. Works for any id, whether or not the chat still has
   * a row. The server's record is cleared, the driver told and the replies
   * cancelled in one tick; the driver's answer is then waited for, for a
   * bounded time. Never throws: a driver that can't be told is logged, and
   * the end is remembered as unconfirmed.
   *
   * The driver is told to end `chatId`'s session only when no other chat
   * holds the computer: ending is how the driver lets go of the keys it
   * pressed, and another chat's Stop must not do that to the chat in control.
   */
  async stop(chatId: string): Promise<void> {
    if (this.release(chatId)) this.notifyStopped(chatId, 'button');
    const ended = this.heldByAnother(chatId) ? null : this.endOnDriver(chatId);
    this.cancelReplies(chatId);
    if (ended !== null) await ended;
  }

  /**
   * `chatId` has no reply running any more. A start still waiting on the
   * dialog has nobody to answer to, and a session nobody has used since it
   * started has nobody to use it: both end here. A session that has been
   * used is the chat's until Stop, idle or quit.
   */
  replyEnded(chatId: string): void {
    const asking = this.starting !== null && this.starting.chatId === chatId;
    const unused = this.active === chatId && !this.used;
    if (this.active === chatId ? !unused : !asking) return;
    if (this.release(chatId)) this.notifyStopped(chatId, 'button');
    void this.endOnDriver(chatId);
  }

  /**
   * A reply of `chatId` was asked to stop with its own Stop (the cancel
   * route). The turn may take a while to wind down, and `replyEnded` only
   * comes when it has. A start of that chat that has not reached the desktop
   * app yet, because it is waiting for an earlier end to be confirmed, is
   * given up here and now: no native dialog comes up for a reply that was
   * stopped. A dialog that is already up, and a session, are left to
   * `replyEnded`. (With two replies running in one chat, the other's call
   * gets the same refusal and may ask again.)
   */
  replyStopping(chatId: string): void {
    const start = this.starting;
    if (start !== null && start.chatId === chatId && start.confirming) start.abandoned = true;
  }

  /**
   * Ends the session of the chat that holds the computer when that chat no
   * longer exists, and cancels its replies. To be called after anything that
   * can remove chats. Does nothing when the holder's chat is still there, or
   * when nobody said how to tell (`chatExists`).
   */
  async endIfChatGone(): Promise<void> {
    const holder = this.holder();
    if (holder !== null && this.chatIsGone(holder)) await this.stop(holder);
  }

  /**
   * The driver's word that the desktop app holds no session at all any more
   * (`ComputerDriverResets`). So every end this server could not confirm is
   * confirmed, and a session, or a start, it still has on record is over:
   * the record is cleared, the end announced, the stopped listeners told and
   * the chat's replies cancelled, as when the shell itself says stopped. The
   * driver is not asked to end anything: there is nothing there to end. An
   * OK that still comes for a start that was waiting is ended like any other
   * late one.
   */
  shellReset(): void {
    if (this.disposed) return;
    this.unconfirmed.clear();
    const chatId = this.holder();
    if (chatId === null) return;
    if (this.release(chatId)) this.notifyStopped(chatId, 'quit');
    this.cancelReplies(chatId);
  }

  /**
   * The driver ended `chatId`'s session itself (`ComputerDriverLosses`). The
   * record goes and the end is announced, as for any end; the driver is
   * asked to confirm it like any other end, so one the shell does not
   * confirm holds every start back. And, as for a stop from the shell, the
   * chat's running replies are cancelled: a reply does not go on without the
   * session it was using (a new one would need the native dialog again).
   * Only that chat's.
   */
  driverLost(chatId: string): void {
    if (this.disposed) return;
    if (this.release(chatId)) this.notifyStopped(chatId, 'button');
    if (!this.heldByAnother(chatId)) void this.endOnDriver(chatId);
    this.cancelReplies(chatId);
  }

  async screenshot(chatId: string): Promise<ComputerScreenshot> {
    if (this.use(chatId) === null) throw new Error(COMPUTER_NO_SESSION_REASON);
    return this.driver.screenshot(chatId);
  }

  async cursorPosition(chatId: string): Promise<{ x: number; y: number }> {
    if (this.use(chatId) === null) throw new Error(COMPUTER_NO_SESSION_REASON);
    return this.driver.cursorPosition(chatId);
  }

  async target(chatId: string, at: { x: number; y: number } | 'foreground'): Promise<ComputerTarget | ComputerRefusal> {
    if (this.use(chatId) === null) return { refuse: COMPUTER_NO_SESSION_REASON };
    return this.driver.target(chatId, at);
  }

  async act(chatId: string, action: ComputerAction, expect: ComputerExpectation): Promise<ComputerAnswer> {
    const session = this.use(chatId);
    if (session === null) return { ok: false, reason: COMPUTER_NO_SESSION_REASON };
    const answer = await this.driver.act(chatId, action, expect);
    // Only what was carried out, and only while that same session is still the one in control.
    if (answer.ok === true && this.active === chatId && this.generation === session) {
      this.announce({ type: 'computer-session', chatId, active: true, lastAction: actionSummary(action) });
    }
    return answer;
  }

  reservedKeys(): readonly string[] | null {
    return this.driver.reservedKeys();
  }

  /** A session ended, whoever ended it: the shell, or this server (Stop, a chat that is gone, a start nobody waited for, shutdown). */
  onStopped(cb: StoppedListener): () => void {
    this.stoppedListeners.add(cb);
    return () => {
      this.stoppedListeners.delete(cb);
    };
  }

  /** Shutdown: the session ends with the server, and nothing starts afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offStopped();
    this.offReset();
    this.offLost();
    const chatId = this.holder();
    if (chatId !== null) {
      if (this.release(chatId)) this.notifyStopped(chatId, 'quit');
      void this.endOnDriver(chatId);
    }
    this.stoppedListeners.clear();
  }

  /** Asks the driver, once, and makes of its answer what the chat's callers are all told. */
  private async begin(start: Start, chatTitle: string): Promise<ComputerAnswer> {
    const { chatId } = start;
    // Nothing is started while the driver may still hold a session this server has ended.
    if (this.ending.size > 0 || this.unconfirmed.size > 0) {
      start.confirming = true;
      const confirmed = await this.endsConfirmed();
      start.confirming = false;
      if (!confirmed) {
        if (this.starting === start) this.starting = null;
        return { ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON };
      }
    }
    // Looked at immediately before the driver is asked, whatever came before: a start that was stopped, or whose
    // reply was stopped or is over, brings up no dialog. The driver was never asked, so there is nothing to end.
    if (start.abandoned || this.disposed) {
      if (this.starting === start) this.starting = null;
      return { ok: false, reason: COMPUTER_START_STOPPED_REASON };
    }
    let answer: ComputerAnswer;
    try {
      answer = await this.driver.ensureSession(chatId, chatTitle);
    } catch (err) {
      if (this.starting === start) this.starting = null;
      // Whether a session came of it is unknown. This server keeps none, and tells the driver to end one if it has.
      if (this.release(chatId)) this.notifyStopped(chatId, 'button');
      void this.endOnDriver(chatId);
      throw err;
    }
    if (this.starting === start) this.starting = null;
    if (answer.ok !== true) {
      // The driver has no session for the chat: if this server thought it had one, it is over. The refusal goes on as it is.
      if (this.release(chatId)) this.notifyStopped(chatId, 'button');
      return answer;
    }
    if (start.abandoned || this.disposed) {
      // A late OK: nobody is waiting for this session any more, so it is ended and not announced.
      await this.endOnDriver(chatId);
      return { ok: false, reason: COMPUTER_START_STOPPED_REASON };
    }
    if (this.active !== chatId) {
      this.active = chatId;
      this.generation += 1;
      this.used = false;
      this.announce({ type: 'computer-session', chatId, active: true });
    }
    return answer;
  }

  /** The session `chatId` is in control with, marked as used; null when it has none here. */
  private use(chatId: string): number | null {
    this.dropGoneHolder();
    if (this.active !== chatId) return null;
    this.used = true;
    return this.generation;
  }

  /** True when another chat than `chatId` holds the computer: the driver's session is that chat's, not this one's. */
  private heldByAnother(chatId: string): boolean {
    const holder = this.holder();
    return holder !== null && holder !== chatId;
  }

  /** Whether `chatId`'s row is gone. A check that can't be made says "still there". */
  private chatIsGone(chatId: string): boolean {
    if (this.deps.chatExists === undefined) return false;
    try {
      return !this.deps.chatExists(chatId);
    } catch (err) {
      console.error(`[grunt-server] couldn't check whether chat ${chatId} still exists (computer use):`, err);
      return false;
    }
  }

  /** The backstop: a holder whose chat no longer exists is stopped before anything else is started or done. */
  private dropGoneHolder(): void {
    const holder = this.holder();
    if (holder === null || !this.chatIsGone(holder)) return;
    // Already stopped, with its dialog still up: an OK to it ends what it makes.
    if (this.starting !== null && this.starting.chatId === holder && this.starting.abandoned && this.active !== holder) return;
    void this.stop(holder);
  }

  /**
   * Clears this server's record of `chatId`'s session, started or still
   * being asked for, and announces the end of a started one. Synchronous, and
   * always done before the driver is told. True when there was something.
   */
  private release(chatId: string): boolean {
    let had = false;
    if (this.starting !== null && this.starting.chatId === chatId && !this.starting.abandoned) {
      this.starting.abandoned = true;
      had = true;
    }
    if (this.active === chatId) {
      this.active = null;
      this.used = false;
      had = true;
      this.announce({ type: 'computer-session', chatId, active: false });
    }
    return had;
  }

  /**
   * Tells the driver to end the chat's session (it releases what it
   * pressed) and waits for its answer, at most `endTimeoutMs`. The driver is
   * called before this returns its promise. Rejects, and remembers the chat
   * as unconfirmed, when the driver throws or does not answer in time.
   */
  private async tellDriverToEnd(chatId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const told = Promise.resolve(this.driver.endSession(chatId));
      // If the limit wins the race, an answer that comes later is nobody's to handle.
      told.catch(() => {});
      await Promise.race([
        told,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`The desktop app did not answer within ${this.endTimeoutMs} ms.`)), this.endTimeoutMs);
        }),
      ]);
      this.unconfirmed.delete(chatId);
    } catch (err) {
      this.unconfirmed.add(chatId);
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** `tellDriverToEnd` that never throws: true when the driver confirmed, false (and logged) when it did not. */
  private endOnDriver(chatId: string): Promise<boolean> {
    return this.tracked(
      this.tellDriverToEnd(chatId).then(
        () => true,
        (err: unknown) => {
          console.error(`[grunt-server] couldn't confirm that the desktop app ended computer use for chat ${chatId}: ${driverSaid(err)}`);
          return false;
        }
      )
    );
  }

  /** Keeps an end in `ending` until the driver has answered it, so a start can wait for it. */
  private tracked<T>(end: Promise<T>): Promise<T> {
    const settled = end.then(
      () => true,
      () => false
    );
    this.ending.add(settled);
    void settled.then(() => this.ending.delete(settled));
    return end;
  }

  /**
   * Waits for every end in flight, then tries the unconfirmed ones again, one
   * at a time, and says whether none is left. It stops at the first that
   * still fails: the answer is "no" either way, and a desktop app that is
   * not answering would otherwise make the caller wait out its limit once
   * for every chat on the list.
   */
  private async endsConfirmed(): Promise<boolean> {
    while (this.ending.size > 0) await Promise.all([...this.ending]);
    for (const chatId of [...this.unconfirmed]) {
      if (!(await this.endOnDriver(chatId))) return false;
    }
    return this.unconfirmed.size === 0;
  }

  private announce(event: SessionEvent): void {
    try {
      this.deps.emit(event);
    } catch (err) {
      console.error('[grunt-server] a computer-session event could not be sent:', err);
    }
  }

  private notifyStopped(chatId: string, why: ComputerStopReason): void {
    for (const cb of [...this.stoppedListeners]) {
      try {
        cb(chatId, why);
      } catch (err) {
        console.error('[grunt-server] a computer-use stopped listener failed:', err);
      }
    }
  }

  private cancelReplies(chatId: string): void {
    try {
      this.deps.cancelChat(chatId);
    } catch (err) {
      console.error(`[grunt-server] couldn't cancel the replies of chat ${chatId}:`, err);
    }
  }
}
