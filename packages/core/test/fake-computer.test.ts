import { describe, expect, it } from 'vitest';
import { appArgs, classifyTarget, COMPUTER_GRUNT_UI_REASON, expectationOf, GRUNT_UI_TITLE } from '../src/domain/computer-apps.js';
import type { ComputerAction, ComputerExpectation } from '../src/ports/computer.js';
import {
  FAKE_COMPUTER_APP,
  FAKE_KEYBOARD_UNKNOWN_REASON,
  FAKE_MODIFIER_HELD_REASON,
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
  shellView: FAKE_COMPUTER_APP.shellView,
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

  it('shows and tells nothing to a chat that has no control session', async () => {
    const driver = new FakeComputerDriver();
    await expect(driver.screenshot('c1')).rejects.toThrow(FAKE_NO_SESSION_REASON);
    await expect(driver.cursorPosition('c1')).rejects.toThrow(FAKE_NO_SESSION_REASON);
    expect(await driver.target('c1', { x: 1, y: 2 })).toEqual({ refuse: FAKE_NO_SESSION_REASON });
    expect(await driver.target('c1', 'foreground')).toEqual({ refuse: FAKE_NO_SESSION_REASON });
    expect(driver.screenshots).toEqual([]);
    expect(driver.targets).toEqual([]);

    await driver.ensureSession('c1', 'Chat one');
    expect(await driver.screenshot('c1')).toMatchObject({ width: 1366, height: 768 });
    expect(await driver.cursorPosition('c1')).toEqual({ x: 0, y: 0 });
    expect(await driver.target('c1', 'foreground')).toEqual(FAKE_COMPUTER_APP);
    // Another chat's session is not this chat's, and a stopped session is none.
    await expect(driver.screenshot('c2')).rejects.toThrow(FAKE_NO_SESSION_REASON);
    driver.stop('c1');
    await expect(driver.screenshot('c1')).rejects.toThrow(FAKE_NO_SESSION_REASON);
    expect(await driver.target('c1', 'foreground')).toEqual({ refuse: FAKE_NO_SESSION_REASON });
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

  it("does nothing in the approved window once it shows Grunt's own UI, as the shell checks before every step", async () => {
    const driver = await started();
    const click: ComputerAction = { action: 'left_click', coordinate: [5, 5] };
    // The same window, process and run: only its title changed (the browser went to Grunt after the card).
    driver.pointTarget = fakeComputerTarget({ title: `${GRUNT_UI_TITLE} - Google Chrome` });
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: COMPUTER_GRUNT_UI_REASON });
    driver.changeForeground(fakeComputerTarget({ title: GRUNT_UI_TITLE }));
    expect(await driver.act('c1', { action: 'type', text: 'hi' }, EXPECT)).toEqual({ ok: false, reason: COMPUTER_GRUNT_UI_REASON });
    expect(driver.actions).toEqual([]);
    driver.pointTarget = FAKE_COMPUTER_APP;
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: true });
  });

  it('does nothing when the approved window has become a file view, or a file dialog of the same app is now there', async () => {
    const driver = await started();
    const click: ComputerAction = { action: 'left_click', coordinate: [5, 5] };
    // The same app, the same process, the same window: but it now shows a shell file view.
    driver.pointTarget = fakeComputerTarget({ shellView: true });
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    // The same app and process, another window: its Open dialog came up over the point.
    driver.pointTarget = fakeComputerTarget({ shellView: true, windowId: 'hwnd-dialog', title: 'Open' });
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    // A shell that no longer says whether it is one counts as one.
    driver.pointTarget = { ...FAKE_COMPUTER_APP, shellView: undefined as unknown as boolean };
    expect(await driver.act('c1', click, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    // The same for the keyboard.
    driver.changeForeground(fakeComputerTarget({ shellView: true }));
    expect(await driver.act('c1', { action: 'type', text: 'x' }, EXPECT)).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    expect(driver.actions).toEqual([]);

    // And the other way round: a card about a file dialog does not cover the main window.
    driver.pointTarget = FAKE_COMPUTER_APP;
    expect(await driver.act('c1', click, { ...EXPECT, shellView: true })).toEqual({ ok: false, reason: FAKE_WINDOW_CHANGED_REASON });
    // What was approved, as it was approved, is carried out.
    const dialog = fakeComputerTarget({ shellView: true, windowId: 'hwnd-dialog' });
    driver.pointTarget = dialog;
    expect(await driver.act('c1', click, { ...EXPECT, shellView: true, windowId: 'hwnd-dialog' })).toEqual({ ok: true });
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
      { ...EXPECT, shellView: undefined },
      { ...EXPECT, shellView: 'false' },
    ];
    for (const expectation of partial) {
      await expect(driver.act('c1', click, expectation as ComputerExpectation), JSON.stringify(expectation)).rejects.toThrow(/not whole/);
    }
    expect(driver.actions).toEqual([]);
  });

  it('does nothing while a modifier key is down, whoever is holding it', async () => {
    const driver = await started();
    const each: ComputerAction[] = [
      { action: 'key', text: 'ctrl+s' },
      { action: 'key', text: 'return' },
      { action: 'type', text: 'hello' },
      { action: 'left_click', coordinate: [5, 5] },
      { action: 'scroll', coordinate: [5, 5], scroll_direction: 'down', scroll_amount: 1 },
    ];
    for (const held of [['ctrl'], ['shift'], ['alt'], ['win'], ['ctrl', 'alt']]) {
      driver.held = held;
      for (const action of each) expect(await driver.act('c1', action, EXPECT), `${held.join('+')} ${action.action}`).toEqual({ ok: false, reason: FAKE_MODIFIER_HELD_REASON });
    }
    expect(driver.actions).toEqual([]);
    expect(driver.refused).toHaveLength(25);
    // It does not release what it did not press and then carry on: it refuses until the key is up.
    expect(driver.held).toEqual(['ctrl', 'alt']);
    driver.held = [];
    for (const action of each) expect(await driver.act('c1', action, EXPECT)).toEqual({ ok: true });
  });

  it('does nothing while it cannot read the state of the keyboard', async () => {
    const driver = await started();
    driver.keyboardKnown = false;
    expect(await driver.act('c1', { action: 'key', text: 'ctrl+s' }, EXPECT)).toEqual({ ok: false, reason: FAKE_KEYBOARD_UNKNOWN_REASON });
    expect(await driver.act('c1', { action: 'type', text: 'x' }, EXPECT)).toEqual({ ok: false, reason: FAKE_KEYBOARD_UNKNOWN_REASON });
    expect(await driver.act('c1', { action: 'left_click', coordinate: [1, 1] }, EXPECT)).toEqual({ ok: false, reason: FAKE_KEYBOARD_UNKNOWN_REASON });
    expect(driver.actions).toEqual([]);
    driver.keyboardKnown = true;
    expect(await driver.act('c1', { action: 'key', text: 'ctrl+s' }, EXPECT)).toEqual({ ok: true });
  });

  it('holds a modifier only inside one key action, and lets go on every way out of it', async () => {
    const driver = await started();
    // Mid-combination the modifiers are down...
    const seen: string[][] = [];
    driver.midAction = (held) => seen.push([...held]);
    expect(await driver.act('c1', { action: 'key', text: 'ctrl+shift+s' }, EXPECT)).toEqual({ ok: true });
    expect(seen).toEqual([['ctrl', 'shift']]);
    // ...and up again afterwards.
    expect(driver.pressed).toEqual([]);
    expect(driver.held).toEqual([]);

    // The action fails half-way: nothing is left down, and the next action is not refused for it.
    driver.midAction = () => {
      throw new Error('the shell fell over mid-combination');
    };
    await expect(driver.act('c1', { action: 'key', text: 'ctrl+shift+z' }, EXPECT)).rejects.toThrow('the shell fell over mid-combination');
    expect(driver.pressed).toEqual([]);
    expect(driver.held).toEqual([]);
    driver.midAction = null;
    expect(await driver.act('c1', { action: 'key', text: 'return' }, EXPECT)).toEqual({ ok: true });

    // Typed text and clicks hold nothing at any point.
    const during: string[][] = [];
    driver.midAction = (held) => during.push([...held]);
    await driver.act('c1', { action: 'type', text: 'Hello' }, EXPECT);
    await driver.act('c1', { action: 'left_click', coordinate: [1, 1] }, EXPECT);
    await driver.act('c1', { action: 'key', text: 'f5' }, EXPECT);
    expect(during).toEqual([[], [], []]);
  });

  it('lets go of what it pressed itself when the session stops or ends mid-action', async () => {
    const driver = await started();
    const seen: string[][] = [];
    driver.midAction = () => {
      seen.push([...driver.pressed]);
      driver.stop('c1', 'hotkey');
      seen.push([...driver.pressed]);
    };
    await driver.act('c1', { action: 'key', text: 'ctrl+shift+s' }, EXPECT);
    expect(seen).toEqual([['ctrl', 'shift'], []]);
    expect(driver.pressed).toEqual([]);

    await driver.ensureSession('c1', 'Chat one');
    const ended: string[][] = [];
    driver.midAction = () => {
      // endSession has no await in it: its release has happened by the time the call returns.
      void driver.endSession('c1');
      ended.push([...driver.pressed]);
    };
    await driver.act('c1', { action: 'key', text: 'alt+left' }, EXPECT);
    expect(ended).toEqual([[]]);
    expect(driver.pressed).toEqual([]);
  });

  it('never lets go of a modifier the person is holding: not on stop, not on end, not after a refusal', async () => {
    const driver = await started();
    driver.held = ['ctrl', 'shift'];
    // A refused action leaves it as it was.
    expect(await driver.act('c1', { action: 'key', text: 'return' }, EXPECT)).toEqual({ ok: false, reason: FAKE_MODIFIER_HELD_REASON });
    expect(driver.held).toEqual(['ctrl', 'shift']);
    expect(driver.pressed).toEqual([]);

    driver.stop('c1', 'hotkey');
    expect(driver.held).toEqual(['ctrl', 'shift']);

    await driver.ensureSession('c1', 'Chat one');
    driver.held = ['alt'];
    await driver.endSession('c1');
    expect(driver.held).toEqual(['alt']);

    // A new session still refuses to act until the person lets go.
    await driver.ensureSession('c1', 'Chat one');
    expect(await driver.act('c1', { action: 'left_click', coordinate: [1, 1] }, EXPECT)).toEqual({ ok: false, reason: FAKE_MODIFIER_HELD_REASON });
    expect(driver.actions).toEqual([]);
    driver.held = [];
    expect(await driver.act('c1', { action: 'left_click', coordinate: [1, 1] }, EXPECT)).toEqual({ ok: true });
  });

  it("keeps what the driver pressed apart from what the person holds, and counts only the first as its own", async () => {
    const driver = await started();
    const seen: { pressed: string[]; held: string[] }[] = [];
    driver.midAction = () => seen.push({ pressed: [...driver.pressed], held: [...driver.held] });
    await driver.act('c1', { action: 'key', text: 'ctrl+s' }, EXPECT);
    expect(seen).toEqual([{ pressed: ['ctrl'], held: [] }]);
    // Its own modifiers never end up in the person's state, and nothing of the person's in its own.
    expect(driver.held).toEqual([]);
    expect(driver.pressed).toEqual([]);
  });

  it('has no call that presses without releasing', () => {
    const calls = Object.getOwnPropertyNames(FakeComputerDriver.prototype);
    expect(calls).toContain('act');
    for (const call of calls) expect(call, call).not.toMatch(/hold|keyDown|keyUp|mouseDown|mouseUp|press|release/i);
  });

  it("answers the shell's own shortcuts", () => {
    const driver = new FakeComputerDriver();
    expect(driver.reservedKeys()).toEqual([]);
    driver.reserved = ['Ctrl+Alt+G', 'Ctrl+Alt+Backspace'];
    expect(driver.reservedKeys()).toEqual(['Ctrl+Alt+G', 'Ctrl+Alt+Backspace']);
    // A shell that has not said what its shortcuts are.
    driver.reserved = null;
    expect(driver.reservedKeys()).toBeNull();
  });

  it('sends no key at all while the shortcuts are not known', async () => {
    const driver = await started();
    driver.reserved = null;
    await expect(driver.act('c1', { action: 'key', text: 'ctrl+s' }, EXPECT)).rejects.toThrow(/core would not send/);
    await expect(driver.act('c1', { action: 'key', text: 'shift+tab' }, EXPECT)).rejects.toThrow(/core would not send/);
    await expect(driver.act('c1', { action: 'key', text: 'return' }, EXPECT)).rejects.toThrow(/core would not send/);
    await expect(driver.act('c1', { action: 'key', text: 'f9' }, EXPECT)).rejects.toThrow(/core would not send/);
    expect(await driver.act('c1', { action: 'type', text: 'hello' }, EXPECT)).toEqual({ ok: true });
    expect(await driver.act('c1', { action: 'left_click', coordinate: [1, 1] }, EXPECT)).toEqual({ ok: true });
  });
});
