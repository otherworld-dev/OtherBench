import type { AppEvent } from '@otherbench/core/types/events.js';
import { scheduledRunBody } from '../desktop/notify.js';

/**
 * Browser notifications for scheduled runs, for the UI in a plain browser
 * (the desktop app has its own, `desktop/notify.ts`). Opt-in, per browser:
 * off until the user turns it on in Settings → Notifications and the browser
 * allows it. Only a scheduled run ending (or not starting) is shown, as
 * nobody was watching it; replies and approvals aren't.
 */
export const BROWSER_NOTIFY_STORAGE_KEY = 'otherbench.browserNotifications';

export type BrowserNotifyPermission = NotificationPermission | 'unsupported';

/** What the browser allows: 'unsupported' when it has no Notification API, as on a plain-http address other than this machine's. */
export function browserNotifyPermission(): BrowserNotifyPermission {
  return typeof window !== 'undefined' && 'Notification' in window ? window.Notification.permission : 'unsupported';
}

/** Whether the user turned scheduled-run notifications on in this browser. */
export function loadBrowserScheduledNotify(): boolean {
  try {
    const raw = window.localStorage.getItem(BROWSER_NOTIFY_STORAGE_KEY);
    return raw !== null && (JSON.parse(raw) as { scheduled?: unknown }).scheduled === true;
  } catch {
    return false;
  }
}

export function saveBrowserScheduledNotify(on: boolean): void {
  try {
    window.localStorage.setItem(BROWSER_NOTIFY_STORAGE_KEY, JSON.stringify({ scheduled: on }));
  } catch {
    // storage blocked -- the setting lasts until the page reloads.
  }
}

/** Asks the browser, if it hasn't been answered yet, and says what it now allows. */
export async function requestBrowserNotify(): Promise<BrowserNotifyPermission> {
  const now = browserNotifyPermission();
  if (now !== 'default') return now;
  return window.Notification.requestPermission();
}

/**
 * Shows a scheduled run's end as a browser notification, when the user turned
 * them on and the browser allows them. The tag is the run's, so several open
 * tabs show it once. A click focuses the page and opens the run's chat.
 */
export function showBrowserScheduledNotification(e: AppEvent, openChat: (chatId: string) => void): void {
  if (e.type !== 'schedule-run-finished') return;
  if (!loadBrowserScheduledNotify() || browserNotifyPermission() !== 'granted') return;
  const n = new window.Notification(e.scheduleName, { body: scheduledRunBody(e.status, e.detail), tag: `schedule-run:${e.runId}` });
  const chatId = e.chatId;
  n.onclick = () => {
    window.focus();
    if (chatId) openChat(chatId);
    n.close();
  };
}
