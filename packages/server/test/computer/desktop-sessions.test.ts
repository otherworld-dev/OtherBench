import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectationOf, parseAction } from '@otherbench/core/domain/computer-apps.js';
import type { ComputerAction, ComputerAnswer, ComputerExpectation } from '@otherbench/core/ports/computer.js';
import { FAKE_COMPUTER_APP } from '@otherbench/core/testing/fake-computer.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { DesktopChannelOptions } from '../../src/computer/desktop-channel.js';
import {
  DESKTOP_BUSY_REASON,
  DESKTOP_ENDED_AFTER,
  DESKTOP_GONE_REASON,
  DESKTOP_NO_EXPECTATION_REASON,
  DESKTOP_NO_SCREENSHOT_REASON,
  DESKTOP_SESSION_GONE_REASON,
  MAX_QUEUED_PER_CHAT,
  type DesktopComputerDriverOptions,
} from '../../src/computer/desktop-driver.js';
import { COMPUTER_END_UNCONFIRMED_REASON, COMPUTER_NO_SESSION_REASON, ComputerSessions } from '../../src/computer/sessions.js';
import { connected, endedChats, type FakeShell, type ShellAnswer } from './fake-shell.js';

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
      expect(endedChats(shell)).toEqual(['c']);
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
    expect(endedChats(shell)).toEqual(['c']);
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
    expect(endedChats(shell)).toEqual(['c']);
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
    expect(endedChats(shell)).toEqual(['c']);
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
      "The desktop app didn't answer the request to control this computer in time, so nothing was started. OtherBench couldn't confirm that the desktop app cancelled it."
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
      expect(String(call[0])).toMatch(/^\[otherbench-server\] couldn't confirm that the desktop app ended computer use for chat c: /);
      expect(String(call[0])).not.toMatch(/OTHERBENCH-RPC|computer\.end|\n/);
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
      reason: "The desktop app didn't answer in time. Whether the action was carried out is not known. OtherBench has ended the control session, so nothing more is done.",
    });
    expect(endedChats(shell)).toEqual(['c']);
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

  it("is ended in the server as well: the record goes, the end is announced, the chat's replies are cancelled, and an OK that comes late changes nothing", async () => {
    const { sessions, shell, events, cancelChat } = await inControl({ driver: { actTimeoutMs: 30 } });
    shell.override = silentOn('computer.act');
    expect((await sessions.act('c', TYPE, EXPECT)).ok).toBe(false);
    expect(sessions.activeChat()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c', active: false });
    // As for a stop from the shell: the reply does not go on without the session it was using.
    expect(cancelChat.mock.calls).toEqual([['c']]);
    shell.override = () => undefined;
    shell.answer(shell.idOf('computer.act'), { ok: true });
    await tick();
    expect(sessions.activeChat()).toBeNull();
    expect(shell.sent('computer.act')).toHaveLength(1);
  });
});

describe('the shell is the source of truth: what the server believed is dropped at the first sign it is wrong', () => {
  it('nothing is looked at or done before the person said yes: no token, nothing sent', async () => {
    const made = await connected();
    const sessions = new ComputerSessions(made.driver, { emit: () => {}, cancelChat: () => {} }, { endTimeoutMs: 200 });
    expect(await sessions.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    // Even asked directly, the driver sends nothing for a chat the shell gave no token for.
    expect(await made.driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(await made.driver.target('c', 'foreground')).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
    await expect(made.driver.screenshot('c')).rejects.toThrow(COMPUTER_NO_SESSION_REASON);
    await expect(made.driver.cursorPosition('c')).rejects.toThrow(COMPUTER_NO_SESSION_REASON);
    expect(made.shell.methods()).toEqual(['computer.hello']);
  });

  it('a yes with no token it can use is no session: the shell is told to end whatever it holds, and nothing else is sent', async () => {
    for (const session of [undefined, null, 7, '', 'short', 'has a space in it, so no', 'x'.repeat(129), 'tok\u00e9n-with-a-letter-outside', ['session_00000001_fake']]) {
      const made = await connected();
      const sessions = new ComputerSessions(made.driver, { emit: () => {}, cancelChat: () => {} }, { endTimeoutMs: 200 });
      made.shell.override = (method) => (method === 'computer.start' ? { result: session === undefined ? { ok: true } : { ok: true, session } } : undefined);
      made.shell.sessions.add('c');
      expect(await sessions.ensureSession('c', 'Budget'), JSON.stringify(session)).toEqual({ ok: false, reason: "The desktop app's answer couldn't be read, so nothing was started." });
      expect(endedChats(made.shell)).toEqual(['c']);
      expect(made.shell.sessions.has('c')).toBe(false);
      expect(sessions.activeChat()).toBeNull();
      expect(await made.driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
      expect(made.shell.methods()).toEqual(['computer.hello', 'computer.start', 'computer.end']);
    }
  });

  it('an action goes only with the whole approved app, window and run: anything less is refused before the shell is asked', async () => {
    const { driver, shell } = await inControl();
    const before = shell.methods().length;
    const partial: unknown[] = [
      undefined,
      null,
      {},
      { ...EXPECT, app: undefined },
      { ...EXPECT, app: 'notepad.exe' },
      { ...EXPECT, shellView: undefined },
      { ...EXPECT, shellView: 'false' },
      { ...EXPECT, windowId: '' },
      { ...EXPECT, pid: '4242' },
      { ...EXPECT, pid: 0 },
      { ...EXPECT, startedAt: null },
      'C:\\Program Files\\Fake App\\FakeApp.exe',
    ];
    for (const expect_ of partial) {
      expect(await driver.act('c', TYPE, expect_ as ComputerExpectation), JSON.stringify(expect_)).toEqual({ ok: false, reason: DESKTOP_NO_EXPECTATION_REASON });
    }
    expect(shell.methods()).toHaveLength(before);
    // The session is untouched: that was OtherBench's own mistake, not the shell's.
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: true });
  });

  /** The shell no longer has the session the server named: it restarted it, or lost it. */
  const forget = (shell: FakeShell): void => {
    shell.sessions.add('c');
  };

  for (const [label, call] of [
    ['a screenshot', (s: ComputerSessions) => s.screenshot('c').then(() => 'done', (e: Error) => e.message)],
    ['the cursor', (s: ComputerSessions) => s.cursorPosition('c').then(() => 'done', (e: Error) => e.message)],
    ['a target', (s: ComputerSessions) => s.target('c', 'foreground').then((t) => ('refuse' in t ? (t.refuse as string) : 'done'), (e: Error) => e.message)],
    ['an action', (s: ComputerSessions) => s.act('c', TYPE, EXPECT).then((a) => (a.ok ? 'done' : a.reason))],
  ] as const) {
    it(`a token the shell says is not its live session, on ${label}: the session is ended, and the next call needs a new start with a new token`, async () => {
      const { sessions, shell, events, cancelChat } = await inControl();
      const old = shell.tokenOf('c');
      forget(shell);
      expect(await call(sessions)).toBe(`${DESKTOP_SESSION_GONE_REASON} ${DESKTOP_ENDED_AFTER}`);
      expect(sessions.activeChat()).toBeNull();
      expect(cancelChat.mock.calls).toEqual([['c']]);
      expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c', active: false });
      expect(endedChats(shell)[0]).toBe('c');
      expect(await sessions.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
      // A new start brings the dialog up again, and every request from then on names the new session.
      const starts = shell.sent('computer.start').length;
      expect(await sessions.ensureSession('c', 'Budget')).toEqual({ ok: true });
      expect(shell.sent('computer.start')).toHaveLength(starts + 1);
      expect(await sessions.act('c', TYPE, EXPECT)).toEqual({ ok: true });
      const token = (shell.sent('computer.act').at(-1) as { session: string }).session;
      expect(token).toBe(shell.tokenOf('c'));
      expect(token).not.toBe(old);
    });
  }

  /** Everything the server believed of every session is gone, and nothing more is sent. */
  async function expectAllLost(made: Awaited<ReturnType<typeof inControl>>, writesAfter: number): Promise<void> {
    const { sessions, events, driver, shell, cancelChat } = made;
    await vi.waitFor(() => expect(sessions.activeChat()).toBeNull());
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c', active: false });
    // The replies of the chat that held the session are cancelled, and no other chat's.
    expect(cancelChat.mock.calls).toEqual([['c']]);
    expect(sessions.available()).toBe(false);
    expect(driver.reservedKeys()).toBeNull();
    expect(await sessions.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: DESKTOP_GONE_REASON });
    // Nothing starts again on this channel: a new channel, and a new hello, are the only way back.
    expect((await sessions.ensureSession('d', 'Other')).ok).toBe(false);
    expect(shell.lines).toHaveLength(writesAfter);
  }

  it('an answer to a request that already had one: the channel closes, every session with it, and the shell is told', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const made = await inControl();
    made.shell.answer(made.shell.idOf('computer.screenshot'), { png: 'again' });
    await vi.waitFor(() => expect(made.channel.closed).toBe(true));
    expect(made.shell.notified).toEqual([{ method: 'computer.close', params: {} }]);
    expect(made.shell.sessions.size).toBe(0);
    await expectAllLost(made, made.shell.lines.length);
  });

  it('a OTHERBENCH-RPC frame that is not one: the same', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const made = await inControl();
    made.shell.fromShell.write('OTHERBENCH-RPC {"id": oops\n');
    await vi.waitFor(() => expect(made.channel.closed).toBe(true));
    expect(made.shell.notified).toEqual([{ method: 'computer.close', params: {} }]);
    await expectAllLost(made, made.shell.lines.length);
  });

  it('a flood of events: the same', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const made = await inControl({ channel: { maxEventsPerSecond: 10 } });
    for (let i = 0; i < 11; i += 1) made.shell.event('computer.shortcuts', { shortcuts: [] });
    await vi.waitFor(() => expect(made.channel.closed).toBe(true));
    await expectAllLost(made, made.shell.lines.length);
  });

  it('a pipe that fails (EPIPE): the same, and nothing more is written to it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const made = await inControl();
    made.shell.override = silentOn('computer.act');
    const acting = made.sessions.act('c', TYPE, EXPECT);
    await tick();
    made.shell.breakPipe();
    expect(await acting).toEqual({ ok: false, reason: 'The desktop app went away. Whether the action was carried out is not known.' });
    expect(made.channel.closed).toBe(true);
    expect(made.shell.notified).toEqual([]);
    await expectAllLost(made, made.shell.lines.length);
  });

  it('the shell goes away (it quit, or restarted with a new server of its own): the same', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const made = await inControl();
    made.shell.close();
    await expectAllLost(made, made.shell.lines.length);
    // The end could not be confirmed: the server keeps it as one the shell may still hold.
    expect(await made.sessions.ensureSession('c', 'Budget')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    // Said in the server's log, in its own words.
    expect(String(logged.mock.calls[0]![0])).toBe(
      "[otherbench-server] couldn't confirm that the desktop app ended computer use for chat c: The desktop app went away before it confirmed that the control session ended."
    );
  });
});
