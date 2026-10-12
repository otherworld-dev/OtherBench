/**
 * Computer use (spec 2026-10-12-computer-use-design §1): what the server
 * needs from whatever carries out screenshots and input. The desktop shell
 * does it on Windows (server/src/computer/desktop-driver.ts); tests and e2e
 * use `FakeComputerDriver` (core/testing/fake-computer.ts). Coordinates are
 * always in the last screenshot's pixels; the driver owns the scale.
 */

/** The app an action would land on. `path` is the full program path as Windows reports it. */
export interface ComputerTarget {
  path: string;
  /** The program's file name without `.exe`, for cards. */
  name: string;
  title: string;
  elevated: boolean;
  /** The shell's own process (Grunt's windows). */
  grunt: boolean;
  risk: 'normal' | 'high';
}

export interface ComputerRefusal {
  refuse: string;
}

/** A phase-1 action that changes something, with coordinates in screenshot pixels. */
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
  /** Starts (or continues) the chat's control session. The shell shows its native dialog the first time. */
  ensureSession(chatId: string, chatTitle: string): Promise<ComputerAnswer>;
  endSession(chatId: string): Promise<void>;
  screenshot(chatId: string): Promise<ComputerScreenshot>;
  /** Where the cursor is, in the last screenshot's pixels. */
  cursorPosition(chatId: string): Promise<{ x: number; y: number }>;
  /** The app under a point of the last screenshot, or the foreground app. */
  target(chatId: string, at: { x: number; y: number } | 'foreground'): Promise<ComputerTarget | ComputerRefusal>;
  /** Carries out an action, refusing unless the target is still `expectApp` (lower-cased path). */
  act(chatId: string, action: ComputerAction, expectApp: string | null): Promise<ComputerAnswer>;
  /** The shell ended a session itself (hotkey, the bar's Stop, idle, quit). Returns the unsubscribe. */
  onStopped(cb: (chatId: string, why: ComputerStopReason) => void): () => void;
}
