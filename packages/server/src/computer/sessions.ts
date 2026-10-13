import { actionSummary } from '@grunt/core/domain/computer-apps.js';
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

/** What a second chat is told while another one is in control, or is being asked about. */
export const COMPUTER_OTHER_CHAT_REASON = 'Another chat is controlling this computer. Stop it first.';
/** What every call but `ensureSession` answers (or rejects with) for a chat this server has no control session for. */
export const COMPUTER_NO_SESSION_REASON = 'Grunt is not controlling this computer for this chat.';
/** What a start answers when it was stopped, or its reply ended, before the person said OK. */
export const COMPUTER_START_STOPPED_REASON = 'Control was stopped before it started, so Grunt is not controlling this computer.';
/** What a start answers once the server is shutting down. */
export const COMPUTER_SHUTTING_DOWN_REASON = 'Grunt is shutting down, so it is not controlling this computer.';

export interface ComputerSessionsDeps {
  emit: (event: SessionEvent) => void;
  /** Cancels every reply running in the chat (Stop, spec 2026-10-12-computer-use-design section 1). */
  cancelChat: (chatId: string) => void;
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

/** A start the driver has not answered yet: the native dialog may be up. */
interface Start {
  readonly chatId: string;
  /** Stopped, or left without a reply, while it waited. An OK that comes now is ended, not kept. */
  abandoned: boolean;
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
 * A start that outlives what asked for it is ended rather than kept: when
 * Stop comes, the shell says stopped, the server shuts down or the chat's
 * last reply finishes while the dialog is still up, an OK that arrives later
 * ends the session it has just made. The same goes for a session that was
 * started and never used by the time its chat has no reply running (the
 * dialog was answered after the reply was stopped, and the tool then did
 * nothing). A session that was used stays for the chat's next reply, as the
 * spec has it, until Stop, the shell's idle limit or quit.
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
  private readonly stoppedListeners = new Set<StoppedListener>();
  private readonly offStopped: () => void;

  constructor(
    private readonly driver: ComputerDriver,
    private readonly deps: ComputerSessionsDeps
  ) {
    this.offStopped = driver.onStopped((chatId, why) => {
      const had = this.release(chatId);
      this.notifyStopped(chatId, why);
      if (had) this.cancelReplies(chatId);
    });
  }

  available(): boolean {
    return this.driver.available();
  }

  activeChat(): string | null {
    return this.active;
  }

  ensureSession(chatId: string, chatTitle: string): Promise<ComputerAnswer> {
    if (this.disposed) return Promise.resolve({ ok: false, reason: COMPUTER_SHUTTING_DOWN_REASON });
    const holder = this.starting !== null ? this.starting.chatId : this.active;
    if (holder !== null && holder !== chatId) return Promise.resolve({ ok: false, reason: COMPUTER_OTHER_CHAT_REASON });
    // One dialog per chat: whoever asks while it is up gets its answer.
    if (this.starting !== null) return this.starting.answer;

    let settle: (answer: ComputerAnswer) => void = () => {};
    let fail: (err: unknown) => void = () => {};
    const answer = new Promise<ComputerAnswer>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const start: Start = { chatId, abandoned: false, answer };
    this.starting = start;
    this.begin(start, chatTitle).then(settle, fail);
    return answer;
  }

  async endSession(chatId: string): Promise<void> {
    if (this.release(chatId)) this.notifyStopped(chatId, 'button');
    await this.driver.endSession(chatId);
  }

  /**
   * Stop from the web app, or the chat is being deleted: end the session and
   * cancel the chat's replies. The reply is cancelled even when the driver
   * can't be told (that is logged, not thrown).
   */
  async stop(chatId: string): Promise<void> {
    if (this.release(chatId)) this.notifyStopped(chatId, 'button');
    const ended = this.endOnDriver(chatId);
    try {
      this.deps.cancelChat(chatId);
    } finally {
      await ended;
    }
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

  /** A session ended, whoever ended it: the shell, or this server (Stop, a deleted chat, a start nobody waited for, shutdown). */
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
    const chatId = this.starting !== null ? this.starting.chatId : this.active;
    if (chatId !== null) {
      if (this.release(chatId)) this.notifyStopped(chatId, 'quit');
      void this.endOnDriver(chatId);
    }
    this.stoppedListeners.clear();
  }

  /** Asks the driver, once, and makes of its answer what the chat's callers are all told. */
  private async begin(start: Start, chatTitle: string): Promise<ComputerAnswer> {
    const { chatId } = start;
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
    if (this.active !== chatId) return null;
    this.used = true;
    return this.generation;
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

  /** Tells the driver to end the chat's session (it releases what it pressed). Never throws: a driver that can't be told is logged. */
  private async endOnDriver(chatId: string): Promise<void> {
    try {
      await this.driver.endSession(chatId);
    } catch (err) {
      console.error(`[grunt-server] couldn't tell the desktop app to end computer use for chat ${chatId}:`, err);
    }
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
      console.error(`[grunt-server] couldn't cancel the replies of chat ${chatId} after computer use stopped:`, err);
    }
  }
}
