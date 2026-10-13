import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectationOf, parseAction } from '@grunt/core/domain/computer-apps.js';
import type { ComputerAction, ComputerAnswer, ComputerExpectation } from '@grunt/core/ports/computer.js';
import { FAKE_COMPUTER_APP } from '@grunt/core/testing/fake-computer.js';
import type { AppEvent } from '@grunt/core/types/events.js';
import type { DesktopChannelOptions } from '../../src/computer/desktop-channel.js';
import { DESKTOP_BUSY_REASON, DESKTOP_NO_SCREENSHOT_REASON, MAX_QUEUED_PER_CHAT, type DesktopComputerDriverOptions } from '../../src/computer/desktop-driver.js';
import { COMPUTER_END_UNCONFIRMED_REASON, COMPUTER_NO_SESSION_REASON, ComputerSessions } from '../../src/computer/sessions.js';
import { connected, type ShellAnswer } from './fake-shell.js';

/**
 * The real pair: `ComputerSessions` over `DesktopComputerDriver` over the
 * channel, with the in-memory stand-in shell (fake-shell.ts) on the far end.
 * Nothing here moves a mouse, presses a key or looks at a screen.
 */

function action(args: Record<string, unknown>): ComputerAction {
  const parsed = parseAction(args, { bounds: { width: 1366, height: 768 }, reserved: [] });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.action as ComputerAction;
}

const TYPE = action({ action: 'type', text: 'hello' });
const CLICK = action({ action: 'left_click', coordinate: [10, 20] });
const EXPECT = expectationOf({
  app: FAKE_COMPUTER_APP.path,
  appShellView: FAKE_COMPUTER_APP.shellView,
  appWindow: FAKE_COMPUTER_APP.windowId,
  appPid: FAKE_COMPUTER_APP.pid,
  appStarted: FAKE_COMPUTER_APP.startedAt,
}) as ComputerExpectation;

const tick = () => new Promise((resolve) => setImmediate(resolve));
const silentOn =
  (...methods: string[]) =>
  (method: string): ShellAnswer | undefined =>
    methods.includes(method) ? 'silent' : undefined;

/** The pair, with chat `c` in control and a screenshot taken. */
async function inControl(options: { driver?: DesktopComputerDriverOptions; channel?: DesktopChannelOptions } = {}) {
  const made = await connected(options);
  const events: AppEvent[] = [];
  const cancelChat = vi.fn();
  const sessions = new ComputerSessions(made.driver, { emit: (e) => events.push(e), cancelChat }, { endTimeoutMs: 200 });
  expect(await sessions.ensureSession('c', 'Budget')).toEqual({ ok: true });
  await sessions.screenshot('c');
  return { ...made, sessions, events, cancelChat };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Stop reaches the shell, however many calls are in the way', () => {
  // The review's probe: a burst of parallel calls from one model step, then Stop.
  for (const [label, burst, channel] of [
    ['at the real limits', 80, {}],
    ['with a channel that holds four calls', 4, { maxPending: 4 }],
    ['with a channel that holds one call', 30, { maxPending: 1 }],
  ] as const) {
    it(`${label}: ${burst} actions at once, then Stop`, async () => {
      const { sessions, shell, cancelChat, driver } = await inControl({ channel });
      shell.override = silentOn('computer.act');
      const acts = Array.from({ length: burst }, () => sessions.act('c', TYPE, EXPECT));
      await tick();
      // One is with the shell. A bounded few wait their turn here, and the rest were refused at once: nothing fills the channel.
      expect(shell.sent('computer.act')).toHaveLength(1);
      const settledEarly = await Promise.race([Promise.all(acts.slice(1 + MAX_QUEUED_PER_CHAT)), tick().then(() => 'still waiting')]);
      if (burst > 1 + MAX_QUEUED_PER_CHAT) expect(settledEarly).toEqual(acts.slice(1 + MAX_QUEUED_PER_CHAT).map(() => ({ ok: false, reason: DESKTOP_BUSY_REASON })));

      await sessions.stop('c');

      // The end went to the shell, once, and the shell let go of the session.
      expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }]);
      expect(shell.sessions.has('c')).toBe(false);
      expect(cancelChat).toHaveBeenCalledWith('c');
      expect(sessions.activeChat()).toBeNull();
      // Every one of them has an answer, none of them a yes, and not one more action was sent.
      const answers = await Promise.all(acts);
      expect(answers.every((a: ComputerAnswer) => a.ok === false)).toBe(true);
      expect(shell.sent('computer.act')).toHaveLength(1);
      // The shell answering the one it had changes nothing.
      shell.override = () => undefined;
      shell.answer(shell.idOf('computer.act'), { ok: true });
      await tick();
      expect(shell.sent('computer.act')).toHaveLength(1);
      expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
      // And another chat can start, with a dialog of its own.
      expect(await sessions.ensureSession('d', 'Other')).toEqual({ ok: true });
    });
  }

  it('the same for looks: screenshots, targets and cursor reads at once, then Stop', async () => {
    const { sessions, shell } = await inControl();
    shell.override = silentOn('computer.screenshot', 'computer.target', 'computer.cursor');
    const looks = [
      ...Array.from({ length: 30 }, () => sessions.screenshot('c').then(() => 'done', () => 'refused')),
      ...Array.from({ length: 30 }, () => sessions.target('c', 'foreground').then((t) => ('refuse' in t ? 'refused' : 'done'), () => 'refused')),
      ...Array.from({ length: 30 }, () => sessions.cursorPosition('c').then(() => 'done', () => 'refused')),
    ];
    await tick();
    expect(shell.asked.filter((r) => ['computer.screenshot', 'computer.target', 'computer.cursor'].includes(r.method))).toHaveLength(2);
    await sessions.stop('c');
    expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }]);
    expect(await Promise.all(looks)).toEqual(looks.map(() => 'refused'));
  });
});

describe('a start that fails for a chat that is in control', () => {
  it('could not be sent: the session is ended at the shell and here, not just forgotten by the server', async () => {
    const { sessions, shell, driver, events } = await inControl({ channel: { maxPending: 2 } });
    // Two other calls take every ordinary place on the channel.
    shell.override = (method, params) => (method === 'computer.start' && params['chatId'] !== 'c' ? 'silent' : undefined);
    const others = [driver.ensureSession('x', 'X'), driver.ensureSession('y', 'Y')];
    others.forEach((p) => p.catch(() => {}));
    await tick();

    expect(await sessions.ensureSession('c', 'Budget')).toEqual({ ok: false, reason: 'The desktop app has too many requests waiting; nothing was sent.' });

    // The server was told "no session", and that is now true everywhere.
    expect(sessions.activeChat()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c', active: false });
    expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }]);
    expect(shell.sessions.has('c')).toBe(false);
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    shell.close();
    await Promise.allSettled(others);
  });

  it('was refused by the shell, with an action still in flight: nothing of that session goes on', async () => {
    const { sessions, shell, driver } = await inControl();
    shell.override = (method) => (method === 'computer.act' ? 'silent' : method === 'computer.start' ? { error: { message: 'internal failure' } } : undefined);
    const acting = sessions.act('c', TYPE, EXPECT);
    await tick();
    expect(await sessions.ensureSession('c', 'Budget')).toEqual({ ok: false, reason: 'internal failure' });
    expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }]);
    expect(shell.sessions.has('c')).toBe(false);
    expect((await acting).ok).toBe(false);
    expect(sessions.activeChat()).toBeNull();
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
  });
});

describe("the driver's start that throws", () => {
  it('a dialog nobody answers and an end the shell does not confirm: the start rejects, and every start is held back until the shell confirms', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const made = await connected({ driver: { startTimeoutMs: 30, endTimeoutMs: 30 } });
    const { shell } = made;
    const sessions = new ComputerSessions(made.driver, { emit: () => {}, cancelChat: () => {} }, { endTimeoutMs: 200 });
    shell.override = silentOn('computer.start', 'computer.end');

    await expect(sessions.ensureSession('c', 'Budget')).rejects.toThrow(
      "The desktop app didn't answer the request to control this computer in time, so nothing was started. Grunt couldn't confirm that the desktop app cancelled it."
    );
    expect(sessions.activeChat()).toBeNull();
    expect(sessions.holder()).toBeNull();
    const starts = shell.sent('computer.start').length;
    for (const chatId of ['c', 'd']) {
      expect(await sessions.ensureSession(chatId, 'Any')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    }
    // No dialog came up for either; the shell was only asked, again, to end.
    expect(shell.sent('computer.start')).toHaveLength(starts);
    expect(shell.sent('computer.end').length).toBeGreaterThan(1);
    expect(shell.sent('computer.end').every((p) => (p as { chatId: string }).chatId === 'c')).toBe(true);

    shell.override = () => undefined;
    expect(await sessions.ensureSession('d', 'Other')).toEqual({ ok: true });
    expect(sessions.activeChat()).toBe('d');
    // What reached the log is one clean line each time, with nothing of the channel's own in it.
    for (const call of logged.mock.calls) {
      expect(String(call[0])).toMatch(/^\[grunt-server\] couldn't confirm that the desktop app ended computer use for chat c: /);
      expect(String(call[0])).not.toMatch(/GRUNT-RPC|computer\.end|\n/);
    }
  });

  it('the shell goes away while its dialog is up: the start rejects and nothing is left in control', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const made = await connected();
    const cancelChat = vi.fn();
    const sessions = new ComputerSessions(made.driver, { emit: () => {}, cancelChat }, { endTimeoutMs: 200 });
    made.shell.override = silentOn('computer.start');
    const starting = sessions.ensureSession('c', 'Budget');
    await tick();
    made.shell.close();
    await expect(starting).rejects.toThrow('The desktop app went away.');
    expect(sessions.holder()).toBeNull();
    expect(sessions.available()).toBe(false);
    expect(await sessions.ensureSession('c', 'Budget')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
  });
});

describe('an action the shell does not answer in time', () => {
  it('ends the session at the shell; the next call asks the person again, and starts with no screenshot', async () => {
    const { sessions, shell } = await inControl({ driver: { actTimeoutMs: 30 } });
    shell.override = silentOn('computer.act');
    const answer = await sessions.act('c', TYPE, EXPECT);
    expect(answer).toEqual({
      ok: false,
      reason: "The desktop app didn't answer in time. Whether the action was carried out is not known. Grunt has ended the control session, so nothing more is done.",
    });
    expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }]);
    expect(shell.sessions.has('c')).toBe(false);
    // Nothing more is sent for the chat on the strength of the old session.
    expect((await sessions.act('c', TYPE, EXPECT)).ok).toBe(false);
    expect(shell.sent('computer.act')).toHaveLength(1);

    shell.override = () => undefined;
    const starts = shell.sent('computer.start').length;
    expect(await sessions.ensureSession('c', 'Budget')).toEqual({ ok: true });
    expect(shell.sent('computer.start')).toHaveLength(starts + 1);
    expect(await sessions.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: DESKTOP_NO_SCREENSHOT_REASON });
  });
});
