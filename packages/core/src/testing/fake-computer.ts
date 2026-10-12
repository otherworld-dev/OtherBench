import type {
  ComputerAction,
  ComputerAnswer,
  ComputerDriver,
  ComputerRefusal,
  ComputerScreenshot,
  ComputerStopReason,
  ComputerTarget,
} from '../ports/computer.js';

/** A 1×1 PNG: every screenshot the fake driver takes. */
export const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** What every point and the foreground belong to, unless a test says otherwise. */
export const FAKE_COMPUTER_APP: ComputerTarget = {
  path: 'C:\\Program Files\\Fake App\\FakeApp.exe',
  name: 'FakeApp',
  title: 'Fake App',
  elevated: false,
  grunt: false,
  risk: 'normal',
};

/**
 * A `ComputerDriver` that touches nothing: it records what it was asked and
 * answers with whatever the test set. Also what the server wires for e2e
 * when `GRUNT_COMPUTER_FAKE_DRIVER=1` (container.ts).
 */
export class FakeComputerDriver implements ComputerDriver {
  isAvailable = true;
  /** What `ensureSession` answers for a chat with no session yet (the native dialog's answer). */
  startAnswer: ComputerAnswer = { ok: true };
  pointTarget: ComputerTarget | ComputerRefusal = FAKE_COMPUTER_APP;
  foregroundTarget: ComputerTarget | ComputerRefusal = FAKE_COMPUTER_APP;
  actAnswer: ComputerAnswer = { ok: true };
  screenSize = { width: 1366, height: 768 };
  cursor = { x: 0, y: 0 };
  readonly started: { chatId: string; chatTitle: string }[] = [];
  readonly ended: string[] = [];
  readonly actions: { chatId: string; action: ComputerAction; expectApp: string | null }[] = [];
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
    this.screenshots.push(chatId);
    return { png: FAKE_PNG, ...this.screenSize };
  }

  async cursorPosition(): Promise<{ x: number; y: number }> {
    return { ...this.cursor };
  }

  async target(chatId: string, at: { x: number; y: number } | 'foreground'): Promise<ComputerTarget | ComputerRefusal> {
    this.targets.push({ chatId, at });
    return at === 'foreground' ? this.foregroundTarget : this.pointTarget;
  }

  async act(chatId: string, action: ComputerAction, expectApp: string | null): Promise<ComputerAnswer> {
    this.actions.push({ chatId, action, expectApp });
    return this.actAnswer;
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
