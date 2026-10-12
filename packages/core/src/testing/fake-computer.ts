import type {
  ComputerAction,
  ComputerAnswer,
  ComputerDriver,
  ComputerExpectation,
  ComputerRefusal,
  ComputerScreenshot,
  ComputerStopReason,
  ComputerTarget,
} from '../ports/computer.js';
import { expectationOf, isReadAction, parseAction } from '../domain/computer-apps.js';

/** A 1×1 PNG: every screenshot the fake driver takes. */
export const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * What every point and the foreground belong to, unless a test says
 * otherwise: a fully described, signed program on a fixed disk, which core's
 * `classifyTarget` finds ordinary.
 */
export const FAKE_COMPUTER_APP: ComputerTarget = Object.freeze({
  path: 'C:\\Program Files\\Fake App\\FakeApp.exe',
  originalName: 'FakeApp.exe',
  signer: 'Fake Software Ltd',
  console: false,
  location: 'fixed',
  elevated: false,
  uiAccess: false,
  grunt: false,
  shellView: false,
  title: 'Fake App',
  windowId: 'hwnd-1',
  pid: 4242,
  startedAt: '2026-10-12T09:00:00.000Z',
});

/** `FAKE_COMPUTER_APP` with some facts changed: another window, another run, another program. */
export function fakeComputerTarget(over: Partial<ComputerTarget> = {}): ComputerTarget {
  return { ...FAKE_COMPUTER_APP, ...over };
}

/** What `act` answers when the window is no longer the one the action was approved for. */
export const FAKE_WINDOW_CHANGED_REASON = 'The window changed after Grunt asked, so nothing was done.';

/** What every call but `ensureSession` answers (or rejects with) for a chat that has no control session. */
export const FAKE_NO_SESSION_REASON = 'Grunt is not controlling this computer for that chat.';

type Acted = { chatId: string; action: ComputerAction; expect: ComputerExpectation };

/** The same fields with the same values, whatever order they were written in. */
function sameAction(a: object, b: object): boolean {
  const flat = (o: object): string => JSON.stringify(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return flat(a) === flat(b);
}

/**
 * A `ComputerDriver` that touches nothing: it records what it was asked and
 * answers with whatever the test set. Also what the server wires for e2e
 * when `GRUNT_COMPUTER_FAKE_DRIVER=1` (container.ts).
 *
 * Like the real shell, `act` looks at the target again and does nothing
 * unless it is still the app, window and run the expectation names: under
 * the point (`pointTarget`) for an action with a coordinate, the foreground
 * window (`foregroundTarget`) for `type` and `key`. A test models "the
 * window changed between the card and the action" by setting those after
 * the call was described.
 *
 * It also holds the line the real shell holds, so a layer that forgot fails
 * a test: `act` THROWS when it is handed an action that isn't exactly what
 * core's `parseAction` returns (outside a cap in `COMPUTER_LIMITS`, off the
 * screenshot, a key combination not in canonical form or one of
 * `reserved`) or an expectation that isn't whole. And every call but
 * `ensureSession` refuses a chat that has no session: `screenshot` and
 * `cursorPosition` reject, `target` answers a refusal, `act` does nothing.
 * So a layer that forgot to start the session fails its test.
 */
export class FakeComputerDriver implements ComputerDriver {
  isAvailable = true;
  /** What `ensureSession` answers for a chat with no session yet (the native dialog's answer). */
  startAnswer: ComputerAnswer = { ok: true };
  pointTarget: ComputerTarget | ComputerRefusal = FAKE_COMPUTER_APP;
  foregroundTarget: ComputerTarget | ComputerRefusal = FAKE_COMPUTER_APP;
  /** What `act` answers for an action it does carry out. */
  actAnswer: ComputerAnswer = { ok: true };
  screenSize = { width: 1366, height: 768 };
  cursor = { x: 0, y: 0 };
  /** The shell's own global shortcuts (`reservedKeys`); `null` for a shell that has not reported any list. */
  reserved: string[] | null = [];
  readonly started: { chatId: string; chatTitle: string }[] = [];
  readonly ended: string[] = [];
  /** Actions carried out. */
  readonly actions: Acted[] = [];
  /** Actions asked for and not carried out, because the target was no longer what `expect` named. */
  readonly refused: Acted[] = [];
  readonly targets: { chatId: string; at: { x: number; y: number } | 'foreground' }[] = [];
  readonly screenshots: string[] = [];
  private readonly sessions = new Set<string>();
  private readonly stopListeners = new Set<(chatId: string, why: ComputerStopReason) => void>();

  available(): boolean {
    return this.isAvailable;
  }

  async ensureSession(chatId: string, chatTitle: string): Promise<ComputerAnswer> {
    if (this.sessions.has(chatId)) return { ok: true };
    this.started.push({ chatId, chatTitle });
    if (!this.startAnswer.ok) return this.startAnswer;
    this.sessions.add(chatId);
    return { ok: true };
  }

  async endSession(chatId: string): Promise<void> {
    if (this.sessions.delete(chatId)) this.ended.push(chatId);
  }

  hasSession(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  async screenshot(chatId: string): Promise<ComputerScreenshot> {
    if (!this.sessions.has(chatId)) throw new Error(FAKE_NO_SESSION_REASON);
    this.screenshots.push(chatId);
    return { png: FAKE_PNG, ...this.screenSize };
  }

  async cursorPosition(chatId: string): Promise<{ x: number; y: number }> {
    if (!this.sessions.has(chatId)) throw new Error(FAKE_NO_SESSION_REASON);
    return { ...this.cursor };
  }

  async target(chatId: string, at: { x: number; y: number } | 'foreground'): Promise<ComputerTarget | ComputerRefusal> {
    if (!this.sessions.has(chatId)) return { refuse: FAKE_NO_SESSION_REASON };
    this.targets.push({ chatId, at });
    return at === 'foreground' ? this.foregroundTarget : this.pointTarget;
  }

  async act(chatId: string, action: ComputerAction, expect: ComputerExpectation): Promise<ComputerAnswer> {
    const parsed = parseAction(action, { bounds: this.screenSize, reserved: this.reserved });
    const why = !parsed.ok
      ? parsed.reason
      : isReadAction(parsed.action.action)
        ? 'a looking action has its own call'
        : sameAction(parsed.action, action)
          ? null
          : 'it is not in canonical form';
    if (why !== null) throw new Error(`FakeComputerDriver.act was handed an action core would not send (${why}). Dispatch only what parseAction returns.`);
    const given = expect as ComputerExpectation | null | undefined;
    const whole = given ? expectationOf({ app: given.app, appWindow: given.windowId, appPid: given.pid, appStarted: given.startedAt }) : null;
    if (whole === null) throw new Error('FakeComputerDriver.act was handed an expectation that is not whole. Build it with expectationOf.');
    if (!this.sessions.has(chatId)) {
      this.refused.push({ chatId, action, expect });
      return { ok: false, reason: FAKE_NO_SESSION_REASON };
    }
    const now = 'coordinate' in action ? this.pointTarget : this.foregroundTarget;
    if ('refuse' in now) {
      this.refused.push({ chatId, action, expect });
      return { ok: false, reason: now.refuse };
    }
    if (now.path !== expect.app || now.windowId !== expect.windowId || now.pid !== expect.pid || now.startedAt !== expect.startedAt) {
      this.refused.push({ chatId, action, expect });
      return { ok: false, reason: FAKE_WINDOW_CHANGED_REASON };
    }
    this.actions.push({ chatId, action, expect });
    return this.actAnswer;
  }

  /** Another window took the keyboard (the person clicked a card, an app raised itself): `type` and `key` now land there. */
  changeForeground(target: ComputerTarget | ComputerRefusal): void {
    this.foregroundTarget = target;
  }

  reservedKeys(): readonly string[] | null {
    return this.reserved;
  }

  onStopped(cb: (chatId: string, why: ComputerStopReason) => void): () => void {
    this.stopListeners.add(cb);
    return () => {
      this.stopListeners.delete(cb);
    };
  }

  /** As if the person pressed Stop: the session ends and listeners hear why. */
  stop(chatId: string, why: ComputerStopReason = 'button'): void {
    this.sessions.delete(chatId);
    for (const cb of this.stopListeners) cb(chatId, why);
  }
}
