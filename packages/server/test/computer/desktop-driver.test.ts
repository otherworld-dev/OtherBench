import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyTarget, COMPUTER_LIMITS, expectationOf, parseAction } from '@grunt/core/domain/computer-apps.js';
import { MAX_TOOL_IMAGE_BYTES } from '@grunt/core/domain/tool-images.js';
import type { ComputerAction, ComputerExpectation } from '@grunt/core/ports/computer.js';
import { FAKE_COMPUTER_APP, FAKE_PNG, fakeComputerTarget } from '@grunt/core/testing/fake-computer.js';
import { RPC_PREFIX, type ShellChannel } from '../../src/computer/desktop-channel.js';
import {
  ACT_TIMEOUT_MS,
  DESKTOP_BUSY_REASON,
  DESKTOP_ENDED_AFTER,
  DESKTOP_END_PENDING_REASON,
  DESKTOP_NO_POINT_REASON,
  DESKTOP_NO_SCREENSHOT_REASON,
  DESKTOP_NOT_AVAILABLE_REASON,
  DESKTOP_OUTSIDE_REASON,
  DesktopComputerDriver,
  END_TIMEOUT_MS,
  MAX_QUEUED_PER_CHAT,
  MAX_TRACKED_CHATS,
  SESSION_TOKEN,
  START_LATE_WATCH_MS,
  START_TIMEOUT_MS,
} from '../../src/computer/desktop-driver.js';
import { COMPUTER_END_TIMEOUT_MS, COMPUTER_NO_SESSION_REASON, ComputerSessions } from '../../src/computer/sessions.js';
import { connect, connected, endedChats, FakeShell, HELLO_OFF, HELLO_ON, pngOf, SHELL_NO_SESSION, shotOf, type ShellAnswer } from './fake-shell.js';

/**
 * `DesktopComputerDriver` against a stand-in shell only (fake-shell.ts): an
 * in-memory pair of pipes with something on the far end that answers like
 * the shell must. Nothing here moves a mouse, presses a key or looks at a
 * screen, and no shell or desktop app is started.
 */

/** A canonical action, built the only way one is built. */
function action(args: Record<string, unknown>): ComputerAction {
  const parsed = parseAction(args, { bounds: { width: 1366, height: 768 }, reserved: [] });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.action as ComputerAction;
}

/** The expectation a card for the fake app would carry. */
function expectFor(over: Partial<typeof FAKE_COMPUTER_APP> = {}): ComputerExpectation {
  const t = fakeComputerTarget(over);
  const expectation = expectationOf({ app: t.path, appShellView: t.shellView, appWindow: t.windowId, appPid: t.pid, appStarted: t.startedAt });
  if (expectation === null) throw new Error('no expectation');
  return expectation;
}

const CLICK = action({ action: 'left_click', coordinate: [10, 20] });
const TYPE = action({ action: 'type', text: 'hello' });
const KEY = action({ action: 'key', text: 'ctrl+s' });
const EXPECT = expectFor();

const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The error a call rejected with. */
async function rejection(call: Promise<unknown>): Promise<Error> {
  const err = await call.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

/** One clean line of at most 300 characters and an ellipsis, with nothing of the channel's own in it. */
function expectClean(text: string): void {
  expect(text).not.toMatch(/[\r\n\u202e]/);
  expect(Array.from(text).length).toBeLessThanOrEqual(301);
  expect(text).not.toMatch(/GRUNT-RPC|computer\.[a-z]+|"id"|DesktopChannel/);
}

/** A shell that is on, with a session and a screenshot for chat `c`. */
async function inSession(options: Parameters<typeof connected>[0] = {}) {
  const made = await connected(options);
  expect(await made.driver.ensureSession('c', 'Budget')).toEqual({ ok: true });
  await made.driver.screenshot('c');
  return made;
}

/** Takes requests for `method` over: they are read and not answered. */
const silentOn =
  (...methods: string[]) =>
  (method: string): ShellAnswer | undefined =>
    methods.includes(method) ? 'silent' : undefined;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DesktopComputerDriver: hello and availability', () => {
  it('is not available until the shell says hello, and asks with computer.hello {}', async () => {
    const { driver, shell } = connect();
    expect(driver.available()).toBe(false);
    await driver.hello();
    expect(shell.lines).toEqual(['GRUNT-RPC {"id":1,"method":"computer.hello","params":{}}\n']);
    expect(driver.available()).toBe(true);
  });

  it('is available only when a Windows shell says computer use is on, gives a shortcut list it can read and says it holds no session', async () => {
    const cases: [unknown, boolean][] = [
      [{ platform: 'win32', version: '0.1.0', available: true, shortcuts: [], sessions: 0 }, true],
      [HELLO_ON, true],
      // Every fact must be there and say so: anything missing, mistyped or unknown is "off".
      [{ platform: 'win32', version: '0.1.0', available: true }, false],
      [{ platform: 'win32', version: '0.1.0', available: true, shortcuts: [] }, false],
      [{ platform: 'win32', version: '0.1.0', available: true, sessions: 0 }, false],
      [{ ...HELLO_ON, sessions: 1 }, false],
      [{ ...HELLO_ON, sessions: '0' }, false],
      [{ ...HELLO_ON, sessions: null }, false],
      [{ ...HELLO_ON, shortcuts: null }, false],
      [{ ...HELLO_ON, shortcuts: ['F9', 7] }, false],
      [{ ...HELLO_ON, shortcuts: 'F9' }, false],
      [{ ...HELLO_ON, available: 'true' }, false],
      [{ ...HELLO_ON, platform: 'Win32' }, false],
      [{ ...HELLO_ON, platform: 'win32 ' }, false],
      [HELLO_OFF, false],
      [{ platform: 'win32', version: '0.1.0', shortcuts: [] }, false],
      [{ platform: 'win32', available: 'true', shortcuts: [] }, false],
      [{ platform: 'win32', available: 1, shortcuts: [] }, false],
      [{ platform: 'linux', available: true, shortcuts: [] }, false],
      [{ platform: 'darwin', available: true, shortcuts: [] }, false],
      [{ available: true, shortcuts: [] }, false],
      [null, false],
      [[], false],
      ['yes', false],
      [true, false],
    ];
    for (const [hello, expected] of cases) {
      const shell = new FakeShell();
      shell.hello = hello;
      const { driver } = connect({ shell });
      expect(driver.available(), JSON.stringify(hello)).toBe(false);
      await driver.hello();
      expect(driver.available(), JSON.stringify(hello)).toBe(expected);
    }
  });

  it('is not available when the shell answers the hello with an error, or not at all', async () => {
    const refusing = new FakeShell();
    refusing.override = () => ({ error: { message: 'old shell' } });
    const a = connect({ shell: refusing });
    await expect(a.driver.hello()).resolves.toBeUndefined();
    expect(a.driver.available()).toBe(false);

    const silent = new FakeShell();
    silent.override = () => 'silent';
    const b = connect({ shell: silent, driver: { callTimeoutMs: 20 } });
    await expect(b.driver.hello()).resolves.toBeUndefined();
    expect(b.driver.available()).toBe(false);
    // The answer that comes after the limit changes nothing.
    silent.answer(1, HELLO_ON);
    await tick();
    expect(b.driver.available()).toBe(false);
    expect(b.driver.reservedKeys()).toBeNull();
  });

  it('stops being available when the shell goes away', async () => {
    const { driver, shell } = await connected();
    expect(driver.available()).toBe(true);
    shell.close();
    await vi.waitFor(() => expect(driver.available()).toBe(false));
  });

  it('says hello once: a second call sends nothing, waits for the same answer and changes nothing', async () => {
    const shell = new FakeShell();
    shell.override = silentOn('computer.hello');
    const { driver } = connect({ shell });
    const reset = vi.fn();
    driver.onReset(reset);
    const first = driver.hello();
    const second = driver.hello();
    await tick();
    expect(shell.methods()).toEqual(['computer.hello']);
    shell.answer(1, HELLO_ON);
    await Promise.all([first, second]);
    expect(driver.available()).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);

    // Later, with a session: another hello is not sent, so it can neither turn computer use off nor reset anything.
    shell.override = () => undefined;
    await driver.ensureSession('c', 'Budget');
    shell.hello = HELLO_OFF;
    await driver.hello();
    expect(shell.methods().filter((m) => m === 'computer.hello')).toHaveLength(1);
    expect(driver.available()).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: true });
  });

  it('available() and reservedKeys() never throw, whatever the channel does', () => {
    const broken: ShellChannel = {
      get closed(): boolean {
        throw new Error('channel bug');
      },
      call: () => Promise.reject(new Error('channel bug')),
      onEvent: () => () => {},
      onClose: () => () => {},
    };
    const driver = new DesktopComputerDriver(broken);
    expect(driver.available()).toBe(false);
    expect(driver.reservedKeys()).toBeNull();
  });

  it('sends a shell that has not said computer use is on nothing but the hello', async () => {
    for (const hello of [HELLO_OFF, null]) {
      const shell = new FakeShell();
      shell.hello = hello;
      const { driver } = connect({ shell });
      const before = async () => {
        expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: false, reason: DESKTOP_NOT_AVAILABLE_REASON });
        expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: DESKTOP_NOT_AVAILABLE_REASON });
        expect(await driver.target('c', 'foreground')).toEqual({ refuse: DESKTOP_NOT_AVAILABLE_REASON });
        expect((await rejection(driver.screenshot('c'))).message).toBe(DESKTOP_NOT_AVAILABLE_REASON);
        expect((await rejection(driver.cursorPosition('c'))).message).toBe(DESKTOP_NOT_AVAILABLE_REASON);
        await expect(driver.endSession('c')).resolves.toBeUndefined();
      };
      await before();
      expect(shell.methods()).toEqual([]);
      await driver.hello();
      await before();
      expect(shell.methods()).toEqual(['computer.hello']);
    }
  });
});

describe("DesktopComputerDriver: the shell's shortcuts", () => {
  it('has no list until the hello answers, then the list the hello gave', async () => {
    const shell = new FakeShell();
    shell.override = silentOn('computer.hello');
    const { driver } = connect({ shell });
    expect(driver.reservedKeys()).toBeNull();
    const hello = driver.hello();
    await tick();
    expect(driver.reservedKeys()).toBeNull();
    shell.answer(1, { ...HELLO_ON, shortcuts: ['Ctrl+Shift+Space', 'Ctrl+Alt+Backspace'] });
    await hello;
    expect(driver.reservedKeys()).toEqual(['Ctrl+Shift+Space', 'Ctrl+Alt+Backspace']);
  });

  it('takes no list from an event before the hello has answered: not a list, and not an empty one', async () => {
    const shell = new FakeShell();
    shell.override = silentOn('computer.hello');
    const { driver } = connect({ shell });
    // Before the hello is even sent, and while it is on its way.
    shell.event('computer.shortcuts', { shortcuts: [] });
    shell.event('computer.shortcuts', { shortcuts: ['F9'] });
    await tick();
    expect(driver.reservedKeys()).toBeNull();
    const hello = driver.hello();
    shell.event('computer.shortcuts', { shortcuts: [] });
    await tick();
    expect(driver.reservedKeys()).toBeNull();
    // The hello's own word is the first list there is; events count from then on.
    shell.answer(1, { platform: 'win32', version: '0.1.0', available: false });
    await hello;
    expect(driver.reservedKeys()).toBeNull();
    shell.event('computer.shortcuts', { shortcuts: ['F9'] });
    await vi.waitFor(() => expect(driver.reservedKeys()).toEqual(['F9']));

    // A hello that was never answered leaves every event unheard.
    const mute = new FakeShell();
    mute.override = () => 'silent';
    const other = connect({ shell: mute, driver: { callTimeoutMs: 20 } });
    await other.driver.hello();
    mute.event('computer.shortcuts', { shortcuts: [] });
    await tick();
    expect(other.driver.reservedKeys()).toBeNull();
  });

  it('has no list when the hello gave none it can read: never an empty list in its place', async () => {
    const unreadable: unknown[] = [undefined, null, 'Ctrl+Shift+Space', {}, 0, false, ['F9', 7], ['F9', null], [['F9']], { 0: 'F9', length: 1 }];
    for (const shortcuts of unreadable) {
      const shell = new FakeShell();
      shell.hello = shortcuts === undefined ? { platform: 'win32', version: '0.1.0', available: true, sessions: 0 } : { ...HELLO_ON, shortcuts };
      const { driver } = await connected({ shell });
      // And computer use is off: a hello whose list can't be read leaves nothing on.
      expect(driver.available()).toBe(false);
      expect(driver.reservedKeys(), JSON.stringify(shortcuts)).toBeNull();
    }
    // A list the shell reported as empty is a list.
    const shell = new FakeShell();
    shell.hello = { ...HELLO_ON, shortcuts: [] };
    expect((await connected({ shell })).driver.reservedKeys()).toEqual([]);
  });

  it('follows every computer.shortcuts event after the hello, and an event it cannot read leaves no list at all', async () => {
    const { driver, shell } = await connected();
    expect(driver.reservedKeys()).toEqual(['Ctrl+Shift+Space']);
    shell.event('computer.shortcuts', { shortcuts: ['F9', 'Ctrl+Alt+Backspace'] });
    await vi.waitFor(() => expect(driver.reservedKeys()).toEqual(['F9', 'Ctrl+Alt+Backspace']));

    const unreadable: unknown[] = [{ shortcuts: ['F9', 7] }, { shortcuts: 'F9' }, { shortcuts: null }, {}, null, ['F9'], 'F9', { shortcuts: { 0: 'F9' } }];
    for (const params of unreadable) {
      shell.event('computer.shortcuts', { shortcuts: ['F9'] });
      await vi.waitFor(() => expect(driver.reservedKeys()).toEqual(['F9']));
      shell.event('computer.shortcuts', params);
      // The whole list goes: not the readable part of it, and not the one before.
      await vi.waitFor(() => expect(driver.reservedKeys(), JSON.stringify(params)).toBeNull());
    }
    shell.event('computer.shortcuts', { shortcuts: [] });
    await vi.waitFor(() => expect(driver.reservedKeys()).toEqual([]));
  });

  it('has no list once the shell has gone away', async () => {
    const { driver, shell } = await connected();
    expect(driver.reservedKeys()).toEqual(['Ctrl+Shift+Space']);
    shell.close();
    await vi.waitFor(() => expect(driver.reservedKeys()).toBeNull());
  });

  it('hands out a frozen copy, and takes a list too long to be one as no list', async () => {
    const { driver, shell } = await connected();
    const list = driver.reservedKeys()!;
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => (list as string[]).push('F9')).toThrow();
    shell.event('computer.shortcuts', { shortcuts: Array.from({ length: 65 }, (_, i) => `F${i}`) });
    await vi.waitFor(() => expect(driver.reservedKeys()).toBeNull());
    shell.event('computer.shortcuts', { shortcuts: ['F9'] });
    await vi.waitFor(() => expect(driver.reservedKeys()).toEqual(['F9']));
    shell.event('computer.shortcuts', { shortcuts: ['x'.repeat(257)] });
    await vi.waitFor(() => expect(driver.reservedKeys()).toBeNull());
  });

  it('with no list, core refuses every key action; with the list, the shortcut on it', async () => {
    const { driver, shell } = await connected();
    // A list it can't read, after the hello: no list at all.
    shell.event('computer.shortcuts', { shortcuts: null });
    await vi.waitFor(() => expect(driver.reservedKeys()).toBeNull());
    for (const text of ['ctrl+s', 'Return', 'F9']) {
      expect(parseAction({ action: 'key', text }, { reserved: driver.reservedKeys() }).ok, text).toBe(false);
    }
    shell.event('computer.shortcuts', { shortcuts: ['Ctrl+Shift+Space'] });
    await vi.waitFor(() => expect(driver.reservedKeys()).not.toBeNull());
    expect(parseAction({ action: 'key', text: 'ctrl+s' }, { reserved: driver.reservedKeys() }).ok).toBe(true);
    expect(parseAction({ action: 'key', text: 'ctrl+shift+space' }, { reserved: driver.reservedKeys() }).ok).toBe(false);
  });
});

describe('DesktopComputerDriver: starting a session', () => {
  it('asks with computer.start { chatId, title } and answers what the shell said', async () => {
    const { driver, shell } = await connected();
    expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: true });
    expect(shell.lines[1]).toBe('GRUNT-RPC {"id":2,"method":"computer.start","params":{"chatId":"c","title":"Budget"}}\n');
    // Again for the same chat: the shell is asked again and says the session goes on.
    expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: true });
    expect(shell.sent('computer.start')).toEqual([
      { chatId: 'c', title: 'Budget' },
      { chatId: 'c', title: 'Budget' },
    ]);
  });

  it('has one start with the shell per chat at a time: whoever asks meanwhile gets its answer', async () => {
    const { driver, shell } = await connected();
    shell.override = silentOn('computer.start');
    const asked = Array.from({ length: 80 }, () => driver.ensureSession('c', 'Budget'));
    const other = driver.ensureSession('d', 'Other');
    await tick();
    expect(shell.sent('computer.start')).toEqual([
      { chatId: 'c', title: 'Budget' },
      { chatId: 'd', title: 'Other' },
    ]);
    shell.sessions.add('c');
    shell.answer(2, { ok: true, session: shell.tokenOf('c') });
    shell.answer(3, { ok: false, reason: 'no' });
    expect(await Promise.all(asked)).toEqual(Array.from({ length: 80 }, () => ({ ok: true })));
    expect(await other).toEqual({ ok: false, reason: 'no' });
    // Once it has settled, the next one asks the shell again.
    shell.override = () => undefined;
    await driver.ensureSession('c', 'Budget');
    expect(shell.sent('computer.start')).toHaveLength(3);
  });

  it("answers the shell's refusal as it is, bounded to one clean line, and keeps no session", async () => {
    const { driver, shell } = await connected();
    shell.startAnswer = { ok: false, reason: "The user didn't let Grunt control the computer." };
    expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: false, reason: "The user didn't let Grunt control the computer." });
    shell.startAnswer = { ok: false, reason: `no\nthanks\u202e ${'x'.repeat(2000)}` };
    const long = await driver.ensureSession('c', 'Budget');
    expect(long.ok).toBe(false);
    if (!long.ok) {
      expect(long.reason.startsWith('no thanks x')).toBe(true);
      expectClean(long.reason);
    }
    for (const reason of [undefined, 7, '', null, { text: 'no' }]) {
      shell.startAnswer = { ok: false, reason };
      expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: false, reason: 'The desktop app refused to start controlling this computer.' });
    }
    // Nothing was ended: this side had no session for the chat, and the shell said itself that there is none.
    expect(endedChats(shell)).toEqual([]);
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
  });

  it("answers the shell's error as a refusal, not a throw", async () => {
    const { driver, shell } = await connected();
    shell.override = (method) => (method === 'computer.start' ? { error: { message: 'Computer use is off in this Grunt desktop app.' } } : undefined);
    expect(await driver.ensureSession('c', 'x')).toEqual({ ok: false, reason: 'Computer use is off in this Grunt desktop app.' });
    expect(endedChats(shell)).toEqual([]);
  });

  it('a start that does not end in a yes for a chat WITH a session on record ends that session at the shell', async () => {
    // The caller is about to be told there is no session, so there must be none: with the shell, and here.
    const outcomes: [string, ShellAnswer, string][] = [
      ['the shell refuses', { result: { ok: false, reason: 'not now' } }, 'not now'],
      ['the shell errors', { error: { message: 'internal failure' } }, 'internal failure'],
    ];
    for (const [label, answer, reason] of outcomes) {
      const { driver, shell } = await inSession();
      shell.override = (method) => (method === 'computer.start' ? answer : undefined);
      expect(await driver.ensureSession('c', 'Budget'), label).toEqual({ ok: false, reason });
      expect(endedChats(shell), label).toEqual(['c']);
      expect(shell.sessions.has('c'), label).toBe(false);
      expect(await driver.act('c', TYPE, EXPECT), label).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    }
  });

  it('the same when the start could not even be sent (the channel is full): the end still goes out', async () => {
    const { driver, shell } = await inSession({ channel: { maxPending: 2 } });
    // Two other chats' dialogs are up and take every ordinary place.
    shell.override = (method, params) => (method === 'computer.start' && params['chatId'] !== 'c' ? 'silent' : undefined);
    const others = [driver.ensureSession('x', 'X'), driver.ensureSession('y', 'Y')];
    await tick();
    expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: false, reason: 'The desktop app has too many requests waiting; nothing was sent.' });
    expect(shell.sent('computer.start').filter((p) => (p as { chatId: string }).chatId === 'c')).toHaveLength(1);
    expect(endedChats(shell)).toEqual(['c']);
    expect(shell.sessions.has('c')).toBe(false);
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    // With no session on record, the same refusal has nothing to end.
    expect(await driver.ensureSession('z', 'Z')).toEqual({ ok: false, reason: 'The desktop app has too many requests waiting; nothing was sent.' });
    expect(shell.sent('computer.end')).toHaveLength(1);
    shell.close();
    await Promise.allSettled(others);
  });

  it('gives up on a dialog nobody answers: it tells the shell to end that start, and answers a refusal', async () => {
    const { driver, shell } = await connected({ driver: { startTimeoutMs: 30 } });
    shell.override = silentOn('computer.start');
    const answer = await driver.ensureSession('c', 'Budget');
    expect(answer).toEqual({ ok: false, reason: "The desktop app didn't answer the request to control this computer in time, so nothing was started." });
    expect(shell.methods()).toEqual(['computer.hello', 'computer.start', 'computer.end']);
    expect(endedChats(shell)).toEqual(['c']);
    // No session here, whatever comes later.
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
  });

  it('a start it gave up on holds no place among the waiting calls: only a note, for a while', async () => {
    const { driver, shell, channel } = await connected({ driver: { startTimeoutMs: 20, startLateMs: 300 } });
    shell.override = silentOn('computer.start');
    expect((await driver.ensureSession('c', 'Budget')).ok).toBe(false);
    expect(channel.pendingCalls).toBe(0);
    expect(channel.lateNotes).toBe(1);
    await vi.waitFor(() => expect(channel.lateNotes).toBe(0));
  });

  it('a yes that comes after it gave up is not a session: the shell is told to end it again', async () => {
    const { driver, shell } = await connected({ driver: { startTimeoutMs: 30 } });
    shell.override = silentOn('computer.start');
    expect((await driver.ensureSession('c', 'Budget')).ok).toBe(false);
    expect(shell.sent('computer.end')).toHaveLength(1);
    // The person says OK to the old dialog; a shell that got this wrong now holds a session.
    shell.sessions.add('c');
    shell.answer(shell.idOf('computer.start'), { ok: true });
    await vi.waitFor(() => expect(endedChats(shell)).toEqual(['c', 'c']));
    await vi.waitFor(() => expect(shell.sessions.has('c')).toBe(false));
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(shell.sent('computer.act')).toEqual([]);
  });

  it('a no that comes after it gave up needs nothing more', async () => {
    const { driver, shell } = await connected({ driver: { startTimeoutMs: 30 } });
    shell.override = silentOn('computer.start');
    expect((await driver.ensureSession('c', 'Budget')).ok).toBe(false);
    shell.answer(shell.idOf('computer.start'), { ok: false, reason: 'cancelled' });
    await wait(20);
    expect(shell.sent('computer.end')).toHaveLength(1);
  });

  it('a late yes for an old start leaves a session that a newer start made alone', async () => {
    const { driver, shell } = await connected({ driver: { startTimeoutMs: 30 } });
    shell.override = silentOn('computer.start');
    expect((await driver.ensureSession('c', 'Budget')).ok).toBe(false);
    const old = shell.idOf('computer.start');
    shell.override = () => undefined;
    expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: true });
    shell.answer(old, { ok: true });
    await wait(20);
    expect(shell.sent('computer.end')).toHaveLength(1);
    expect(shell.sessions.has('c')).toBe(true);
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: true });
  });

  it('throws, in its own words, when it gave up and the shell did not confirm the end', async () => {
    const { driver, shell } = await connected({ driver: { startTimeoutMs: 30, endTimeoutMs: 30 } });
    shell.override = silentOn('computer.start', 'computer.end');
    const err = await rejection(driver.ensureSession('c', 'Budget'));
    expect(err.message).toBe(
      "The desktop app didn't answer the request to control this computer in time, so nothing was started. Grunt couldn't confirm that the desktop app cancelled it."
    );
    expectClean(err.message);
    expect(endedChats(shell)).toEqual(['c']);
    // Asked again, the driver asks the shell again, and says so while the shell will not confirm.
    expect((await rejection(driver.endSession('c'))).message).toBe("The desktop app didn't answer in time.");
    shell.override = () => undefined;
    await expect(driver.endSession('c')).resolves.toBeUndefined();
    expect(shell.sent('computer.end')).toHaveLength(3);
  });

  it('starts nothing, for any chat, while the shell has not confirmed an end it was asked for: it asks again first', async () => {
    const { driver, shell } = await inSession({ driver: { endTimeoutMs: 30 } });
    await driver.ensureSession('d', 'Other');
    shell.override = silentOn('computer.end');
    await expect(driver.endSession('c')).rejects.toThrow("didn't answer in time");
    await expect(driver.endSession('d')).rejects.toThrow("didn't answer in time");
    const starts = shell.sent('computer.start').length;
    const ends = shell.sent('computer.end').length;
    for (const chatId of ['c', 'e']) {
      const err = await rejection(driver.ensureSession(chatId, 'Any'));
      expect(err.message).toBe(DESKTOP_END_PENDING_REASON);
    }
    expect(shell.sent('computer.start')).toHaveLength(starts);
    // Each refused start asked for ONE of the ends again and stopped at that failure: it did not wait for both.
    expect(shell.sent('computer.end')).toHaveLength(ends + 2);
    // Once the shell confirms them, the start goes through.
    shell.override = () => undefined;
    expect(await driver.ensureSession('e', 'Any')).toEqual({ ok: true });
    expect(shell.sent('computer.end')).toHaveLength(ends + 4);
    expect([...shell.sessions.keys()]).toEqual(['e']);
  });

  it('takes an answer it cannot read as not knowing: the start is ended, and refused', async () => {
    for (const startAnswer of [{ ok: 'yes' }, { ok: 1 }, {}, null, 'ok', true, [true], { result: { ok: true } }]) {
      const { driver, shell } = await connected();
      shell.override = (method) => (method === 'computer.start' ? { result: startAnswer } : undefined);
      expect(await driver.ensureSession('c', 'Budget'), JSON.stringify(startAnswer)).toEqual({
        ok: false,
        reason: "The desktop app's answer couldn't be read, so nothing was started.",
      });
      expect(endedChats(shell)).toEqual(['c']);
      expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    }
  });

  it('throws when the shell goes away while its dialog is up: nobody can say what came of it', async () => {
    const { driver, shell } = await connected();
    shell.override = silentOn('computer.start');
    const starting = driver.ensureSession('c', 'Budget');
    await tick();
    shell.close();
    const err = await rejection(starting);
    expect(err.message).toBe("The desktop app went away. Grunt couldn't confirm that the desktop app cancelled it.");
    expectClean(err.message);
    // Afterwards nothing is sent, and a start is a plain refusal.
    expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: false, reason: 'The desktop app went away.' });
  });

  it('keeps track of a bounded number of chats and refuses a start beyond that without asking', async () => {
    const { driver, shell } = await connected();
    for (let i = 0; i < MAX_TRACKED_CHATS; i += 1) expect(await driver.ensureSession(`chat-${i}`, 'x')).toEqual({ ok: true });
    expect(await driver.ensureSession('one-more', 'x')).toEqual({ ok: false, reason: 'Grunt is keeping track of too many control sessions; stop one first.' });
    expect(shell.sent('computer.start')).toHaveLength(MAX_TRACKED_CHATS);
    // A chat it already knows is still asked about, and an ended one makes room.
    expect(await driver.ensureSession('chat-0', 'x')).toEqual({ ok: true });
    await driver.endSession('chat-1');
    expect(await driver.ensureSession('one-more', 'x')).toEqual({ ok: true });
    expect(MAX_TRACKED_CHATS).toBe(64);
  });

  it('waits two minutes for the dialog, ten more for a late answer, and under the sessions limit for an end', () => {
    expect(START_TIMEOUT_MS).toBe(120_000);
    expect(START_LATE_WATCH_MS).toBe(600_000);
    expect(ACT_TIMEOUT_MS).toBe(60_000);
    expect(END_TIMEOUT_MS).toBe(4000);
    expect(END_TIMEOUT_MS).toBeLessThan(COMPUTER_END_TIMEOUT_MS);
  });
});

describe('DesktopComputerDriver: ending a session', () => {
  it('asks with computer.end { chatId, session } for that chat alone, as often as it is asked; without a token once it has none', async () => {
    const { driver, shell } = await connected();
    await driver.ensureSession('c', 'One');
    await driver.ensureSession('d', 'Two');
    const token = shell.tokenOf('c');
    expect(token).toMatch(SESSION_TOKEN);
    await expect(driver.endSession('c')).resolves.toBeUndefined();
    expect(shell.lines.at(-1)).toBe(`GRUNT-RPC {"id":4,"method":"computer.end","params":{"chatId":"c","session":"${token}"}}\n`);
    expect([...shell.sessions.keys()]).toEqual(['d']);
    // Again, and for a chat that never had one: the same request, the same answer, nothing else touched.
    await expect(driver.endSession('c')).resolves.toBeUndefined();
    await expect(driver.endSession('never')).resolves.toBeUndefined();
    expect(shell.sent('computer.end')).toEqual([{ chatId: 'c', session: token }, { chatId: 'c' }, { chatId: 'never' }]);
    expect([...shell.sessions.keys()]).toEqual(['d']);
    expect(await driver.act('d', TYPE, EXPECT)).toEqual({ ok: true });
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
  });

  it('has one end with the shell per chat at a time: whoever asks meanwhile gets its answer', async () => {
    const { driver, shell } = await inSession();
    shell.override = silentOn('computer.end');
    const ends = Array.from({ length: 200 }, () => driver.endSession('c'));
    await tick();
    expect(endedChats(shell)).toEqual(['c']);
    shell.answer(shell.idOf('computer.end'), { ok: true });
    await expect(Promise.all(ends)).resolves.toHaveLength(200);
  });

  it('forgets the session at once, before the shell has answered', async () => {
    const { driver, shell } = await inSession();
    shell.override = silentOn('computer.end');
    const ending = driver.endSession('c');
    expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(await driver.target('c', 'foreground')).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
    expect(shell.sent('computer.act')).toEqual([]);
    shell.answer(shell.idOf('computer.end'), { ok: true });
    await expect(ending).resolves.toBeUndefined();
  });

  it('is confirmed by { ok: true } and by nothing else; anything else rejects, and it resolves once the shell does confirm', async () => {
    const unreadable = "The desktop app's answer couldn't be read, so Grunt can't tell whether the control session ended.";
    const failures: [ShellAnswer, string][] = [
      [{ error: { message: 'A key could not be released.' } }, 'A key could not be released.'],
      [{ result: { ok: false, reason: 'A key could not be released.' } }, 'A key could not be released.'],
      [{ result: { ok: false } }, "The desktop app couldn't end the control session."],
      [{ result: {} }, unreadable],
      [{ result: { ok: 'false' } }, unreadable],
      [{ result: { ok: 'true' } }, unreadable],
      [{ result: { ok: 0 } }, unreadable],
      [{ result: { ok: 1 } }, unreadable],
      [{ result: { ok: null } }, unreadable],
      [{ result: { error: { message: 'could not end' } } }, unreadable],
      [{ result: { refuse: 'no' } }, unreadable],
      [{ result: { ended: false } }, unreadable],
      [{ result: { ended: true } }, unreadable],
      [{ result: null }, unreadable],
      [{ result: 'done' }, unreadable],
      [{ result: true }, unreadable],
      [{ result: [] }, unreadable],
      [{ result: [{ ok: true }] }, unreadable],
      ['silent', "The desktop app didn't answer in time."],
    ];
    for (const [answer, message] of failures) {
      const { driver, shell } = await inSession({ driver: { endTimeoutMs: 30 } });
      shell.override = (method) => (method === 'computer.end' ? answer : undefined);
      const err = await rejection(driver.endSession('c'));
      expect(err.message, JSON.stringify(answer)).toBe(message);
      expectClean(err.message);
      // Still unconfirmed the second time, and it holds a start back; confirmed the third.
      await expect(driver.endSession('c')).rejects.toThrow(message);
      expect((await rejection(driver.ensureSession('d', 'Other'))).message, JSON.stringify(answer)).toBe(DESKTOP_END_PENDING_REASON);
      shell.override = () => undefined;
      await expect(driver.endSession('c')).resolves.toBeUndefined();
      expect(endedChats(shell)).toEqual(['c', 'c', 'c', 'c']);
      expect(await driver.ensureSession('d', 'Other')).toEqual({ ok: true });
    }
  });

  it('takes { ok: true } with more beside it as confirmed', async () => {
    const { driver, shell } = await inSession();
    shell.endAnswer = { ok: true, released: ['ctrl'] };
    await expect(driver.endSession('c')).resolves.toBeUndefined();
  });

  it("an end while the start dialog is still up goes to the shell too, and a yes that still comes is the caller's to end", async () => {
    const { driver, shell } = await connected();
    shell.override = silentOn('computer.start');
    const starting = driver.ensureSession('c', 'Budget');
    await tick();
    // Stop while the dialog is up: the shell is told (it cancels the dialog), and the start then says no.
    await expect(driver.endSession('c')).resolves.toBeUndefined();
    expect(shell.methods()).toEqual(['computer.hello', 'computer.start', 'computer.end']);
    shell.answer(shell.idOf('computer.start'), { ok: false, reason: 'cancelled' });
    expect(await starting).toEqual({ ok: false, reason: 'cancelled' });

    // A shell that says yes all the same: the answer is handed on as it is, and the next end is asked of the shell again.
    const again = driver.ensureSession('c', 'Budget');
    await tick();
    await driver.endSession('c');
    shell.sessions.add('c');
    shell.answer(shell.idOf('computer.start'), { ok: true, session: shell.tokenOf('c') });
    expect(await again).toEqual({ ok: true });
    shell.override = () => undefined;
    await driver.endSession('c');
    expect(shell.sessions.has('c')).toBe(false);
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
  });

  it('on a channel that has closed: resolves when it has nothing to end, and sends nothing', async () => {
    const { driver, shell } = await connected();
    shell.close();
    await vi.waitFor(() => expect(driver.available()).toBe(false));
    await expect(driver.endSession('c')).resolves.toBeUndefined();
    await expect(driver.endSession('c')).resolves.toBeUndefined();
    expect(shell.methods()).toEqual(['computer.hello']);
  });

  it('on a channel that closed with a session still on record: rejects, since the shell never confirmed', async () => {
    const { driver, shell } = await inSession();
    shell.close();
    await vi.waitFor(() => expect(driver.available()).toBe(false));
    const err = await rejection(driver.endSession('c'));
    expect(err.message).toBe('The desktop app went away before it confirmed that the control session ended.');
    await expect(driver.endSession('c')).rejects.toThrow('went away before it confirmed');
    // Another chat, which had nothing, is not held up by it.
    await expect(driver.endSession('d')).resolves.toBeUndefined();
    expect(endedChats(shell)).toEqual([]);
  });

  it('when the channel closes, every session is dropped at once: the calls waiting their turn are not sent, and each chat is reported lost', async () => {
    const { driver, shell } = await inSession();
    await driver.ensureSession('d', 'Other');
    const lost = vi.fn();
    driver.onLost(lost);
    shell.override = silentOn('computer.act');
    const working = driver.act('c', TYPE, EXPECT);
    const queued = [driver.act('c', TYPE, EXPECT), driver.act('c', KEY, EXPECT)];
    await tick();
    shell.close();
    expect(await Promise.all(queued)).toEqual(queued.map(() => ({ ok: false, reason: COMPUTER_NO_SESSION_REASON })));
    expect((await working).ok).toBe(false);
    expect(lost.mock.calls).toEqual([['c'], ['d']]);
    expect(shell.sent('computer.act')).toHaveLength(1);
    // Both are ends the shell never confirmed.
    await expect(driver.endSession('c')).rejects.toThrow('went away before it confirmed');
    await expect(driver.endSession('d')).rejects.toThrow('went away before it confirmed');
  });

  it('rejects when the shell goes away while the end is on its way', async () => {
    const { driver, shell } = await inSession();
    shell.override = silentOn('computer.end');
    const ending = driver.endSession('c');
    await tick();
    shell.close();
    expect((await rejection(ending)).message).toBe('The desktop app went away.');
  });

  it('reaches the shell when every ordinary place on the channel is taken', async () => {
    // The reviewer's probe, at the driver: the channel is full of other calls, and Stop still goes out.
    const { driver, shell, channel } = await inSession({ channel: { maxPending: 4 } });
    for (const chatId of ['d', 'e', 'f']) await driver.ensureSession(chatId, chatId);
    shell.override = silentOn('computer.act');
    const acts = ['c', 'd', 'e', 'f'].map((chatId) => driver.act(chatId, TYPE, EXPECT));
    await tick();
    expect(channel.pendingCalls).toBe(4);
    expect(shell.sent('computer.act')).toHaveLength(4);

    await expect(driver.endSession('c')).resolves.toBeUndefined();
    expect(endedChats(shell)).toEqual(['c']);
    expect(shell.sessions.has('c')).toBe(false);
    // The action that was with the shell is not waited for any longer: whatever it answers now is not this session's.
    expect(await acts[0]).toEqual({ ok: false, reason: 'The control session ended while the desktop app was working. Whether the action was carried out is not known.' });
    shell.answer(shell.asked.find((r) => r.method === 'computer.act')!.id, { ok: true });
    shell.close();
    await Promise.allSettled(acts);
  });
});

describe('DesktopComputerDriver: nothing is written for a session once it has ended, however close the end comes', () => {
  /** The calls a chat can make, each started and left unawaited, so that an end can come in the same tick. */
  const calls: [string, string, (d: DesktopComputerDriver) => Promise<unknown>][] = [
    ['an act', 'computer.act', (d) => d.act('c', TYPE, EXPECT)],
    ['a target', 'computer.target', (d) => d.target('c', 'foreground')],
    ['a screenshot', 'computer.screenshot', (d) => d.screenshot('c').then(() => 'shot', (e: Error) => e.message)],
    ['a cursor read', 'computer.cursor', (d) => d.cursorPosition('c').then(() => 'cursor', (e: Error) => e.message)],
  ];

  for (const [label, method, call] of calls) {
    it(`${label}, then Stop in the same tick: the end goes out, and the call after it never does`, async () => {
      const { driver, shell } = await inSession();
      const token = shell.tokenOf('c');
      const before = shell.lines.length;
      const calling = call(driver);
      const ending = driver.endSession('c');
      const answer = await calling;
      await ending;
      const written = shell.asked.slice(shell.asked.length - (shell.lines.length - before));
      expect(written.map((r) => r.method)).toEqual(['computer.end']);
      expect(written[0]!.params).toEqual({ chatId: 'c', session: token });
      expect(shell.sent(method).filter((p) => (p as { session?: string }).session === token).length).toBe(method === 'computer.screenshot' ? 1 : 0);
      expect(JSON.stringify(answer)).toContain(COMPUTER_NO_SESSION_REASON);
    });
  }

  it("the same when the reply's end ends a session nobody used, in the same tick", async () => {
    const made = await connected();
    const sessions = new ComputerSessions(made.driver, { emit: () => {}, cancelChat: () => {} }, { endTimeoutMs: 200 });
    expect(await sessions.ensureSession('c', 'Budget')).toEqual({ ok: true });
    const before = made.shell.lines.length;
    // Asked of the driver directly, so the server's own record still says the session was never used.
    const acting = made.driver.act('c', TYPE, EXPECT);
    sessions.replyEnded('c');
    expect(await acting).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    await vi.waitFor(() => expect(made.shell.lines.length).toBeGreaterThan(before));
    expect(made.shell.lines.slice(before).map((l) => JSON.parse(l.slice(RPC_PREFIX.length)).method)).toEqual(['computer.end']);
  });

  it('the same when the channel is lost in the gap: the call is told there is no session, not that it may have been done', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver, shell } = await inSession();
    const before = shell.lines.length;
    const acting = driver.act('c', TYPE, EXPECT);
    shell.breakPipe();
    expect(await acting).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(shell.lines.length).toBe(before);
  });

  it('the same when another call of the chat drifts and ends the session while this one waits its turn', async () => {
    const { driver, shell } = await inSession();
    shell.target = 'not an object';
    const looking = driver.target('c', 'foreground');
    const acting = driver.act('c', TYPE, EXPECT);
    expect((await looking) as unknown).toEqual({ refuse: `The desktop app's answer about the window couldn't be read. ${DESKTOP_ENDED_AFTER}` });
    expect(await acting).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(shell.sent('computer.act')).toEqual([]);
  });
});

describe('DesktopComputerDriver: one call at a time for a chat', () => {
  it("sends one of a chat's calls at a time, in the order they were made, whatever kind they are", async () => {
    const { driver, shell } = await inSession();
    shell.override = silentOn('computer.act', 'computer.screenshot', 'computer.target', 'computer.cursor');
    const before = shell.asked.length;
    const calls = [
      driver.act('c', TYPE, EXPECT),
      driver.screenshot('c'),
      driver.target('c', 'foreground'),
      driver.cursorPosition('c'),
      driver.act('c', KEY, EXPECT),
    ];
    const answers: [string, unknown][] = [
      ['computer.act', { ok: true }],
      ['computer.screenshot', shotOf(1366, 768)],
      ['computer.target', FAKE_COMPUTER_APP],
      ['computer.cursor', { x: 1, y: 2 }],
      ['computer.act', { ok: true }],
    ];
    for (const [i, [method, result]] of answers.entries()) {
      await tick();
      // Exactly one more request than answers given: the next is not sent until the one before is answered.
      expect(shell.asked.slice(before).map((r) => r.method)).toEqual(answers.slice(0, i + 1).map(([m]) => m));
      shell.answer(shell.asked.at(-1)!.id, result);
      expect(method).toBe(shell.asked.at(-1)!.method);
    }
    const [typed, shot, target, cursor, key] = await Promise.all(calls);
    expect(typed).toEqual({ ok: true });
    expect((shot as { width: number }).width).toBe(1366);
    expect(target).toEqual(FAKE_COMPUTER_APP);
    expect(cursor).toEqual({ x: 1, y: 2 });
    expect(key).toEqual({ ok: true });
  });

  it("does not make one chat wait for another's call", async () => {
    const { driver, shell } = await inSession();
    await driver.ensureSession('d', 'Other');
    shell.override = (method, params) => (method === 'computer.act' && params['chatId'] === 'c' ? 'silent' : undefined);
    const stuck = driver.act('c', TYPE, EXPECT);
    expect(await driver.act('d', TYPE, EXPECT)).toEqual({ ok: true });
    shell.answer(shell.asked.find((r) => r.method === 'computer.act')!.id, { ok: true });
    expect(await stuck).toEqual({ ok: true });
  });

  it('lets a bounded few wait their turn and refuses the next without sending it', async () => {
    const { driver, shell } = await inSession();
    shell.override = silentOn('computer.act');
    const sent = Array.from({ length: 1 + MAX_QUEUED_PER_CHAT }, () => driver.act('c', TYPE, EXPECT));
    await tick();
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: DESKTOP_BUSY_REASON });
    expect(await driver.target('c', 'foreground')).toEqual({ refuse: DESKTOP_BUSY_REASON });
    expect((await rejection(driver.screenshot('c'))).message).toBe(DESKTOP_BUSY_REASON);
    expect((await rejection(driver.cursorPosition('c'))).message).toBe(DESKTOP_BUSY_REASON);
    expect(shell.sent('computer.act')).toHaveLength(1);
    expect(MAX_QUEUED_PER_CHAT).toBe(16);
    // As the shell answers, each waiting one goes in its turn.
    shell.override = () => undefined;
    shell.answer(shell.idOf('computer.act'), { ok: true });
    expect(await Promise.all(sent)).toEqual(sent.map(() => ({ ok: true })));
    expect(shell.sent('computer.act')).toHaveLength(1 + MAX_QUEUED_PER_CHAT);
  });

  it('when the session ends, every call that was waiting is dropped unsent, and the one with the shell is not believed', async () => {
    const ends: [string, (made: Awaited<ReturnType<typeof inSession>>) => Promise<void>][] = [
      ['endSession', async ({ driver }) => driver.endSession('c')],
      [
        'the shell says stopped',
        async ({ shell }) => {
          shell.sessions.delete('c');
          shell.event('computer.stopped', { chatId: 'c', why: 'hotkey' });
          await tick();
        },
      ],
    ];
    for (const [label, end] of ends) {
      const made = await inSession();
      const { driver, shell } = made;
      shell.override = silentOn('computer.act', 'computer.screenshot', 'computer.target', 'computer.cursor');
      const first = driver.act('c', TYPE, EXPECT);
      const waiting = { act: driver.act('c', KEY, EXPECT), shot: rejection(driver.screenshot('c')), target: driver.target('c', 'foreground'), cursor: rejection(driver.cursorPosition('c')) };
      await tick();
      const actId = shell.idOf('computer.act');
      shell.override = () => undefined;

      await end(made);

      expect(await waiting.act, label).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
      expect((await waiting.shot).message, label).toBe(COMPUTER_NO_SESSION_REASON);
      expect(await waiting.target, label).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
      expect((await waiting.cursor).message, label).toBe(COMPUTER_NO_SESSION_REASON);
      // Only the first ever reached the shell.
      expect(shell.sent('computer.act'), label).toHaveLength(1);
      expect(shell.sent('computer.screenshot'), label).toHaveLength(1);
      expect(shell.sent('computer.target'), label).toEqual([]);
      expect(shell.sent('computer.cursor'), label).toEqual([]);
      // Its caller is not kept waiting on a shell that was told to stop, and a yes that comes for it later is not passed on as done.
      expect(await first, label).toEqual({
        ok: false,
        reason: 'The control session ended while the desktop app was working. Whether the action was carried out is not known.',
      });
      shell.answer(actId, { ok: true });
      await tick();
    }
  });

  it('checks a point when its turn comes: against the screenshot that was ahead of it in the queue', async () => {
    const { driver, shell } = await inSession();
    shell.screenshot = shotOf(800, 600);
    const shot = driver.screenshot('c');
    // Made while the new screenshot is still on its way: inside the old one, outside the new.
    const click = driver.act('c', action({ action: 'left_click', coordinate: [1000, 700] }), EXPECT);
    const target = driver.target('c', { x: 1000, y: 700 });
    await shot;
    expect(await click).toEqual({ ok: false, reason: DESKTOP_OUTSIDE_REASON });
    expect(await target).toEqual({ refuse: DESKTOP_OUTSIDE_REASON });
    expect(shell.sent('computer.act')).toEqual([]);
    expect(shell.sent('computer.target')).toEqual([]);
  });
});

describe('DesktopComputerDriver: screenshots', () => {
  it('asks with computer.screenshot { chatId, session } and returns the bytes and the size', async () => {
    const { driver, shell } = await connected();
    await driver.ensureSession('c', 'Budget');
    const shot = await driver.screenshot('c');
    expect(shell.lines.at(-1)).toBe(`GRUNT-RPC {"id":3,"method":"computer.screenshot","params":{"chatId":"c","session":"${shell.tokenOf('c')}"}}\n`);
    expect(Buffer.isBuffer(shot.png)).toBe(true);
    expect(shot.png.equals(pngOf(1366, 768))).toBe(true);
    expect({ width: shot.width, height: shot.height }).toEqual({ width: 1366, height: 768 });
    expect(Object.keys(shot).sort()).toEqual(['height', 'png', 'width']);
  });

  it('refuses a chat with no session without asking the shell', async () => {
    const { driver, shell } = await connected();
    expect((await rejection(driver.screenshot('c'))).message).toBe(COMPUTER_NO_SESSION_REASON);
    expect((await rejection(driver.cursorPosition('c'))).message).toBe(COMPUTER_NO_SESSION_REASON);
    expect(shell.methods()).toEqual(['computer.hello']);
  });

  it('refuses a screenshot that is not what the port defines, and ends the session: its view of the shell is not to be trusted', async () => {
    const png = pngOf(1366, 768).toString('base64');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
    const noHeader = Buffer.concat([FAKE_PNG.subarray(0, 8), Buffer.alloc(24)]).toString('base64');
    const bad: unknown[] = [
      null,
      'png',
      [],
      { width: 1366, height: 768 },
      { png: 7, width: 1366, height: 768 },
      { png: '', width: 1366, height: 768 },
      { png: { data: png }, width: 1366, height: 768 },
      { png: `${png.slice(0, -4)}!!==`, width: 1366, height: 768 },
      { png: `${png}\n`, width: 1366, height: 768 },
      { png: png.slice(0, -1), width: 1366, height: 768 },
      { png: Buffer.from('not an image at all, whatever it says').toString('base64'), width: 1366, height: 768 },
      { png: jpeg, width: 1366, height: 768 },
      // A PNG signature with no header after it, or cut off before its size.
      { png: noHeader, width: 1366, height: 768 },
      { png: FAKE_PNG.subarray(0, 20).toString('base64'), width: 1366, height: 768 },
      { png, height: 768 },
      { png, width: '1366', height: 768 },
      { png, width: 1366.5, height: 768 },
      { png, width: 0, height: 768 },
      { png, width: -1366, height: 768 },
      { png, width: 1366, height: 0 },
      { png, width: 1366, height: null },
      { png, width: COMPUTER_LIMITS.coordinateMax + 1, height: 768 },
      { png, width: 1366, height: COMPUTER_LIMITS.coordinateMax + 1 },
      { png, width: Number.MAX_SAFE_INTEGER, height: 768 },
      // A size beside the image that is not the image's own: a point would be checked against one and clicked in the other.
      { png, width: 1365, height: 768 },
      { png, width: 1366, height: 767 },
      { png, width: 768, height: 1366 },
      { png, width: 2732, height: 1536 },
      { png: FAKE_PNG.toString('base64'), width: 1366, height: 768 },
      { png: pngOf(40000, 768).toString('base64'), width: 1366, height: 768 },
    ];
    for (const screenshot of bad) {
      const { driver, shell } = await inSession();
      const lost = vi.fn();
      driver.onLost(lost);
      shell.screenshot = screenshot;
      const err = await rejection(driver.screenshot('c'));
      expect(err.message, JSON.stringify(screenshot)?.slice(0, 80)).toBe(`The desktop app's screenshot couldn't be read. ${DESKTOP_ENDED_AFTER}`);
      // The session is over, here and at the shell: nothing more is looked at or done in it, and the next call needs a new start.
      expect(lost.mock.calls).toEqual([['c']]);
      expect(endedChats(shell)).toEqual(['c']);
      expect(shell.sessions.has('c')).toBe(false);
      expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
      expect(await driver.target('c', { x: 10, y: 20 })).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
      expect(shell.sent('computer.act')).toEqual([]);
      expect(shell.sent('computer.target')).toEqual([]);
      // A new session starts with no screenshot.
      expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: true });
      expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: DESKTOP_NO_SCREENSHOT_REASON });
    }
    expect(COMPUTER_LIMITS.coordinateMax).toBe(32767);
  });

  it("takes the image's own size when the size beside it says the same, up to the largest a coordinate can have", async () => {
    const { driver, shell } = await inSession();
    for (const [width, height] of [
      [1, 1],
      [800, 600],
      [COMPUTER_LIMITS.coordinateMax, COMPUTER_LIMITS.coordinateMax],
    ] as const) {
      shell.screenshot = shotOf(width, height);
      const shot = await driver.screenshot('c');
      expect([shot.width, shot.height]).toEqual([width, height]);
    }
  });

  it('takes a screenshot of exactly 5 MB and refuses one byte more', async () => {
    const { driver, shell, channel } = await inSession();
    const largest = pngOf(1366, 768, MAX_TOOL_IMAGE_BYTES);
    shell.screenshot = { png: largest.toString('base64'), width: 1366, height: 768 };
    const shot = await driver.screenshot('c');
    expect(shot.png.length).toBe(MAX_TOOL_IMAGE_BYTES);
    expect(shot.png.equals(largest)).toBe(true);

    shell.screenshot = { png: pngOf(1366, 768, MAX_TOOL_IMAGE_BYTES + 1).toString('base64'), width: 1366, height: 768 };
    expect((await rejection(driver.screenshot('c'))).message).toBe(`The desktop app's screenshot couldn't be read. ${DESKTOP_ENDED_AFTER}`);
    expect(channel.closed).toBe(false);
  });

  it('never holds a line longer than the channel allows: such a screenshot closes the channel as it arrives, and every session with it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver, shell, channel } = await inSession();
    const lost = vi.fn();
    driver.onLost(lost);
    shell.screenshot = { png: pngOf(1366, 768, MAX_TOOL_IMAGE_BYTES + 200_000).toString('base64'), width: 1366, height: 768 };
    expect((await rejection(driver.screenshot('c'))).message).toBe('The desktop app went away.');
    expect(channel.closed).toBe(true);
    expect(channel.bufferedBytes).toBe(0);
    expect(lost.mock.calls).toEqual([['c']]);
    // The shell was told, and nothing is sent from then on.
    expect(shell.notified).toEqual([{ method: 'computer.close', params: {} }]);
    expect(driver.available()).toBe(false);
    expect(driver.reservedKeys()).toBeNull();
    expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: false, reason: 'The desktop app went away.' });
  });

  it("rejects with the shell's error as one clean line and keeps the session; when the shell does not answer, ends it", async () => {
    const { driver, shell } = await inSession({ driver: { callTimeoutMs: 250 } });
    shell.override = (method) => (method === 'computer.screenshot' ? { error: { message: `capture failed\nat C:\\x ${'y'.repeat(900)}` } } : undefined);
    const said = await rejection(driver.screenshot('c'));
    expect(said.message.startsWith('capture failed at C:\\x y')).toBe(true);
    expectClean(said.message);
    expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: DESKTOP_NO_SCREENSHOT_REASON });
    expect(endedChats(shell)).toEqual([]);
    shell.override = silentOn('computer.screenshot');
    expect((await rejection(driver.screenshot('c'))).message).toBe(`The desktop app didn't answer in time. ${DESKTOP_ENDED_AFTER}`);
    expect(endedChats(shell)).toEqual(['c']);
    expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
  });

  it('hands on no screenshot of a session that ended while it was being taken', async () => {
    const { driver, shell } = await inSession();
    shell.override = silentOn('computer.screenshot');
    const taking = rejection(driver.screenshot('c'));
    await tick();
    shell.event('computer.stopped', { chatId: 'c', why: 'hotkey' });
    // Its caller is told at once, without the shell having answered; what the shell sends afterwards is nobody's.
    expect((await taking).message).toBe(COMPUTER_NO_SESSION_REASON);
    shell.answer(shell.idOf('computer.screenshot'), shotOf(1366, 768));
    await tick();
  });

  it('reads the cursor with computer.cursor { chatId, session }: two whole numbers a point can be, or an error that ends the session', async () => {
    const { driver, shell } = await inSession();
    expect(await driver.cursorPosition('c')).toEqual({ x: 3, y: 4 });
    expect(shell.sent('computer.cursor')).toEqual([{ chatId: 'c', session: shell.tokenOf('c') }]);
    shell.cursor = { x: 3, y: 4, window: 'hwnd-9' };
    expect(await driver.cursorPosition('c')).toStrictEqual({ x: 3, y: 4 });
    for (const cursor of [
      { x: 0, y: 0 },
      { x: COMPUTER_LIMITS.coordinateMax, y: COMPUTER_LIMITS.coordinateMax },
    ]) {
      shell.cursor = cursor;
      expect(await driver.cursorPosition('c')).toEqual(cursor);
    }
    const bad: unknown[] = [
      null,
      [3, 4],
      'here',
      { x: '3', y: 4 },
      { x: 3 },
      { x: 3, y: null },
      { x: 1e400, y: 4 },
      { x: 3.5, y: 4 },
      { x: 3, y: 4.25 },
      { x: -1, y: 4 },
      { x: 3, y: -4 },
      { x: COMPUTER_LIMITS.coordinateMax + 1, y: 4 },
      { x: 3, y: 1e9 },
      { x: true, y: 4 },
    ];
    for (const cursor of bad) {
      const made = await inSession();
      made.shell.cursor = cursor;
      expect((await rejection(made.driver.cursorPosition('c'))).message, JSON.stringify(cursor)).toBe(`The cursor's position couldn't be read. ${DESKTOP_ENDED_AFTER}`);
      expect(endedChats(made.shell)).toEqual(['c']);
      expect((await rejection(made.driver.cursorPosition('c'))).message).toBe(COMPUTER_NO_SESSION_REASON);
    }
  });
});

describe('DesktopComputerDriver: points', () => {
  it('refuses a point for a session that has no screenshot of its own, and asks the shell nothing', async () => {
    const { driver, shell } = await connected();
    await driver.ensureSession('c', 'Budget');
    const before = shell.methods().length;
    for (const a of [CLICK, action({ action: 'mouse_move', coordinate: [0, 0] }), action({ action: 'scroll', coordinate: [5, 5], scroll_direction: 'down', scroll_amount: 2 })]) {
      expect(await driver.act('c', a, EXPECT)).toEqual({ ok: false, reason: DESKTOP_NO_SCREENSHOT_REASON });
    }
    expect(await driver.target('c', { x: 10, y: 20 })).toEqual({ refuse: DESKTOP_NO_SCREENSHOT_REASON });
    expect(shell.methods()).toHaveLength(before);
    // What needs no point needs no screenshot.
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: true });
    expect(await driver.act('c', KEY, EXPECT)).toEqual({ ok: true });
    expect(await driver.target('c', 'foreground')).toEqual(FAKE_COMPUTER_APP);
  });

  it('refuses a point outside its own last screenshot, whatever the caller thinks the size is', async () => {
    const { driver, shell } = await inSession();
    shell.screenshot = shotOf(800, 600);
    await driver.screenshot('c');
    const inside: [number, number][] = [
      [0, 0],
      [799, 599],
      [799, 0],
      [0, 599],
    ];
    for (const [x, y] of inside) {
      expect(await driver.act('c', action({ action: 'left_click', coordinate: [x, y] }), EXPECT)).toEqual({ ok: true });
      expect(await driver.target('c', { x, y })).toEqual(FAKE_COMPUTER_APP);
    }
    const sent = shell.methods().length;
    // Inside 1366x768, which is what the tool may still remember, and outside 800x600.
    const outside: [number, number][] = [
      [800, 0],
      [0, 600],
      [1000, 700],
      [1365, 767],
    ];
    for (const [x, y] of outside) {
      expect(await driver.act('c', action({ action: 'left_click', coordinate: [x, y] }), EXPECT)).toEqual({ ok: false, reason: DESKTOP_OUTSIDE_REASON });
      expect(await driver.target('c', { x, y })).toEqual({ refuse: DESKTOP_OUTSIDE_REASON });
    }
    // And a pair nobody should have been able to build.
    for (const coordinate of [
      [-1, 5],
      [5, -1],
      [1.5, 5],
      [5, Number.NaN],
      ['5', 5],
      [null, 5],
    ]) {
      const a = { action: 'left_click', coordinate } as unknown as ComputerAction;
      expect(await driver.act('c', a, EXPECT), JSON.stringify(coordinate)).toEqual({ ok: false, reason: DESKTOP_OUTSIDE_REASON });
    }
    for (const at of [{ x: -1, y: 5 }, { x: 1.5, y: 5 }, { x: '5', y: 5 }, { x: 5 }, null, 'point', [5, 5]]) {
      expect(await driver.target('c', at as never), JSON.stringify(at)).toEqual({ refuse: DESKTOP_OUTSIDE_REASON });
    }
    expect(shell.methods()).toHaveLength(sent);
  });

  it('never sends a mouse action without its point, and says the mistake is its own', async () => {
    const { driver, shell } = await inSession();
    const sent = shell.methods().length;
    const mouse = ['mouse_move', 'left_click', 'right_click', 'double_click', 'triple_click', 'scroll'];
    for (const name of mouse) {
      for (const coordinate of [undefined, null, [5], [5, 5, 5], '5,5', { x: 5, y: 5 }, 5]) {
        const a = { action: name, ...(coordinate === undefined ? {} : { coordinate }), scroll_direction: 'down', scroll_amount: 1 } as unknown as ComputerAction;
        expect(await driver.act('c', a, EXPECT), `${name} ${JSON.stringify(coordinate)}`).toEqual({ ok: false, reason: DESKTOP_NO_POINT_REASON });
      }
    }
    expect(DESKTOP_NO_POINT_REASON).toContain('a mistake in Grunt');
    expect(shell.methods()).toHaveLength(sent);
    // The keyboard's actions have no point and need none.
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: true });
  });

  it('a new session starts with no screenshot, however the last one ended', async () => {
    const ends: ((made: Awaited<ReturnType<typeof inSession>>) => Promise<void>)[] = [
      async ({ driver }) => driver.endSession('c'),
      async ({ shell, driver }) => {
        shell.sessions.delete('c');
        shell.event('computer.stopped', { chatId: 'c', why: 'idle' });
        await vi.waitFor(async () => expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON }));
      },
    ];
    for (const end of ends) {
      const made = await inSession();
      expect(await made.driver.act('c', CLICK, EXPECT)).toEqual({ ok: true });
      await end(made);
      expect(await made.driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
      expect(await made.driver.ensureSession('c', 'Budget')).toEqual({ ok: true });
      expect(await made.driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: DESKTOP_NO_SCREENSHOT_REASON });
      await made.driver.screenshot('c');
      expect(await made.driver.act('c', CLICK, EXPECT)).toEqual({ ok: true });
    }
  });

  it("one chat's screenshot is not another's", async () => {
    const { driver } = await inSession();
    await driver.ensureSession('d', 'Other');
    expect(await driver.act('d', CLICK, EXPECT)).toEqual({ ok: false, reason: DESKTOP_NO_SCREENSHOT_REASON });
    expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: true });
  });
});

describe('DesktopComputerDriver: targets', () => {
  it('asks with { chatId, session, x, y } for a point and { chatId, session, foreground: true } for the foreground', async () => {
    const { driver, shell } = await inSession();
    await driver.target('c', { x: 5, y: 6 });
    await driver.target('c', 'foreground');
    const token = shell.tokenOf('c')!;
    expect(shell.lines.slice(-2)).toEqual([
      `GRUNT-RPC {"id":4,"method":"computer.target","params":{"chatId":"c","session":"${token}","x":5,"y":6}}\n`,
      `GRUNT-RPC {"id":5,"method":"computer.target","params":{"chatId":"c","session":"${token}","foreground":true}}\n`,
    ]);
  });

  it("hands on the shell's answer exactly as it was sent: nothing filled in, nothing dropped, nothing changed", async () => {
    const { elevated: _elevated, ...noElevated } = FAKE_COMPUTER_APP;
    const { shellView: _shellView, ...noShellView } = FAKE_COMPUTER_APP;
    const { grunt: _grunt, console: _console, uiAccess: _uiAccess, ...noFlags } = FAKE_COMPUTER_APP;
    const { windowId: _windowId, ...noWindow } = FAKE_COMPUTER_APP;
    const cases: [string, unknown, 'refuse' | 'high' | 'normal'][] = [
      ['every fact', { ...FAKE_COMPUTER_APP }, 'normal'],
      ['no elevated', noElevated, 'refuse'],
      ['no shellView', noShellView, 'high'],
      ['no grunt, console or uiAccess', noFlags, 'refuse'],
      ['no windowId', noWindow, 'refuse'],
      ['elevated null', { ...FAKE_COMPUTER_APP, elevated: null }, 'refuse'],
      ['elevated as text', { ...FAKE_COMPUTER_APP, elevated: 'false' }, 'refuse'],
      ['grunt as 0', { ...FAKE_COMPUTER_APP, grunt: 0 }, 'refuse'],
      ['uiAccess as text', { ...FAKE_COMPUTER_APP, uiAccess: 'no' }, 'refuse'],
      ['shellView as 0', { ...FAKE_COMPUTER_APP, shellView: 0 }, 'high'],
      ['shellView null', { ...FAKE_COMPUTER_APP, shellView: null }, 'high'],
      ['console as text', { ...FAKE_COMPUTER_APP, console: 'false' }, 'high'],
      ['pid as text', { ...FAKE_COMPUTER_APP, pid: '4242' }, 'refuse'],
      ['path as a list', { ...FAKE_COMPUTER_APP, path: ['C:\\x.exe'] }, 'refuse'],
      ['a lower-cased path', { ...FAKE_COMPUTER_APP, path: 'c:\\program files\\fake app\\fakeapp.exe' }, 'normal'],
      ['a path with spaces round it', { ...FAKE_COMPUTER_APP, path: ' C:\\Program Files\\Fake App\\FakeApp.exe ' }, 'refuse'],
      ['a title with a line break', { ...FAKE_COMPUTER_APP, title: 'Fake\nApp\u202e' }, 'normal'],
      ['more than the port names', { ...FAKE_COMPUTER_APP, name: 'Notepad', risk: 'normal', extra: { nested: [1, 2] } }, 'normal'],
      ['a refusal', { refuse: 'There is no window at that point.' }, 'refuse'],
      ['a refusal with more beside it', { refuse: 'no', path: FAKE_COMPUTER_APP.path }, 'refuse'],
      ['an empty object', {}, 'refuse'],
    ];
    for (const [label, sent, verdict] of cases) {
      const { driver, shell } = await inSession();
      shell.target = sent;
      const wire = JSON.parse(JSON.stringify(sent)) as unknown;
      for (const at of [{ x: 5, y: 6 }, 'foreground'] as const) {
        const got: unknown = await driver.target('c', at);
        expect(got, label).toStrictEqual(wire);
        expect(JSON.stringify(got), label).toBe(JSON.stringify(sent));
        // So core is what decides, on exactly what the shell said.
        const described = classifyTarget(got);
        expect(described.kind === 'refuse' ? 'refuse' : described.risk, label).toBe(verdict);
      }
      expect(endedChats(shell), label).toEqual([]);
    }
  });

  it('takes an answer that is not even an object as one it cannot read: refused, and the session ended', async () => {
    for (const sent of [null, 'notepad.exe', [FAKE_COMPUTER_APP], 4242, true]) {
      const { driver, shell } = await inSession();
      shell.target = sent;
      const got = await driver.target('c', 'foreground');
      expect(got, JSON.stringify(sent)).toEqual({ refuse: `The desktop app's answer about the window couldn't be read. ${DESKTOP_ENDED_AFTER}` });
      expect(classifyTarget(got).kind).toBe('refuse');
      expect(endedChats(shell)).toEqual(['c']);
      expect(await driver.target('c', 'foreground')).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
    }
  });

  it('throws, in clean words, when the shell fails to answer; a timeout ends the session', async () => {
    const { driver, shell } = await inSession({ driver: { callTimeoutMs: 250 } });
    shell.override = (method) => (method === 'computer.target' ? { error: { message: 'The window is gone.\nstack: at foo' } } : undefined);
    const said = await rejection(driver.target('c', 'foreground'));
    expect(said.message).toBe('The window is gone. stack: at foo');
    expect(endedChats(shell)).toEqual([]);
    shell.override = silentOn('computer.target');
    expect((await rejection(driver.target('c', { x: 1, y: 1 }))).message).toBe(`The desktop app didn't answer in time. ${DESKTOP_ENDED_AFTER}`);
    expect(endedChats(shell)).toEqual(['c']);
  });

  it("answers a refusal, not the shell's answer, for a session that ended while it asked", async () => {
    const { driver, shell } = await inSession();
    shell.override = silentOn('computer.target');
    const asking = driver.target('c', 'foreground');
    await tick();
    shell.event('computer.stopped', { chatId: 'c', why: 'button' });
    await tick();
    shell.answer(shell.idOf('computer.target'), FAKE_COMPUTER_APP);
    expect(await asking).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
  });
});

describe('DesktopComputerDriver: acting', () => {
  it('sends { chatId, session, action, expect } with the action and expectation exactly as handed: nothing added, dropped or changed', async () => {
    const { driver, shell } = await inSession();
    const session = shell.tokenOf('c')!;
    const scroll = action({ action: 'scroll', coordinate: [100, 200], scroll_direction: 'down', scroll_amount: 4 });
    const fileView = expectFor({ shellView: true, windowId: 'hwnd-2', pid: 7, startedAt: '2026-10-13T08:00:00.000Z' });
    const handed: [ComputerAction, ComputerExpectation][] = [
      [CLICK, EXPECT],
      [TYPE, EXPECT],
      [KEY, EXPECT],
      [scroll, fileView],
      [action({ action: 'type', text: 'line one\nline\ttwo \u00e9 \u{1F5B1}' }), EXPECT],
    ];
    let id = shell.idOf('computer.screenshot');
    for (const [a, e] of handed) {
      id += 1;
      expect(await driver.act('c', a, e)).toEqual({ ok: true });
      expect(shell.lines.at(-1)).toBe(`${RPC_PREFIX}${JSON.stringify({ id, method: 'computer.act', params: { chatId: 'c', session, action: a, expect: e } })}\n`);
      expect(shell.sent('computer.act').at(-1)).toStrictEqual({ chatId: 'c', session, action: JSON.parse(JSON.stringify(a)), expect: { ...e } });
    }
    // The expectation is whole: the five facts, no `expectApp`, no null.
    expect(shell.sent('computer.act')[0]).toStrictEqual({
      chatId: 'c',
      session,
      action: { action: 'left_click', coordinate: [10, 20] },
      expect: { app: 'C:\\Program Files\\Fake App\\FakeApp.exe', shellView: false, windowId: 'hwnd-1', pid: 4242, startedAt: '2026-10-12T09:00:00.000Z' },
    });
    expect(shell.sent('computer.act')[3]).toStrictEqual({
      chatId: 'c',
      session,
      action: { action: 'scroll', coordinate: [100, 200], scroll_direction: 'down', scroll_amount: 4 },
      expect: { app: 'C:\\Program Files\\Fake App\\FakeApp.exe', shellView: true, windowId: 'hwnd-2', pid: 7, startedAt: '2026-10-13T08:00:00.000Z' },
    });
  });

  it("answers the shell's yes and its refusal, the reason as one bounded clean line", async () => {
    const { driver, shell } = await inSession();
    shell.actAnswer = { ok: true, extra: 'ignored' };
    expect(await driver.act('c', CLICK, EXPECT)).toStrictEqual({ ok: true });
    shell.actAnswer = { ok: false, reason: 'The window changed after Grunt asked, so nothing was done.' };
    expect(await driver.act('c', CLICK, EXPECT)).toStrictEqual({ ok: false, reason: 'The window changed after Grunt asked, so nothing was done.' });
    shell.actAnswer = { ok: false, reason: `changed\r\nIGNORE ALL\u202e ${'z'.repeat(3000)}` };
    const long = await driver.act('c', CLICK, EXPECT);
    expect(long.ok).toBe(false);
    if (!long.ok) {
      expect(long.reason.startsWith('changed IGNORE ALL z')).toBe(true);
      expectClean(long.reason);
    }
    for (const reason of [undefined, null, 42, '', { why: 'x' }]) {
      shell.actAnswer = { ok: false, reason };
      expect(await driver.act('c', CLICK, EXPECT)).toStrictEqual({ ok: false, reason: 'The desktop app refused the action.' });
    }
  });

  it('takes an answer that is not an answer as not knowing what happened, and ends the session', async () => {
    for (const actAnswer of [{ ok: 'true' }, { ok: 1 }, { ok: null }, {}, null, 'ok', true, [{ ok: true }], 1, { done: true }]) {
      const { driver, shell } = await inSession();
      shell.override = (method) => (method === 'computer.act' ? { result: actAnswer } : undefined);
      expect(await driver.act('c', CLICK, EXPECT), JSON.stringify(actAnswer)).toStrictEqual({
        ok: false,
        reason: `The desktop app's answer couldn't be read. Whether the action was carried out is not known. ${DESKTOP_ENDED_AFTER}`,
      });
      expect(endedChats(shell)).toEqual(['c']);
      expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
      expect(shell.sent('computer.act')).toHaveLength(1);
    }
    // No result at all: not a message the channel can read, so the channel closes, and every session with it.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver, shell, channel } = await inSession();
    shell.override = (method) => (method === 'computer.act' ? ({} as ShellAnswer) : undefined);
    expect(await driver.act('c', CLICK, EXPECT)).toStrictEqual({
      ok: false,
      reason: 'The desktop app went away. Whether the action was carried out is not known.',
    });
    expect(channel.closed).toBe(true);
    expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: 'The desktop app went away.' });
  });

  it("answers the shell's error as a refusal in its words, one bounded clean line", async () => {
    const { driver, shell } = await inSession();
    shell.override = (method) => (method === 'computer.act' ? { error: { message: `A modifier key is held; nothing was done.\n${'q'.repeat(999)}` } } : undefined);
    const said = await driver.act('c', CLICK, EXPECT);
    expect(said.ok).toBe(false);
    if (!said.ok) {
      expect(said.reason.startsWith('A modifier key is held; nothing was done. q')).toBe(true);
      expectClean(said.reason);
    }
    // The shell said it did nothing: the session goes on.
    expect(endedChats(shell)).toEqual([]);
    shell.override = () => undefined;
    expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: true });
  });

  it('an action the shell does not answer in time may still be going on: the session is ended, and the outcome is said to be unknown', async () => {
    const { driver, shell } = await inSession({ driver: { actTimeoutMs: 30 } });
    shell.override = silentOn('computer.act');
    const acting = driver.act('c', TYPE, EXPECT);
    const waiting = driver.act('c', KEY, EXPECT);
    expect(await acting).toStrictEqual({
      ok: false,
      reason: "The desktop app didn't answer in time. Whether the action was carried out is not known. Grunt has ended the control session, so nothing more is done.",
    });
    expect(endedChats(shell)).toEqual(['c']);
    expect(shell.sessions.has('c')).toBe(false);
    // What was waiting behind it is dropped unsent, and nothing more is sent for the chat until it starts again.
    expect(await waiting).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(shell.sent('computer.act')).toHaveLength(1);
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    shell.override = () => undefined;
    expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: true });
    expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: DESKTOP_NO_SCREENSHOT_REASON });
  });

  it('and when the shell does not confirm that end either, it says so, and nothing starts until it does', async () => {
    const { driver, shell } = await inSession({ driver: { actTimeoutMs: 30, endTimeoutMs: 30 } });
    shell.override = silentOn('computer.act', 'computer.end');
    expect(await driver.act('c', TYPE, EXPECT)).toStrictEqual({
      ok: false,
      reason:
        "The desktop app didn't answer in time. Whether the action was carried out is not known. Grunt asked the desktop app to end the control session and couldn't confirm that it did.",
    });
    expect(endedChats(shell)).toEqual(['c']);
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect((await rejection(driver.ensureSession('c', 'Budget'))).message).toBe(DESKTOP_END_PENDING_REASON);
    expect(shell.sent('computer.start')).toHaveLength(1);
    shell.override = () => undefined;
    expect(await driver.ensureSession('c', 'Budget')).toEqual({ ok: true });
  });

  it('answers a refusal, never a throw, when the shell goes away while it acts', async () => {
    const { driver, shell } = await inSession();
    shell.override = silentOn('computer.act');
    const acting = driver.act('c', TYPE, EXPECT);
    await tick();
    shell.close();
    expect(await acting).toStrictEqual({ ok: false, reason: 'The desktop app went away. Whether the action was carried out is not known.' });
    expect(await driver.act('c', TYPE, EXPECT)).toStrictEqual({ ok: false, reason: 'The desktop app went away.' });
  });

  it('answers a refusal when the channel is full, and says nothing was sent', async () => {
    const { driver, shell } = await inSession({ channel: { maxPending: 1 } });
    await driver.ensureSession('d', 'Other');
    shell.override = silentOn('computer.cursor');
    const waiting = driver.cursorPosition('d');
    waiting.catch(() => {});
    await tick();
    expect(await driver.act('c', TYPE, EXPECT)).toStrictEqual({ ok: false, reason: 'The desktop app has too many requests waiting; nothing was sent.' });
    expect(shell.sent('computer.act')).toEqual([]);
    // Nothing was sent, so nothing is in doubt: the session goes on.
    expect(endedChats(shell)).toEqual([]);
    shell.close();
  });

  it('does nothing for a chat with no session, and asks the shell nothing', async () => {
    const { driver, shell } = await connected();
    for (const a of [CLICK, TYPE, KEY]) expect(await driver.act('c', a, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(await driver.target('c', 'foreground')).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
    expect(shell.methods()).toEqual(['computer.hello']);
    // The stand-in shell would have refused too; the driver did not need to ask.
    expect(SHELL_NO_SESSION).not.toBe(COMPUTER_NO_SESSION_REASON);
  });

  it('never throws on, and never sends, an action that is not one of the port\'s', async () => {
    const { driver, shell } = await inSession();
    const sent = shell.methods().length;
    const notActions: unknown[] = [null, undefined, 'left_click', 7, [], {}, { action: 'screenshot' }, { action: 'wait', duration: 1 }, { action: 'left_mouse_down', coordinate: [1, 1] }, { action: 'hold_key', text: 'ctrl' }, { action: 'LEFT_CLICK', coordinate: [1, 1] }, { action: 7 }];
    for (const a of notActions) {
      expect(await driver.act('c', a as never, EXPECT), JSON.stringify(a)).toStrictEqual({ ok: false, reason: 'That is not an action Grunt can send.' });
    }
    expect(shell.methods()).toHaveLength(sent);
  });
});

describe("DesktopComputerDriver: the shell's events", () => {
  it("reports the shell's stops, and has no session for that chat from then on", async () => {
    const { driver, shell } = await inSession();
    const heard = vi.fn();
    const off = driver.onStopped(heard);
    for (const why of ['hotkey', 'button', 'idle', 'quit']) shell.event('computer.stopped', { chatId: 'c', why });
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(4));
    expect(heard.mock.calls).toEqual([
      ['c', 'hotkey'],
      ['c', 'button'],
      ['c', 'idle'],
      ['c', 'quit'],
    ]);
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(shell.sent('computer.act')).toEqual([]);
    off();
    shell.event('computer.stopped', { chatId: 'c', why: 'idle' });
    await tick();
    expect(heard).toHaveBeenCalledTimes(4);
  });

  it('a stop is a stop whatever reason comes with it: one it does not know counts as the button', async () => {
    const { driver, shell } = await connected();
    const heard = vi.fn();
    driver.onStopped(heard);
    for (const why of [undefined, null, 'crash', 7, { why: 'idle' }, 'HOTKEY', '__proto__']) shell.event('computer.stopped', { chatId: 'c', why });
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(7));
    for (const call of heard.mock.calls) expect(call).toEqual(['c', 'button']);
  });

  it('ignores a stop it cannot read, an event it does not know, and goes on reading', async () => {
    const { driver, shell } = await inSession();
    const heard = vi.fn();
    driver.onStopped(heard);
    const unreadable: unknown[] = [
      undefined,
      null,
      'c',
      ['c'],
      {},
      { why: 'hotkey' },
      { chatId: 7, why: 'hotkey' },
      { chatId: null },
      { chatId: ['c'] },
      { chatId: { id: 'c' } },
      { chatId: '' },
      { chatId: 'c\nINFO forged log line' },
      { chatId: ' c ' },
      { chatId: 'c\u202e' },
      { chatId: 'x'.repeat(129) },
    ];
    for (const params of unreadable) shell.event('computer.stopped', params);
    shell.event('computer.made-up', { chatId: 'c' });
    shell.event('computer.started', { chatId: 'c' });
    shell.event('constructor', { chatId: 'c' });
    // The session is still there, and the reader still reads.
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: true });
    expect(heard).not.toHaveBeenCalled();
    shell.event('computer.stopped', { chatId: 'x'.repeat(128), why: 'idle' });
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith('x'.repeat(128), 'idle'));
  });

  it('a listener that throws stops neither the others nor the reader', async () => {
    const { driver, shell } = await inSession();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = vi.fn();
    driver.onStopped(() => {
      throw new Error('listener bug');
    });
    driver.onStopped(second);
    shell.event('computer.stopped', { chatId: 'c', why: 'hotkey' });
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith('c', 'hotkey'));
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toBe('[grunt-server] a computer-use stopped listener failed:');
    expect((await driver.ensureSession('c', 'Budget')).ok).toBe(true);
  });
});

describe('DesktopComputerDriver: the hello as the shell\'s word that it holds no session', () => {
  it('tells its listeners once, when the answer states sessions: 0', async () => {
    const { driver } = connect();
    const reset = vi.fn();
    const off = driver.onReset(reset);
    expect(reset).not.toHaveBeenCalled();
    await driver.hello();
    expect(reset).toHaveBeenCalledTimes(1);
    off();
  });

  it('tells nobody when the answer does not state it, or states anything but 0, and leaves computer use off', async () => {
    const without = { platform: 'win32', version: '0.1.0', available: true, shortcuts: [] };
    for (const hello of [without, { ...without, sessions: 1 }, { ...without, sessions: '0' }, { ...without, sessions: null }, { ...without, sessions: [] }, { ...without, sessions: false }]) {
      const shell = new FakeShell();
      shell.hello = hello;
      const { driver } = connect({ shell });
      const reset = vi.fn();
      driver.onReset(reset);
      await driver.hello();
      // Without the shell's word that it holds nothing, nothing is known of what it holds: computer use stays off.
      expect(driver.available(), JSON.stringify(hello)).toBe(false);
      expect(reset, JSON.stringify(hello)).not.toHaveBeenCalled();
    }
  });

  it('tells nobody when the shell did not answer the hello, or answered unreadably', async () => {
    for (const answer of [{ error: { message: 'no' } }, { result: null }, { result: 'hello' }, 'silent'] as ShellAnswer[]) {
      const shell = new FakeShell();
      shell.override = (method) => (method === 'computer.hello' ? answer : undefined);
      const { driver } = connect({ shell, driver: { callTimeoutMs: 30 } });
      const reset = vi.fn();
      driver.onReset(reset);
      await driver.hello();
      expect(driver.available()).toBe(false);
      expect(reset).not.toHaveBeenCalled();
    }
  });

  it('a listener that throws stops nothing', async () => {
    const { driver } = connect();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = vi.fn();
    driver.onReset(() => {
      throw new Error('listener bug');
    });
    driver.onReset(second);
    await driver.hello();
    expect(second).toHaveBeenCalledTimes(1);
    expect(driver.available()).toBe(true);
    expect(logged.mock.calls[0]![0]).toBe('[grunt-server] a computer-use reset listener failed:');
  });
});
