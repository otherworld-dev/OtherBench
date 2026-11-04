import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@otherbench/core/types/events.js';
import {
  BROWSER_NOTIFY_STORAGE_KEY,
  browserNotifyPermission,
  loadBrowserScheduledNotify,
  requestBrowserNotify,
  saveBrowserScheduledNotify,
  showBrowserScheduledNotification,
} from './browserNotify.js';

/** A stand-in for the browser's Notification, recording what was shown. */
class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => FakeNotification.permission);
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions
  ) {
    FakeNotification.shown.push(this);
  }
}

const finished = (over: Partial<Extract<AppEvent, { type: 'schedule-run-finished' }>> = {}): AppEvent => ({
  type: 'schedule-run-finished',
  scheduleId: 's1',
  scheduleName: 'Weekly report',
  runId: 'r1',
  chatId: 'c1',
  messageId: 'm1',
  status: 'complete',
  detail: null,
  ...over,
});

beforeEach(() => {
  window.localStorage.clear();
  FakeNotification.permission = 'default';
  FakeNotification.shown = [];
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal('Notification', FakeNotification);
});

afterEach(() => vi.unstubAllGlobals());

describe('browser notifications for scheduled runs', () => {
  it('are off until turned on, and remember the choice', () => {
    expect(loadBrowserScheduledNotify()).toBe(false);
    saveBrowserScheduledNotify(true);
    expect(loadBrowserScheduledNotify()).toBe(true);
    window.localStorage.setItem(BROWSER_NOTIFY_STORAGE_KEY, 'not json');
    expect(loadBrowserScheduledNotify()).toBe(false);
  });

  it("say what the browser allows, and 'unsupported' with no Notification API", async () => {
    expect(browserNotifyPermission()).toBe('default');
    FakeNotification.permission = 'granted';
    expect(await requestBrowserNotify()).toBe('granted');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    FakeNotification.permission = 'default';
    await requestBrowserNotify();
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    const saved = (window as { Notification?: unknown }).Notification;
    delete (window as { Notification?: unknown }).Notification;
    try {
      expect(browserNotifyPermission()).toBe('unsupported');
    } finally {
      if (saved !== undefined) (window as { Notification?: unknown }).Notification = saved;
    }
  });

  it('show a run that ended only when turned on and allowed, tagged by run, opening its chat on a click', () => {
    const openChat = vi.fn();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    FakeNotification.permission = 'granted';
    showBrowserScheduledNotification(finished(), openChat);
    expect(FakeNotification.shown).toEqual([]);

    saveBrowserScheduledNotify(true);
    FakeNotification.permission = 'denied';
    showBrowserScheduledNotification(finished(), openChat);
    expect(FakeNotification.shown).toEqual([]);

    FakeNotification.permission = 'granted';
    showBrowserScheduledNotification(finished({ status: 'error', detail: 'The model refused.' }), openChat);
    const [n] = FakeNotification.shown;
    expect(n).toMatchObject({ title: 'Weekly report', options: { body: 'Failed: The model refused.', tag: 'schedule-run:r1' } });
    n!.onclick!();
    expect(focus).toHaveBeenCalled();
    focus.mockRestore();
    expect(openChat).toHaveBeenCalledWith('c1');
    expect(n!.close).toHaveBeenCalled();
  });

  it('ignore every other event, so a reply or an approval never notifies in the browser', () => {
    saveBrowserScheduledNotify(true);
    FakeNotification.permission = 'granted';
    showBrowserScheduledNotification({ type: 'schedule-run-started', scheduleId: 's1', scheduleName: 'Weekly report', runId: 'r1', chatId: 'c1', messageId: 'm1' }, vi.fn());
    showBrowserScheduledNotification({ type: 'schedules-changed' }, vi.fn());
    expect(FakeNotification.shown).toEqual([]);
    showBrowserScheduledNotification(finished({ status: 'not_started', detail: 'The previous run was still going.', chatId: null, messageId: null }), vi.fn());
    expect(FakeNotification.shown[0]!.options.body).toBe("Didn't run: The previous run was still going.");
  });
});
