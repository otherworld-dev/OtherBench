import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@otherbench/core/types/events.js';
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
    await notifier.handle({ type: 'approval-requested', chatId: 'c1', messageId: 'm1', requestId: 'a3', toolName: 'generate_image', kind: 'generation' });
    expect(show.mock.calls).toEqual([
      ['Trip plans', 'Waiting for your answer', 'c1'],
      ['Trip plans', 'Plan waiting for your approval', 'c1'],
      ['Trip plans', 'Prompt waiting for you to generate', 'c1'],
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
    const { notifier, show, setPrefs } = setup({ prefs: { replies: false, approvals: true, scheduled: true } });
    await notifier.handle(finished('m1'));
    expect(show).not.toHaveBeenCalled();
    await notifier.handle(approval('r1'));
    expect(show).toHaveBeenCalledTimes(1);
    setPrefs({ replies: true, approvals: false, scheduled: true });
    await notifier.handle(approval('r2'));
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('falls back to "OtherBench" for a chat it doesn\'t know, and hands out the last notified chat once', async () => {
    const { notifier, show } = setup();
    expect(notifier.takeLastChat()).toBeNull();
    await notifier.handle({ ...finished('m9'), chatId: 'unknown' });
    expect(show).toHaveBeenLastCalledWith('OtherBench', 'Reply finished', 'unknown');
    expect(notifier.takeLastChat()).toBe('unknown');
    expect(notifier.takeLastChat()).toBeNull();
  });
});

const runStarted = (messageId: string): AppEvent => ({ type: 'schedule-run-started', scheduleId: 's1', scheduleName: 'Weekly report', runId: 'r1', chatId: 'c1', messageId });
const runFinished = (over: Partial<Extract<AppEvent, { type: 'schedule-run-finished' }>> = {}): AppEvent => ({
  type: 'schedule-run-finished', scheduleId: 's1', scheduleName: 'Weekly report', runId: 'r1', chatId: 'c1', messageId: 'm1', status: 'complete', detail: null, ...over,
});

describe('Notifier and scheduled runs', () => {
  it('shows a finished scheduled run titled with the schedule, even while the window is focused, once per run', async () => {
    const { notifier, show } = setup({ focused: true });
    await notifier.handle(runStarted('m1'));
    await notifier.handle(runFinished());
    await notifier.handle(runFinished());
    expect(show.mock.calls).toEqual([['Weekly report', 'Finished', 'c1']]);
  });

  it('words each outcome, and opens just OtherBench when there is no chat', async () => {
    const { notifier, show } = setup();
    await notifier.handle(runFinished({ runId: 'r1', status: 'error', detail: 'Rate limited.' }));
    await notifier.handle(runFinished({ runId: 'r2', status: 'timed_out', detail: 'Stopped after 30 minutes.' }));
    await notifier.handle(runFinished({ runId: 'r3', status: 'cancelled' }));
    await notifier.handle(runFinished({ runId: 'r4', status: 'not_started', detail: "The project's folder is missing.", chatId: null, messageId: null }));
    expect(show.mock.calls).toEqual([
      ['Weekly report', 'Failed: Rate limited.', 'c1'],
      ['Weekly report', 'Timed out', 'c1'],
      ['Weekly report', 'Stopped', 'c1'],
      ['Weekly report', "Didn't run: The project's folder is missing.", null],
    ]);
  });

  it("skips the run's own reply-finished notification", async () => {
    const { notifier, show } = setup();
    await notifier.handle(runStarted('m1'));
    await notifier.handle(finished('m1'));
    await notifier.handle(finished('m2'));
    expect(show.mock.calls).toEqual([['Trip plans', 'Reply finished', 'c1']]);
  });

  it('respects the Scheduled runs toggle', async () => {
    const { notifier, show } = setup({ prefs: { replies: true, approvals: true, scheduled: false } });
    await notifier.handle(runStarted('m1'));
    await notifier.handle(runFinished());
    await notifier.handle(finished('m1'));
    expect(show).not.toHaveBeenCalled();
  });
});

describe('notification prefs', () => {
  beforeEach(() => window.localStorage.clear());

  it('default to both on, round-trip through storage, and ignore malformed values', () => {
    expect(loadNotifyPrefs()).toEqual({ replies: true, approvals: true, scheduled: true });
    saveNotifyPrefs({ replies: false, approvals: true, scheduled: true });
    expect(loadNotifyPrefs()).toEqual({ replies: false, approvals: true, scheduled: true });
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, '{"replies":"no"');
    expect(loadNotifyPrefs()).toEqual({ replies: true, approvals: true, scheduled: true });
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, '{"replies":"no","approvals":false}');
    expect(loadNotifyPrefs()).toEqual({ replies: true, approvals: false, scheduled: true });
  });
});
