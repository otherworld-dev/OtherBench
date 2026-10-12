import { describe, expect, it } from 'vitest';
import { appArgs, classifyTarget, expectationOf } from '../src/domain/computer-apps.js';
import type { ComputerExpectation } from '../src/ports/computer.js';
import { FAKE_COMPUTER_APP, FAKE_PNG, FAKE_WINDOW_CHANGED_REASON, FakeComputerDriver, fakeComputerTarget } from '../src/testing/fake-computer.js';

const EXPECT: ComputerExpectation = {
  app: FAKE_COMPUTER_APP.path,
  windowId: FAKE_COMPUTER_APP.windowId,
  pid: FAKE_COMPUTER_APP.pid,
  startedAt: FAKE_COMPUTER_APP.startedAt,
};

describe('FakeComputerDriver', () => {
  it('records sessions and actions, answers its settable targets, and reports a stop', async () => {
    const driver = new FakeComputerDriver();
    expect(driver.available()).toBe(true);
    expect(await driver.ensureSession('c1', 'Chat one')).toEqual({ ok: true });
    expect(await driver.ensureSession('c1', 'Chat one')).toEqual({ ok: true });
    expect(driver.started).toEqual([{ chatId: 'c1', chatTitle: 'Chat one' }]);

    const shot = await driver.screenshot('c1');
    expect(shot).toEqual({ png: FAKE_PNG, width: 1366, height: 768 });
    expect(FAKE_PNG.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    expect(await driver.target('c1', { x: 1, y: 2 })).toEqual(FAKE_COMPUTER_APP);
    driver.foregroundTarget = { refuse: 'nope' };
    expect(await driver.target('c1', 'foreground')).toEqual({ refuse: 'nope' });
    expect(driver.targets).toEqual([{ chatId: 'c1', at: { x: 1, y: 2 } }, { chatId: 'c1', at: 'foreground' }]);

    expect(await driver.act('c1', { action: 'left_click', coordinate: [1, 2] }, EXPECT)).toEqual({ ok: true });
    expect(driver.actions).toEqual([{ chatId: 'c1', action: { action: 'left_click', coordinate: [1, 2] }, expect: EXPECT }]);

    const stopped: string[] = [];
    const off = driver.onStopped((chatId, why) => stopped.push(`${chatId}:${why}`));
    driver.stop('c1', 'hotkey');
    expect(stopped).toEqual(['c1:hotkey']);
    expect(driver.hasSession('c1')).toBe(false);
    off();
    driver.stop('c1');
    expect(stopped).toEqual(['c1:hotkey']);

    // A stopped session needs a new start.
    await driver.ensureSession('c1', 'Chat one');
    expect(driver.started).toHaveLength(2);
    await driver.endSession('c1');
    expect(driver.ended).toEqual(['c1']);
  });

  it('answers a refused start without starting a session', async () => {
    const driver = new FakeComputerDriver();
    driver.startAnswer = { ok: false, reason: "The user didn't let Grunt control the computer." };
    expect(await driver.ensureSession('c1', 'Chat')).toEqual({ ok: false, reason: "The user didn't let Grunt control the computer." });
    expect(driver.hasSession('c1')).toBe(false);
  });

  it('gives a target core finds ordinary, whose described arguments carry the full expectation', () => {
    const classified = classifyTarget(FAKE_COMPUTER_APP);
    expect(classified).toMatchObject({ kind: 'app', key: FAKE_COMPUTER_APP.path, name: 'FakeApp.exe', risk: 'normal' });
    if (classified.kind !== 'app') throw new Error('unreachable');
    expect(expectationOf(appArgs(classified))).toEqual(EXPECT);
    expect(fakeComputerTarget({ windowId: 'hwnd-2' })).toEqual({ ...FAKE_COMPUTER_APP, windowId: 'hwnd-2' });
  });

  it('does nothing when the window under the point is no longer the one the action was approved for', async () => {
    const driver = new FakeComputerDriver();
    const click = { action: 'left_click', coordinate: [5, 5] } as const;

    // Another window of the same app, the same app restarted, another app: each is a change.
    for (const now of [fakeComputerTarget({ windowId: 'hwnd-2' }), fakeComputerTarget({ pid: 999 }), fakeComputerTarget({ startedAt: '2026-10-12T10:00:00.000Z' }), fakeComputerTarget({ path: 'C:\\Windows\\System32\\cmd.exe' })]) {
      driver.pointTarget = now;
      expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    }
    driver.pointTarget = { refuse: 'No window there.' };
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: 'No window there.' });
    expect(driver.actions).toEqual([]);
    expect(driver.refused).toHaveLength(5);
    expect(driver.refused[0]).toEqual({ chatId: 'c1', action: click, expect: EXPECT });

    driver.pointTarget = FAKE_COMPUTER_APP;
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: true });
    expect(driver.actions).toHaveLength(1);
  });

  it('checks typing and keys against the foreground window, and clicks against the window under the point', async () => {
    const driver = new FakeComputerDriver();
    // The person answered the card, so another window now has the keyboard.
    driver.changeForeground(fakeComputerTarget({ path: 'C:\\Program Files\\Other\\Other.exe', windowId: 'hwnd-9', pid: 7 }));
    expect(await driver.act('c1', { action: 'type', text: 'hello' }, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    expect(await driver.act('c1', { action: 'key', text: 'ctrl+s' }, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    expect(await driver.act('c1', { action: 'scroll', coordinate: [1, 1], scroll_direction: 'down', scroll_amount: 3 }, EXPECT)).toEqual({ ok: true });
    expect(driver.actions.map((a) => a.action.action)).toEqual(['scroll']);
    expect(driver.refused.map((a) => a.action.action)).toEqual(['type', 'key']);
  });

  it("answers the shell's own shortcuts", () => {
    const driver = new FakeComputerDriver();
    expect(driver.reservedKeys()).toEqual([]);
    driver.reserved = ['Ctrl+Alt+G', 'Ctrl+Alt+Backspace'];
    expect(driver.reservedKeys()).toEqual(['Ctrl+Alt+G', 'Ctrl+Alt+Backspace']);
  });
});
