import { describe, expect, it } from 'vitest';
import { appArgs, classifyTarget, expectationOf } from '../src/domain/computer-apps.js';
import type { ComputerAction, ComputerExpectation } from '../src/ports/computer.js';
import {
  FAKE_COMPUTER_APP,
  FAKE_NO_SESSION_REASON,
  FAKE_PNG,
  FAKE_WINDOW_CHANGED_REASON,
  FakeComputerDriver,
  fakeComputerTarget,
} from '../src/testing/fake-computer.js';

const EXPECT: ComputerExpectation = {
  app: FAKE_COMPUTER_APP.path,
  windowId: FAKE_COMPUTER_APP.windowId,
  pid: FAKE_COMPUTER_APP.pid,
  startedAt: FAKE_COMPUTER_APP.startedAt,
};

async function started(): Promise<FakeComputerDriver> {
  const driver = new FakeComputerDriver();
  await driver.ensureSession('c1', 'Chat one');
  return driver;
}

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

  it('does nothing for a chat that has no control session: never started, refused, stopped or ended', async () => {
    const click: ComputerAction = { action: 'left_click', coordinate: [5, 5] };
    const never = new FakeComputerDriver();
    expect(await never.act('c1', click, EXPECT)).toEqual({ ok: false, reason: FAKE_NO_SESSION_REASON });

    const refusedStart = new FakeComputerDriver();
    refusedStart.startAnswer = { ok: false, reason: 'no' };
    await refusedStart.ensureSession('c1', 'Chat');
    expect(await refusedStart.act('c1', click, EXPECT)).toEqual({ ok: false, reason: FAKE_NO_SESSION_REASON });

    const driver = await started();
    // Another chat's session is not this chat's.
    expect(await driver.act('c2', click, EXPECT)).toEqual({ ok: false, reason: FAKE_NO_SESSION_REASON });
    driver.stop('c1', 'hotkey');
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: FAKE_NO_SESSION_REASON });
    await driver.ensureSession('c1', 'Chat one');
    await driver.endSession('c1');
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: FAKE_NO_SESSION_REASON });
    expect(driver.actions).toEqual([]);
    expect(never.actions).toEqual([]);
    expect(refusedStart.actions).toEqual([]);
  });

  it('gives a target core finds ordinary, whose described arguments carry the full expectation', () => {
    const classified = classifyTarget(FAKE_COMPUTER_APP);
    expect(classified).toMatchObject({ kind: 'app', key: FAKE_COMPUTER_APP.path, name: 'FakeApp.exe', risk: 'normal' });
    if (classified.kind !== 'app') throw new Error('unreachable');
    expect(expectationOf(appArgs(classified))).toEqual(EXPECT);
    expect(fakeComputerTarget({ windowId: 'hwnd-2' })).toEqual({ ...FAKE_COMPUTER_APP, windowId: 'hwnd-2' });
  });

  it('can stand in for a file dialog of an ordinary app, which core asks about every time', () => {
    const dialog = fakeComputerTarget({ shellView: true, title: 'Open', windowId: 'hwnd-dialog' });
    expect(classifyTarget(dialog)).toMatchObject({ kind: 'app', key: FAKE_COMPUTER_APP.path, risk: 'high', windowId: 'hwnd-dialog' });
    expect(FAKE_COMPUTER_APP.shellView).toBe(false);
  });

  it('does nothing when the window under the point is no longer the one the action was approved for', async () => {
    const driver = await started();
    const click: ComputerAction = { action: 'left_click', coordinate: [5, 5] };

    // Another window of the same app, the same app restarted, another app: each is a change.
    for (const now of [fakeComputerTarget({ windowId: 'hwnd-2' }), fakeComputerTarget({ pid: 999 }), fakeComputerTarget({ startedAt: '2026-10-12T10:00:00.000Z' }), fakeComputerTarget({ path: 'C:\\Windows\\System32\\cmd.exe' })]) {
      driver.pointTarget = now;
      expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    }
    // The same path in another letter case is another app: the comparison is exact.
    driver.pointTarget = fakeComputerTarget({ path: FAKE_COMPUTER_APP.path.toLowerCase() });
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    driver.pointTarget = { refuse: 'No window there.' };
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: 'No window there.' });
    expect(driver.actions).toEqual([]);
    expect(driver.refused).toHaveLength(6);
    expect(driver.refused[0]).toEqual({ chatId: 'c1', action: click, expect: EXPECT });

    driver.pointTarget = FAKE_COMPUTER_APP;
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: true });
    expect(driver.actions).toHaveLength(1);
  });

  it('checks typing and keys against the foreground window, and clicks against the window under the point', async () => {
    const driver = await started();
    // The person answered the card, so another window now has the keyboard.
    driver.changeForeground(fakeComputerTarget({ path: 'C:\\Program Files\\Other\\Other.exe', windowId: 'hwnd-9', pid: 7 }));
    expect(await driver.act('c1', { action: 'type', text: 'hello' }, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    expect(await driver.act('c1', { action: 'key', text: 'ctrl+s' }, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    expect(await driver.act('c1', { action: 'scroll', coordinate: [1, 1], scroll_direction: 'down', scroll_amount: 3 }, EXPECT)).toEqual({ ok: true });
    expect(driver.actions.map((a) => a.action.action)).toEqual(['scroll']);
    expect(driver.refused.map((a) => a.action.action)).toEqual(['type', 'key']);
  });

  it('throws when it is handed an action core would not send, so a layer that skipped parseAction fails its test', async () => {
    const driver = await started();
    driver.reserved = ['Ctrl+Shift+Space'];
    const notSendable: unknown[] = [
      // Not in canonical form: the model's own spelling of a key, a fractional pixel, a field too many.
      { action: 'key', text: 'CTRL+S' },
      { action: 'key', text: 's+ctrl' },
      { action: 'key', text: 'Return' },
      { action: 'left_click', coordinate: [1.5, 2] },
      { action: 'left_click', coordinate: [1, 2], text: 'extra' },
      { action: 'scroll', coordinate: [1, 2], scroll_direction: 'down' },
      // Refused combinations and Grunt's own shortcut.
      { action: 'key', text: 'ctrl+escape' },
      { action: 'key', text: 'alt+tab' },
      { action: 'key', text: 'alt+f4' },
      { action: 'key', text: 'super+r' },
      { action: 'key', text: 'ctrl+a ctrl+c' },
      { action: 'key', text: 'ctrl+shift+space' },
      // Outside a cap.
      { action: 'key', text: 's'.repeat(65) },
      { action: 'type', text: 'a'.repeat(4001) },
      { action: 'type', text: '' },
      { action: 'type', text: 'esc\u001b' },
      { action: 'type', text: 'half \ud83d' },
      { action: 'scroll', coordinate: [1, 2], scroll_direction: 'down', scroll_amount: 11 },
      { action: 'scroll', coordinate: [1, 2], scroll_direction: 'down', scroll_amount: 0 },
      { action: 'scroll', coordinate: [1, 2], scroll_direction: 'sideways', scroll_amount: 3 },
      // Off the screenshot.
      { action: 'left_click', coordinate: [1366, 10] },
      { action: 'left_click', coordinate: [10, 768] },
      { action: 'left_click', coordinate: [-1, 5] },
      { action: 'mouse_move', coordinate: [40000, 5] },
      // Not an action that changes anything, or not an action.
      { action: 'left_click_drag', coordinate: [1, 2] },
      { action: 'hold_key', text: 'shift' },
      { action: 'left_click' },
      {},
      null,
    ];
    for (const action of notSendable) {
      await expect(driver.act('c1', action as ComputerAction, EXPECT), JSON.stringify(action)).rejects.toThrow(/core would not send/);
    }
    // The looking actions have their own calls: act is not how a wait or a screenshot is done.
    for (const action of [{ action: 'screenshot' }, { action: 'wait', duration: 1 }]) {
      await expect(driver.act('c1', action as unknown as ComputerAction, EXPECT)).rejects.toThrow(/core would not send|looking action/);
    }
    expect(driver.actions).toEqual([]);
    expect(driver.refused).toEqual([]);

    // The largest of everything is still sendable.
    const atTheCaps: ComputerAction[] = [
      { action: 'left_click', coordinate: [1365, 767] },
      { action: 'scroll', coordinate: [0, 0], scroll_direction: 'left', scroll_amount: 10 },
      { action: 'type', text: 'a'.repeat(4000) },
      { action: 'type', text: 'two\nlines\tand a tab' },
      { action: 'key', text: 'ctrl+shift+f12' },
    ];
    for (const action of atTheCaps) expect(await driver.act('c1', action, EXPECT), JSON.stringify(action).slice(0, 80)).toEqual({ ok: true });
    expect(driver.actions).toHaveLength(atTheCaps.length);
  });

  it('throws when it is handed an expectation that is not whole', async () => {
    const driver = await started();
    const click: ComputerAction = { action: 'left_click', coordinate: [5, 5] };
    const partial: unknown[] = [
      null,
      undefined,
      {},
      { ...EXPECT, app: 'FakeApp.exe' },
      { ...EXPECT, app: '' },
      { ...EXPECT, windowId: '' },
      { ...EXPECT, pid: 0 },
      { ...EXPECT, pid: '4242' },
      { ...EXPECT, startedAt: undefined },
    ];
    for (const expectation of partial) {
      await expect(driver.act('c1', click, expectation as ComputerExpectation), JSON.stringify(expectation)).rejects.toThrow(/not whole/);
    }
    expect(driver.actions).toEqual([]);
  });

  it("answers the shell's own shortcuts", () => {
    const driver = new FakeComputerDriver();
    expect(driver.reservedKeys()).toEqual([]);
    driver.reserved = ['Ctrl+Alt+G', 'Ctrl+Alt+Backspace'];
    expect(driver.reservedKeys()).toEqual(['Ctrl+Alt+G', 'Ctrl+Alt+Backspace']);
  });
});
