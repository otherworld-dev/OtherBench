import type { ScheduleRunStatus } from '@otherbench/core/domain/schedule.js';
import type { AppEvent } from '@otherbench/core/types/events.js';

/** localStorage key for the notification toggles. Per device, like the window it notifies from. */
export const NOTIFY_STORAGE_KEY = 'otherbench.notifications';

/** Which events raise a desktop notification (Settings → Desktop). */
export interface NotifyPrefs {
  /** A reply finished (or failed). */
  replies: boolean;
  /** A tool call, question or plan is waiting for the user. */
  approvals: boolean;
  /** A scheduled run ended or didn't start; shown even while OtherBench is focused. */
  scheduled: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { replies: true, approvals: true, scheduled: true };

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    const raw = window.localStorage.getItem(NOTIFY_STORAGE_KEY);
    if (!raw) return DEFAULT_NOTIFY_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotifyPrefs>;
    return {
      replies: typeof parsed.replies === 'boolean' ? parsed.replies : DEFAULT_NOTIFY_PREFS.replies,
      approvals: typeof parsed.approvals === 'boolean' ? parsed.approvals : DEFAULT_NOTIFY_PREFS.approvals,
      scheduled: typeof parsed.scheduled === 'boolean' ? parsed.scheduled : DEFAULT_NOTIFY_PREFS.scheduled,
    };
  } catch {
    return DEFAULT_NOTIFY_PREFS;
  }
}

export function saveNotifyPrefs(prefs: NotifyPrefs): void {
  try {
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // storage blocked or full -- the toggle still applies until the app restarts.
  }
}

export interface NotifierDeps {
  /** Whether the main window has focus right now; nothing is shown while it does. */
  isFocused(): Promise<boolean>;
  /** `chatId` lets a click open the chat (Windows); null opens just OtherBench. */
  show(title: string, body: string, chatId: string | null): Promise<void>;
  /** The chat's title for the notification's heading, or null if it isn't loaded. */
  chatTitle(chatId: string): string | null;
  prefs(): NotifyPrefs;
}

/** The body of a scheduled run's notification. */
function scheduledRunBody(status: ScheduleRunStatus, detail: string | null): string {
  switch (status) {
    case 'complete':
      return 'Finished';
    case 'error':
      return `Failed: ${detail ?? 'the reply failed.'}`;
    case 'timed_out':
      return 'Timed out';
    case 'cancelled':
      return 'Stopped';
    case 'not_started':
      return `Didn't run: ${detail ?? 'it could not start.'}`;
    case 'running':
      return 'Running';
  }
}

/**
 * Turns app-wide events into desktop notifications (v2 plan, Task 38): a
 * reply finishing or failing, and a tool call needing approval, only while
 * the window isn't focused, once per message or request. A scheduled run
 * ending (or not starting) is shown even while the window is focused, since
 * nobody was watching it, once per run; the run's own reply doesn't also
 * raise "Reply finished". On Windows clicking
 * the notification opens its chat; elsewhere clicks aren't reported, so it
 * also remembers the last chat it notified about, and opening OtherBench from the
 * tray goes there (`takeLastChat`).
 */
export class Notifier {
  private readonly sent = new Set<string>();
  private lastChatId: string | null = null;
  /** Replies written by scheduled runs: their own notification says the run ended, so the plain "Reply finished" is skipped. */
  private readonly scheduledMessages = new Set<string>();

  constructor(private readonly deps: NotifierDeps) {}

  async handle(e: AppEvent): Promise<void> {
    if (e.type === 'schedule-run-started') {
      this.scheduledMessages.add(e.messageId);
      return;
    }
    if (e.type === 'schedule-run-finished') {
      if (e.messageId) this.scheduledMessages.add(e.messageId);
      if (!this.deps.prefs().scheduled) return;
      const runKey = `schedule-run:${e.runId}`;
      if (this.sent.has(runKey)) return;
      this.sent.add(runKey);
      if (e.chatId) this.lastChatId = e.chatId;
      // Shown whether or not the window has focus: nobody was watching this run.
      await this.deps.show(e.scheduleName, scheduledRunBody(e.status, e.detail), e.chatId);
      return;
    }
    if (e.type === 'turn-finished' && this.scheduledMessages.has(e.messageId)) return;
    let key: string;
    let body: string;
    if (e.type === 'turn-finished' && (e.status === 'complete' || e.status === 'error')) {
      if (!this.deps.prefs().replies) return;
      key = `message:${e.messageId}`;
      body = e.status === 'complete' ? 'Reply finished' : 'Reply failed';
    } else if (e.type === 'approval-requested') {
      if (!this.deps.prefs().approvals) return;
      key = `request:${e.requestId}`;
      body = e.kind === 'question' ? 'Waiting for your answer' : e.kind === 'plan' ? 'Plan waiting for your approval' : `Approval needed: ${e.toolName}`;
    } else {
      return;
    }
    if (this.sent.has(key) || (await this.deps.isFocused()) || this.sent.has(key)) return;
    this.sent.add(key);
    this.lastChatId = e.chatId;
    await this.deps.show(this.deps.chatTitle(e.chatId) ?? 'OtherBench', body, e.chatId);
  }

  /** The chat last notified about, once: opening from the tray consumes it. */
  takeLastChat(): string | null {
    const id = this.lastChatId;
    this.lastChatId = null;
    return id;
  }
}
