import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyTarget, COMPUTER_LIMITS, expectationOf, parseAction } from '@grunt/core/domain/computer-apps.js';
import { MAX_TOOL_IMAGE_BYTES } from '@grunt/core/domain/tool-images.js';
import type { ComputerAction, ComputerExpectation } from '@grunt/core/ports/computer.js';
import { FAKE_COMPUTER_APP, FAKE_PNG, fakeComputerTarget } from '@grunt/core/testing/fake-computer.js';
import { RPC_PREFIX, type ShellChannel } from '../../src/computer/desktop-channel.js';
import {
  ACT_TIMEOUT_MS,
  DESKTOP_NO_SCREENSHOT_REASON,
  DESKTOP_NOT_AVAILABLE_REASON,
  DESKTOP_OUTSIDE_REASON,
  DesktopComputerDriver,
  END_TIMEOUT_MS,
  MAX_TRACKED_CHATS,
  START_LATE_WATCH_MS,
  START_TIMEOUT_MS,
} from '../../src/computer/desktop-driver.js';
import { COMPUTER_END_TIMEOUT_MS, COMPUTER_NO_SESSION_REASON } from '../../src/computer/sessions.js';
import { connect, connected, FakeShell, HELLO_OFF, HELLO_ON, SHELL_NO_SESSION, type ShellAnswer } from './fake-shell.js';

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

  it('is available only when a Windows shell says computer use is on', async () => {
    const cases: [unknown, boolean][] = [
      [{ platform: 'win32', version: '0.1.0', available: true, shortcuts: [] }, true],
      [{ platform: 'win32', version: '0.1.0', available: true }, true],
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

  it('stops being available when a later hello says otherwise', async () => {
    const { driver, shell } = await connected();
    shell.hello = HELLO_OFF;
    await driver.hello();
    expect(driver.available()).toBe(false);
    shell.hello = HELLO_ON;
    await driver.hello();
    expect(driver.available()).toBe(true);
    shell.override = () => ({ error: { message: 'no' } });
    await driver.hello();
    expect(driver.available()).toBe(false);
  });

  it('available() and reservedKeys() never throw, whatever the channel does', () => {
    const broken: ShellChannel = {
      get closed(): boolean {
        throw new Error('channel bug');
      },
      call: () => Promise.reject(new Error('channel bug')),
      onEvent: () => () => {},
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

describe('DesktopComputerDriver: the shell\'s shortcuts', () => {
  it('has no list until the hello answers, then the list the hello gave', async () => {
    const shell = new FakeShell();
    shell.override = (method) => (method === 'computer.hello' ? 'silent' : undefined);
    const { driver } = connect({ shell });
    expect(driver.reservedKeys()).toBeNull();
    const hello = driver.hello();
    await tick();
    expect(driver.reservedKeys()).toBeNull();
    shell.answer(1, { ...HELLO_ON, shortcuts: ['Ctrl+Shift+Space', 'Ctrl+Alt+Backspace'] });
    await hello;
    expect(driver.reservedKeys()).toEqual(['Ctrl+Shift+Space', 'Ctrl+Alt+Backspace']);
  });

  it('has no list when the hello gave none it can read: never an empty list in its place', async () => {
    const unreadable: unknown[] = [undefined, null, 'Ctrl+Shift+Space', {}, 0, false, ['F9', 7], ['F9', null], [['F9']], { 0: 'F9', length: 1 }];
    for (const shortcuts of unreadable) {
      const shell = new FakeShell();
      shell.hello = shortcuts === undefined ? { platform: 'win32', version: '0.1.0', available: true } : { ...HELLO_ON, shortcuts };
      const { driver } = await connected({ shell });
      expect(driver.available()).toBe(true);
      expect(driver.reservedKeys(), JSON.stringify(shortcuts)).toBeNull();
    }
    // A list the shell reported as empty is a list.
    const shell = new FakeShell();
    shell.hello = { ...HELLO_ON, shortcuts: [] };
    expect((await connected({ shell })).driver.reservedKeys()).toEqual([]);
  });

  it('follows every computer.shortcuts event, and an event it cannot read leaves no list at all', async () => {
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
    const shell = new FakeShell();
    shell.hello = { platform: 'win32', version: '0.1.0', available: true };
    const { driver } = await connected({ shell });
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
    // Nothing was ended: the shell said itself that there is no session.
    expect(shell.sent('computer.end')).toEqual([]);
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
  });

  it("answers the shell's error as a refusal, not a throw", async () => {
    const { driver, shell } = await connected();
    shell.override = (method) => (method === 'computer.start' ? { error: { message: 'Computer use is off in this Grunt desktop app.' } } : undefined);
    expect(await driver.ensureSession('c', 'x')).toEqual({ ok: false, reason: 'Computer use is off in this Grunt desktop app.' });
    expect(shell.sent('computer.end')).toEqual([]);
  });

  it('gives up on a dialog nobody answers: it tells the shell to end that start, and answers a refusal', async () => {
    const { driver, shell } = await connected({ driver: { startTimeoutMs: 30 } });
    shell.override = (method) => (method === 'computer.start' ? 'silent' : undefined);
    const answer = await driver.ensureSession('c', 'Budget');
    expect(answer).toEqual({ ok: false, reason: "The desktop app didn't answer the request to control this computer in time, so nothing was started." });
    expect(shell.methods()).toEqual(['computer.hello', 'computer.start', 'computer.end']);
    expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }]);
    // No session here, whatever comes later.
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
  });

  it('a yes that comes after it gave up is not a session: the shell is told to end it again', async () => {
    const { driver, shell } = await connected({ driver: { startTimeoutMs: 30 } });
    shell.override = (method) => (method === 'computer.start' ? 'silent' : undefined);
    expect((await driver.ensureSession('c', 'Budget')).ok).toBe(false);
    expect(shell.sent('computer.end')).toHaveLength(1);
    // The person says OK to the old dialog; a shell that got this wrong now holds a session.
    shell.sessions.add('c');
    shell.answer(shell.idOf('computer.start'), { ok: true });
    await vi.waitFor(() => expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }, { chatId: 'c' }]));
    await vi.waitFor(() => expect(shell.sessions.has('c')).toBe(false));
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(shell.sent('computer.act')).toEqual([]);
  });

  it('a no that comes after it gave up needs nothing more', async () => {
    const { driver, shell } = await connected({ driver: { startTimeoutMs: 30 } });
    shell.override = (method) => (method === 'computer.start' ? 'silent' : undefined);
    expect((await driver.ensureSession('c', 'Budget')).ok).toBe(false);
    shell.answer(shell.idOf('computer.start'), { ok: false, reason: 'cancelled' });
    await wait(20);
    expect(shell.sent('computer.end')).toHaveLength(1);
  });

  it('a late yes for an old start leaves a session that a newer start made alone', async () => {
    const { driver, shell } = await connected({ driver: { startTimeoutMs: 30 } });
    shell.override = (method) => (method === 'computer.start' ? 'silent' : undefined);
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

  it('stops listening for a late answer after a while, so the call does not wait for ever', async () => {
    const { driver, shell, channel } = await connected({ driver: { startTimeoutMs: 20, startLateMs: 300 } });
    shell.override = (method) => (method === 'computer.start' ? 'silent' : undefined);
    expect((await driver.ensureSession('c', 'Budget')).ok).toBe(false);
    expect(channel.pendingCalls).toBe(1);
    await vi.waitFor(() => expect(channel.pendingCalls).toBe(0));
  });

  it('throws, in its own words, when it gave up and the shell did not confirm the end', async () => {
    const { driver, shell } = await connected({ driver: { startTimeoutMs: 30, endTimeoutMs: 30 } });
    shell.override = (method) => (method === 'computer.start' || method === 'computer.end' ? 'silent' : undefined);
    const err = await rejection(driver.ensureSession('c', 'Budget'));
    expect(err.message).toBe(
      "The desktop app didn't answer the request to control this computer in time, so nothing was started. Grunt couldn't confirm that the desktop app cancelled it."
    );
    expectClean(err.message);
    expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }]);
    // Asked again, the driver asks the shell again, and says so while the shell will not confirm.
    expect((await rejection(driver.endSession('c'))).message).toBe("The desktop app didn't answer in time.");
    shell.override = () => undefined;
    await expect(driver.endSession('c')).resolves.toBeUndefined();
    expect(shell.sent('computer.end')).toHaveLength(3);
  });

  it('takes an answer it cannot read as not knowing: the start is ended, and refused', async () => {
    for (const startAnswer of [{ ok: 'yes' }, { ok: 1 }, {}, null, 'ok', true, [true], { result: { ok: true } }]) {
      const { driver, shell } = await connected();
      shell.override = (method) => (method === 'computer.start' ? { result: startAnswer } : undefined);
      expect(await driver.ensureSession('c', 'Budget'), JSON.stringify(startAnswer)).toEqual({
        ok: false,
        reason: "The desktop app's answer couldn't be read, so nothing was started.",
      });
      expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }]);
      expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    }
  });

  it('throws when the shell goes away while its dialog is up: nobody can say what came of it', async () => {
    const { driver, shell } = await connected();
    shell.override = (method) => (method === 'computer.start' ? 'silent' : undefined);
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
  it('asks with computer.end { chatId } for that chat alone, as often as it is asked', async () => {
    const { driver, shell } = await connected();
    await driver.ensureSession('c', 'One');
    await driver.ensureSession('d', 'Two');
    await expect(driver.endSession('c')).resolves.toBeUndefined();
    expect(shell.lines.at(-1)).toBe('GRUNT-RPC {"id":4,"method":"computer.end","params":{"chatId":"c"}}\n');
    expect([...shell.sessions]).toEqual(['d']);
    // Again, and for a chat that never had one: the same request, the same answer, nothing else touched.
    await expect(driver.endSession('c')).resolves.toBeUndefined();
    await expect(driver.endSession('never')).resolves.toBeUndefined();
    expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }, { chatId: 'c' }, { chatId: 'never' }]);
    expect([...shell.sessions]).toEqual(['d']);
    expect(await driver.act('d', TYPE, EXPECT)).toEqual({ ok: true });
    expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
  });

  it('forgets the session at once, before the shell has answered', async () => {
    const { driver, shell } = await inSession();
    shell.override = (method) => (method === 'computer.end' ? 'silent' : undefined);
    const ending = driver.endSession('c');
    expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(await driver.target('c', 'foreground')).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
    expect(shell.sent('computer.act')).toEqual([]);
    shell.answer(shell.idOf('computer.end'), {});
    await expect(ending).resolves.toBeUndefined();
  });

  it('rejects when the shell did not confirm the end, and resolves once it does', async () => {
    const failures: [ShellAnswer, string][] = [
      [{ error: { message: 'A key could not be released.' } }, 'A key could not be released.'],
      [{ result: { ok: false, reason: 'A key could not be released.' } }, 'A key could not be released.'],
      [{ result: { ok: false } }, "The desktop app couldn't end the control session."],
      [{ result: null }, "The desktop app's answer couldn't be read, so Grunt can't tell whether the control session ended."],
      [{ result: 'done' }, "The desktop app's answer couldn't be read, so Grunt can't tell whether the control session ended."],
      [{ result: [] }, "The desktop app's answer couldn't be read, so Grunt can't tell whether the control session ended."],
      ['silent', "The desktop app didn't answer in time."],
    ];
    for (const [answer, message] of failures) {
      const { driver, shell } = await inSession({ driver: { endTimeoutMs: 30 } });
      shell.override = (method) => (method === 'computer.end' ? answer : undefined);
      const err = await rejection(driver.endSession('c'));
      expect(err.message, JSON.stringify(answer)).toBe(message);
      expectClean(err.message);
      // Still unconfirmed the second time; confirmed the third.
      await expect(driver.endSession('c')).rejects.toThrow(message);
      shell.override = () => undefined;
      await expect(driver.endSession('c')).resolves.toBeUndefined();
      expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }, { chatId: 'c' }, { chatId: 'c' }]);
    }
  });

  it('takes {} and { ok: true } as the end confirmed', async () => {
    for (const endAnswer of [{}, { ok: true }]) {
      const { driver, shell } = await inSession();
      shell.endAnswer = endAnswer;
      await expect(driver.endSession('c')).resolves.toBeUndefined();
    }
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
    expect(err.message).toBe("The desktop app went away before it confirmed that the control session ended.");
    await expect(driver.endSession('c')).rejects.toThrow('went away before it confirmed');
    // Another chat, which had nothing, is not held up by it.
    await expect(driver.endSession('d')).resolves.toBeUndefined();
    expect(shell.sent('computer.end')).toEqual([]);
  });

  it('rejects when the shell goes away while the end is on its way', async () => {
    const { driver, shell } = await inSession();
    shell.override = (method) => (method === 'computer.end' ? 'silent' : undefined);
    const ending = driver.endSession('c');
    await tick();
    shell.close();
    expect((await rejection(ending)).message).toBe('The desktop app went away.');
  });
});

describe('DesktopComputerDriver: screenshots', () => {
  it('asks with computer.screenshot { chatId } and returns the bytes and the size', async () => {
    const { driver, shell } = await connected();
    await driver.ensureSession('c', 'Budget');
    const shot = await driver.screenshot('c');
    expect(shell.lines.at(-1)).toBe('GRUNT-RPC {"id":3,"method":"computer.screenshot","params":{"chatId":"c"}}\n');
    expect(Buffer.isBuffer(shot.png)).toBe(true);
    expect(shot.png.equals(FAKE_PNG)).toBe(true);
    expect({ width: shot.width, height: shot.height }).toEqual({ width: 1366, height: 768 });
    expect(Object.keys(shot).sort()).toEqual(['height', 'png', 'width']);
  });

  it('refuses a chat with no session without asking the shell', async () => {
    const { driver, shell } = await connected();
    expect((await rejection(driver.screenshot('c'))).message).toBe(COMPUTER_NO_SESSION_REASON);
    expect((await rejection(driver.cursorPosition('c'))).message).toBe(COMPUTER_NO_SESSION_REASON);
    expect(shell.methods()).toEqual(['computer.hello']);
  });

  it('refuses a screenshot that is not what the port defines, and then has none for that session', async () => {
    const png = FAKE_PNG.toString('base64');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
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
      { png: Buffer.from('not an image at all').toString('base64'), width: 1366, height: 768 },
      { png: jpeg, width: 1366, height: 768 },
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
    ];
    for (const screenshot of bad) {
      const { driver, shell } = await inSession();
      shell.screenshot = screenshot;
      const err = await rejection(driver.screenshot('c'));
      expect(err.message, JSON.stringify(screenshot)?.slice(0, 80)).toBe("The desktop app's screenshot couldn't be read.");
      // The good screenshot from before no longer counts: the shell's last one is the one that could not be read.
      expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: DESKTOP_NO_SCREENSHOT_REASON });
      expect(await driver.target('c', { x: 10, y: 20 })).toEqual({ refuse: DESKTOP_NO_SCREENSHOT_REASON });
      expect(shell.sent('computer.act')).toEqual([]);
      expect(shell.sent('computer.target')).toEqual([]);
    }
    expect(COMPUTER_LIMITS.coordinateMax).toBe(32767);
  });

  it('takes the largest size a coordinate can have', async () => {
    const { driver, shell } = await inSession();
    shell.screenshot = { png: FAKE_PNG.toString('base64'), width: COMPUTER_LIMITS.coordinateMax, height: COMPUTER_LIMITS.coordinateMax };
    const shot = await driver.screenshot('c');
    expect([shot.width, shot.height]).toEqual([32767, 32767]);
  });

  it('takes a screenshot of exactly 5 MB and refuses one byte more', async () => {
    const { driver, shell, channel } = await inSession();
    const largest = Buffer.alloc(MAX_TOOL_IMAGE_BYTES);
    FAKE_PNG.copy(largest, 0, 0, 8);
    shell.screenshot = { png: largest.toString('base64'), width: 1366, height: 768 };
    const shot = await driver.screenshot('c');
    expect(shot.png.length).toBe(MAX_TOOL_IMAGE_BYTES);
    expect(shot.png.equals(largest)).toBe(true);

    const over = Buffer.alloc(MAX_TOOL_IMAGE_BYTES + 1);
    FAKE_PNG.copy(over, 0, 0, 8);
    shell.screenshot = { png: over.toString('base64'), width: 1366, height: 768 };
    expect((await rejection(driver.screenshot('c'))).message).toBe("The desktop app's screenshot couldn't be read.");
    expect(channel.droppedLines).toBe(0);
  });

  it('never holds a line longer than the channel allows: such a screenshot is dropped as it arrives and the call times out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver, shell, channel } = await inSession({ driver: { callTimeoutMs: 1000 } });
    const huge = Buffer.alloc(MAX_TOOL_IMAGE_BYTES + 200_000);
    FAKE_PNG.copy(huge, 0, 0, 8);
    shell.screenshot = { png: huge.toString('base64'), width: 1366, height: 768 };
    expect((await rejection(driver.screenshot('c'))).message).toBe("The desktop app didn't answer in time.");
    expect(channel.droppedLines).toBe(1);
    expect(channel.bufferedBytes).toBe(0);
    // The channel still reads what comes next.
    shell.screenshot = { png: FAKE_PNG.toString('base64'), width: 1366, height: 768 };
    expect((await driver.screenshot('c')).width).toBe(1366);
  });

  it("rejects with the shell's error as one clean line, and in its own words when the shell does not answer", async () => {
    const { driver, shell } = await inSession({ driver: { callTimeoutMs: 250 } });
    shell.override = (method) => (method === 'computer.screenshot' ? { error: { message: `capture failed\nat C:\\x ${'y'.repeat(900)}` } } : undefined);
    const said = await rejection(driver.screenshot('c'));
    expect(said.message.startsWith('capture failed at C:\\x y')).toBe(true);
    expectClean(said.message);
    shell.override = (method) => (method === 'computer.screenshot' ? 'silent' : undefined);
    expect((await rejection(driver.screenshot('c'))).message).toBe("The desktop app didn't answer in time.");
    expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: DESKTOP_NO_SCREENSHOT_REASON });
  });

  it('hands on no screenshot of a session that ended while it was being taken', async () => {
    const { driver, shell } = await inSession();
    shell.override = (method) => (method === 'computer.screenshot' ? 'silent' : undefined);
    const taking = driver.screenshot('c');
    await tick();
    shell.event('computer.stopped', { chatId: 'c', why: 'hotkey' });
    await tick();
    shell.answer(shell.idOf('computer.screenshot'), { png: FAKE_PNG.toString('base64'), width: 1366, height: 768 });
    expect((await rejection(taking)).message).toBe(COMPUTER_NO_SESSION_REASON);
  });

  it('reads the cursor with computer.cursor { chatId }, and refuses an answer that is not two numbers', async () => {
    const { driver, shell } = await inSession();
    expect(await driver.cursorPosition('c')).toEqual({ x: 3, y: 4 });
    expect(shell.sent('computer.cursor')).toEqual([{ chatId: 'c' }]);
    shell.cursor = { x: 3, y: 4, window: 'hwnd-9' };
    expect(await driver.cursorPosition('c')).toEqual({ x: 3, y: 4 });
    for (const cursor of [null, [3, 4], { x: '3', y: 4 }, { x: 3 }, { x: 3, y: null }, 'here', { x: 1e400, y: 4 }]) {
      shell.cursor = cursor;
      expect((await rejection(driver.cursorPosition('c'))).message, JSON.stringify(cursor)).toBe("The cursor's position couldn't be read.");
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
    shell.screenshot = { png: FAKE_PNG.toString('base64'), width: 800, height: 600 };
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
    // And a point nobody should have been able to build.
    const unbuilt: unknown[] = [[-1, 5], [5, -1], [1.5, 5], [5, Number.NaN], ['5', 5], [5], [5, 5, 5], null, '5,5', { x: 5, y: 5 }];
    for (const coordinate of unbuilt) {
      const a = { action: 'left_click', coordinate } as unknown as ComputerAction;
      expect(await driver.act('c', a, EXPECT), JSON.stringify(coordinate)).toEqual({ ok: false, reason: DESKTOP_OUTSIDE_REASON });
    }
    for (const at of [{ x: -1, y: 5 }, { x: 1.5, y: 5 }, { x: '5', y: 5 }, { x: 5 }, null, 'point', [5, 5]]) {
      expect(await driver.target('c', at as never), JSON.stringify(at)).toEqual({ refuse: DESKTOP_OUTSIDE_REASON });
    }
    expect(shell.methods()).toHaveLength(sent);
  });

  it('a new session starts with no screenshot, however the last one ended', async () => {
    const ends: ((made: Awaited<ReturnType<typeof inSession>>) => Promise<void>)[] = [
      async ({ driver }) => driver.endSession('c'),
      async ({ shell, driver }) => {
        shell.sessions.delete('c');
        shell.event('computer.stopped', { chatId: 'c', why: 'idle' });
        await vi.waitFor(async () => expect(await driver.act('c', TYPE, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON }));
      },
      async ({ driver }) => driver.hello(),
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
  it('asks with { chatId, x, y } for a point and { chatId, foreground: true } for the foreground', async () => {
    const { driver, shell } = await inSession();
    await driver.target('c', { x: 5, y: 6 });
    await driver.target('c', 'foreground');
    expect(shell.lines.slice(-2)).toEqual([
      'GRUNT-RPC {"id":4,"method":"computer.target","params":{"chatId":"c","x":5,"y":6}}\n',
      'GRUNT-RPC {"id":5,"method":"computer.target","params":{"chatId":"c","foreground":true}}\n',
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
      ['null', null, 'refuse'],
      ['a word', 'notepad.exe', 'refuse'],
      ['a list', [FAKE_COMPUTER_APP], 'refuse'],
      ['a number', 4242, 'refuse'],
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
    }
  });

  it('throws, in clean words, when the shell fails to answer', async () => {
    const { driver, shell } = await inSession({ driver: { callTimeoutMs: 250 } });
    shell.override = (method) => (method === 'computer.target' ? { error: { message: 'The window is gone.\nstack: at foo' } } : undefined);
    const said = await rejection(driver.target('c', 'foreground'));
    expect(said.message).toBe('The window is gone. stack: at foo');
    shell.override = (method) => (method === 'computer.target' ? 'silent' : undefined);
    expect((await rejection(driver.target('c', { x: 1, y: 1 }))).message).toBe("The desktop app didn't answer in time.");
  });

  it("answers a refusal, not the shell's answer, for a session that ended while it asked", async () => {
    const { driver, shell } = await inSession();
    shell.override = (method) => (method === 'computer.target' ? 'silent' : undefined);
    const asking = driver.target('c', 'foreground');
    await tick();
    shell.event('computer.stopped', { chatId: 'c', why: 'button' });
    await tick();
    shell.answer(shell.idOf('computer.target'), FAKE_COMPUTER_APP);
    expect(await asking).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
  });
});

describe('DesktopComputerDriver: acting', () => {
  it('sends { chatId, action, expect } exactly as handed: nothing added, nothing dropped, nothing changed', async () => {
    const { driver, shell } = await inSession();
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
      expect(shell.lines.at(-1)).toBe(`${RPC_PREFIX}${JSON.stringify({ id, method: 'computer.act', params: { chatId: 'c', action: a, expect: e } })}\n`);
      expect(shell.sent('computer.act').at(-1)).toStrictEqual({ chatId: 'c', action: JSON.parse(JSON.stringify(a)), expect: { ...e } });
    }
    // The expectation is whole: the five facts, no `expectApp`, no null.
    expect(shell.sent('computer.act')[0]).toStrictEqual({
      chatId: 'c',
      action: { action: 'left_click', coordinate: [10, 20] },
      expect: { app: 'C:\\Program Files\\Fake App\\FakeApp.exe', shellView: false, windowId: 'hwnd-1', pid: 4242, startedAt: '2026-10-12T09:00:00.000Z' },
    });
    expect(shell.sent('computer.act')[3]).toStrictEqual({
      chatId: 'c',
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

  it('takes an answer that is not an answer as not knowing what happened', async () => {
    const { driver, shell } = await inSession();
    for (const actAnswer of [{ ok: 'true' }, { ok: 1 }, { ok: null }, {}, null, 'ok', true, [{ ok: true }], 1, { done: true }]) {
      shell.override = (method) => (method === 'computer.act' ? { result: actAnswer } : undefined);
      expect(await driver.act('c', CLICK, EXPECT), JSON.stringify(actAnswer)).toStrictEqual({
        ok: false,
        reason: "The desktop app's answer couldn't be read. Whether the action was carried out is not known.",
      });
    }
    // No result at all.
    shell.override = (method) => (method === 'computer.act' ? ({} as ShellAnswer) : undefined);
    expect(await driver.act('c', CLICK, EXPECT)).toStrictEqual({
      ok: false,
      reason: "The desktop app's answer couldn't be read. Whether the action was carried out is not known.",
    });
  });

  it('answers a refusal, never a throw, when the shell errors, does not answer or goes away', async () => {
    const { driver, shell } = await inSession({ driver: { actTimeoutMs: 30 } });
    shell.override = (method) => (method === 'computer.act' ? { error: { message: `A modifier key is held; nothing was done.\n${'q'.repeat(999)}` } } : undefined);
    const said = await driver.act('c', CLICK, EXPECT);
    expect(said.ok).toBe(false);
    if (!said.ok) {
      expect(said.reason.startsWith('A modifier key is held; nothing was done. q')).toBe(true);
      expectClean(said.reason);
    }
    shell.override = (method) => (method === 'computer.act' ? 'silent' : undefined);
    expect(await driver.act('c', TYPE, EXPECT)).toStrictEqual({
      ok: false,
      reason: "The desktop app didn't answer in time. Whether the action was carried out is not known.",
    });
    const acting = driver.act('c', TYPE, EXPECT);
    await tick();
    shell.close();
    expect(await acting).toStrictEqual({ ok: false, reason: 'The desktop app went away. Whether the action was carried out is not known.' });
    expect(await driver.act('c', TYPE, EXPECT)).toStrictEqual({ ok: false, reason: 'The desktop app went away.' });
  });

  it('answers a refusal when the channel is full, and says nothing was sent', async () => {
    const { driver, shell } = await inSession({ channel: { maxPending: 1 } });
    shell.override = (method) => (method === 'computer.cursor' ? 'silent' : undefined);
    const waiting = driver.cursorPosition('c');
    waiting.catch(() => {});
    expect(await driver.act('c', TYPE, EXPECT)).toStrictEqual({ ok: false, reason: 'The desktop app has too many requests waiting; nothing was sent.' });
    expect(shell.sent('computer.act')).toEqual([]);
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

  it('never throws on an action that is not one', async () => {
    const { driver, shell } = await inSession();
    const sent = shell.methods().length;
    for (const a of [null, undefined, 'left_click', 7]) {
      expect(await driver.act('c', a as never, EXPECT)).toStrictEqual({ ok: false, reason: 'That is not an action Grunt can send.' });
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

describe('DesktopComputerDriver: a fresh hello', () => {
  it('tells its listeners that the shell holds no session, and keeps none itself', async () => {
    const { driver, shell } = connect();
    const reset = vi.fn();
    const off = driver.onReset(reset);
    await driver.hello();
    expect(reset).toHaveBeenCalledTimes(1);
    await driver.ensureSession('c', 'Budget');
    await driver.screenshot('c');
    expect(shell.sessions.has('c')).toBe(true);

    await driver.hello();
    expect(reset).toHaveBeenCalledTimes(2);
    // The shell dropped it when it read the hello; this side asks it for nothing on that chat's behalf.
    expect(shell.sessions.has('c')).toBe(false);
    expect(await driver.act('c', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(shell.sent('computer.act')).toEqual([]);
    expect(shell.sent('computer.end')).toEqual([]);
    off();
    await driver.hello();
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('an end the shell never confirmed is confirmed by it', async () => {
    const { driver, shell } = await inSession({ driver: { endTimeoutMs: 30 } });
    shell.override = (method) => (method === 'computer.end' ? 'silent' : undefined);
    await expect(driver.endSession('c')).rejects.toThrow("didn't answer in time");
    shell.override = () => undefined;
    shell.hello = HELLO_OFF;
    await driver.hello();
    // Nothing is left to end, so a shell that is off is not even asked.
    await expect(driver.endSession('c')).resolves.toBeUndefined();
    expect(shell.sent('computer.end')).toHaveLength(1);
  });

  it('a hello the shell did not answer, or answered unreadably, resets nothing', async () => {
    const { driver, shell } = await inSession({ driver: { callTimeoutMs: 250 } });
    const reset = vi.fn();
    driver.onReset(reset);
    for (const answer of [{ error: { message: 'no' } }, { result: null }, { result: 'hello' }, 'silent'] as ShellAnswer[]) {
      shell.override = (method) => (method === 'computer.hello' ? answer : undefined);
      await driver.hello();
      expect(driver.available()).toBe(false);
    }
    expect(reset).not.toHaveBeenCalled();
  });

  it('a start answered yes from before the hello is not a session after it', async () => {
    const { driver, shell } = await connected();
    shell.override = (method) => (method === 'computer.start' ? 'silent' : undefined);
    const starting = driver.ensureSession('c', 'Budget');
    await tick();
    await driver.hello();
    shell.override = () => undefined;
    shell.sessions.add('c');
    shell.answer(shell.idOf('computer.start'), { ok: true });
    expect(await starting).toEqual({ ok: false, reason: 'The desktop app started over while Grunt was asking, so nothing was started.' });
    expect(shell.sent('computer.end')).toEqual([{ chatId: 'c' }]);
    expect(shell.sessions.has('c')).toBe(false);
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
