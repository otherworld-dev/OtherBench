import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFY_PREFS, loadNotifyPrefs, Notifier, NOTIFY_STORAGE_KEY, saveNotifyPrefs, type NotifyPrefs } from './notify.js';

function setup(over: { focused?: boolean; prefs?: NotifyPrefs } = {}) {
  let focused = over.focused ?? false;
  let prefs = over.prefs ?? DEFAULT_NOTIFY_PREFS;
  const show = vi.fn(async () => {});
  const notifier = new Notifier({
    isFocused: async () => focused,
    show,
    chatTitle: (id) => (id === 'c1' ? 'Trip plans' : null),
    prefs: () => prefs,
  });
  return {
    notifier,
    show,
    setFocused: (f: boolean) => (focused = f),
    setPrefs: (p: NotifyPrefs) => (prefs = p),
  };
}

const finished = (messageId: string, status: 'complete' | 'error' | 'cancelled' = 'complete') =>
  ({ type: 'turn-finished', chatId: 'c1', messageId, status }) as const;
const approval = (requestId: string) => ({ type: 'approval-requested', chatId: 'c1', messageId: 'm1', requestId, toolName: 'write_file' }) as const;

describe('Notifier', () => {
  it('notifies a finished or failed reply and a pending approval, titled with the chat', async () => {
    const { notifier, show } = setup();
    await notifier.handle(finished('m1'));
    await notifier.handle(finished('m2', 'error'));
    await notifier.handle(approval('r1'));
    expect(show.mock.calls).toEqual([
      ['Trip plans', 'Reply finished', 'c1'],
      ['Trip plans', 'Reply failed', 'c1'],
      ['Trip plans', 'Approval needed: write_file', 'c1'],
    ]);
  });

  it('says what a question or a plan is waiting for', async () => {
    const { notifier, show } = setup();
    await notifier.handle({ type: 'approval-requested', chatId: 'c1', messageId: 'm1', requestId: 'a1', toolName: 'ask_user', kind: 'question' });
    await notifier.handle({ type: 'approval-requested', chatId: 'c1', messageId: 'm1', requestId: 'a2', toolName: 'propose_plan', kind: 'plan' });
    expect(show.mock.calls).toEqual([
      ['Trip plans', 'Waiting for your answer', 'c1'],
      ['Trip plans', 'Plan waiting for your approval', 'c1'],
    ]);
  });

  it('shows nothing while the window is focused, and nothing for a stopped reply or other events', async () => {
    const { notifier, show, setFocused } = setup({ focused: true });
    await notifier.handle(finished('m1'));
    await notifier.handle(approval('r1'));
    setFocused(false);
    await notifier.handle(finished('m2', 'cancelled'));
    await notifier.handle({ type: 'chat-deleted', chatId: 'c1' });
    expect(show).not.toHaveBeenCalled();
  });

  it('notifies once per message or request, even when the same event arrives twice at once', async () => {
    const { notifier, show } = setup();
    await Promise.all([notifier.handle(finished('m1')), notifier.handle(finished('m1'))]);
    await notifier.handle(approval('r1'));
    await notifier.handle(approval('r1'));
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('respects the per-type toggles', async () => {
    const { notifier, show, setPrefs } = setup({ prefs: { replies: false, approvals: true } });
    await notifier.handle(finished('m1'));
    expect(show).not.toHaveBeenCalled();
    await notifier.handle(approval('r1'));
    expect(show).toHaveBeenCalledTimes(1);
    setPrefs({ replies: true, approvals: false });
    await notifier.handle(approval('r2'));
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('falls back to "Grunt" for a chat it doesn\'t know, and hands out the last notified chat once', async () => {
    const { notifier, show } = setup();
    expect(notifier.takeLastChat()).toBeNull();
    await notifier.handle({ ...finished('m9'), chatId: 'unknown' });
    expect(show).toHaveBeenLastCalledWith('Grunt', 'Reply finished', 'unknown');
    expect(notifier.takeLastChat()).toBe('unknown');
    expect(notifier.takeLastChat()).toBeNull();
  });
});

describe('notification prefs', () => {
  beforeEach(() => window.localStorage.clear());

  it('default to both on, round-trip through storage, and ignore malformed values', () => {
    expect(loadNotifyPrefs()).toEqual({ replies: true, approvals: true });
    saveNotifyPrefs({ replies: false, approvals: true });
    expect(loadNotifyPrefs()).toEqual({ replies: false, approvals: true });
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, '{"replies":"no"');
    expect(loadNotifyPrefs()).toEqual({ replies: true, approvals: true });
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, '{"replies":"no","approvals":false}');
    expect(loadNotifyPrefs()).toEqual({ replies: true, approvals: false });
  });
});
