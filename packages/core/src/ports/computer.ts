/**
 * Computer use (spec 2026-10-12-computer-use-design §1): what the server
 * needs from whatever carries out screenshots and input. The desktop shell
 * does it on Windows (server/src/computer/desktop-driver.ts); tests and e2e
 * use `FakeComputerDriver` (core/testing/fake-computer.ts). Coordinates are
 * always in the last screenshot's pixels; the driver owns the scale.
 *
 * The driver reports FACTS and carries out actions. It decides nothing:
 * whether a target may be used, how risky it is and what a card calls it are
 * all worked out in core (`classifyTarget`, domain/computer-apps.ts), in one
 * place, from what is reported here.
 */

/**
 * The window an action would land on, as the driver found it. Every field is
 * required: core refuses, or asks every time, when one is missing or of the
 * wrong type, and never treats such a target as an ordinary app.
 */
export interface ComputerTarget {
  /**
   * The program's canonical final path, resolved by the driver and by nobody
   * else: long names (never 8.3), links, junctions and substituted drives
   * resolved, on-disk letter case, `X:\...` or `\\server\share\...` with no
   * `\\?\` prefix. It is the app's key as it stands (`appKey` only checks
   * it), so the driver must report the same string for the same program every
   * time, and refuse rather than report a path it could not resolve.
   */
  path: string;
  /** The image's VERSIONINFO OriginalFilename; `null` only when the image has none. */
  originalName: string | null;
  /** The subject of a verified Authenticode signature; `null` when unsigned or not verified. */
  signer: string | null;
  /** A console or terminal-host window, or a console-subsystem image. */
  console: boolean;
  /** The kind of drive the image is on. Only a fixed disk pins what a path names. */
  location: 'fixed' | 'network' | 'removable' | 'unknown';
  elevated: boolean;
  /** The process holds UI access (it can drive other apps' windows). */
  uiAccess: boolean;
  /**
   * A Grunt window: Grunt's own process, any process descended from it (its
   * webview children, whose dropdowns, context menus and devtools are
   * top-level windows of their own), or any window owned by a Grunt window.
   */
  grunt: boolean;
  /**
   * The window is a common file dialog (Open, Save), hosts a shell file view,
   * or is a menu owned by one. It belongs to an ordinary app's process but
   * can open, run or delete any file, so core asks about it every time.
   */
  shellView: boolean;
  /** The window's title, raw. Set by the app: core bounds and cleans it before any card sees it. */
  title: string;
  /** The window itself, opaque to core (a window handle as text). */
  windowId: string;
  pid: number;
  /** When that process started, opaque to core: with `pid` it names one run of the program. */
  startedAt: string;
}

export interface ComputerRefusal {
  refuse: string;
}

/**
 * What must still be true when an action is carried out: the app (its key),
 * the window, and the run of the program the card was about. Built by core's
 * `expectationOf` from the described call; there is no "no expectation".
 */
export interface ComputerExpectation {
  app: string;
  windowId: string;
  pid: number;
  startedAt: string;
}

/**
 * A phase-1 action that changes something, with coordinates in screenshot
 * pixels. Built by core's `parseAction`, never from raw model input, and
 * already inside every cap in `COMPUTER_LIMITS`; the driver checks the caps
 * again and refuses what is outside them.
 *
 * A `key` action's `text` is ONE combination in core's canonical form
 * (`parseKeys`: `ctrl+shift+s`), which the driver presses and releases as
 * written. A `type` action's `text` is typed as Unicode characters, never as
 * virtual-key chords and with no modifier held, so typed text can't make a
 * shortcut, an Alt+numpad code or a dead-key composition; a line break is
 * Enter and a tab is Tab. No action holds a key or a button down: each one
 * presses and releases, and there is no key-down without its key-up.
 */
export type ComputerAction =
  | { action: 'mouse_move' | 'left_click' | 'right_click' | 'double_click' | 'triple_click'; coordinate: [number, number] }
  | { action: 'scroll'; coordinate: [number, number]; scroll_direction: 'up' | 'down' | 'left' | 'right'; scroll_amount: number }
  | { action: 'type'; text: string }
  | { action: 'key'; text: string };

export type ComputerAnswer = { ok: true } | { ok: false; reason: string };

export type ComputerStopReason = 'hotkey' | 'button' | 'idle' | 'quit';

export interface ComputerScreenshot {
  png: Buffer;
  width: number;
  height: number;
}

export interface ComputerDriver {
  /** True only when the tool can be offered: the desktop shell on Windows said hello with computer use on. */
  available(): boolean;
  /**
   * Starts (or continues) the chat's control session. The shell shows its
   * native dialog the first time. Every other call below needs the session:
   * without one the driver shows, tells and does nothing.
   */
  ensureSession(chatId: string, chatTitle: string): Promise<ComputerAnswer>;
  endSession(chatId: string): Promise<void>;
  screenshot(chatId: string): Promise<ComputerScreenshot>;
  /** Where the cursor is, in the last screenshot's pixels. */
  cursorPosition(chatId: string): Promise<{ x: number; y: number }>;
  /** The window under a point of the last screenshot, or the foreground window. */
  target(chatId: string, at: { x: number; y: number } | 'foreground'): Promise<ComputerTarget | ComputerRefusal>;
  /**
   * Carries out an action, but only on the window it was approved for: the
   * driver resolves the target again (under the point for an action with a
   * coordinate, the foreground window for `type` and `key`) and refuses
   * unless its path, window, pid and start time all equal `expect`, compared
   * exactly (the path byte for byte: the driver has no key rule of its own).
   * It checks again before every key combination and before every chunk of
   * at most 20 typed characters, and stops at the first check that fails. A
   * chat with no control session gets a refusal.
   */
  act(chatId: string, action: ComputerAction, expect: ComputerExpectation): Promise<ComputerAnswer>;
  /**
   * The global shortcuts the shell has registered (quick chat, the stop
   * hotkey), as it reported them in its hello and in every change since.
   * `parseKeys` refuses a `key` action that would press one. `null` when the
   * shell has not reported a list: never an empty list standing in for one,
   * so that no combination with a modifier is sent until the list is known.
   * The shell is the source of truth for its own shortcuts and refuses them
   * itself when it acts; this list lets the tool say so before a card.
   */
  reservedKeys(): readonly string[] | null;
  /** The shell ended a session itself (hotkey, the bar's Stop, idle, quit). Returns the unsubscribe. */
  onStopped(cb: (chatId: string, why: ComputerStopReason) => void): () => void;
}
