import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionSummary, expectationOf, parseAction } from '@otherbench/core/domain/computer-apps.js';
import { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { ChatEngine } from '@otherbench/core/ports/chat-engine.js';
import type { ComputerAction, ComputerAnswer, ComputerExpectation, ComputerStopReason } from '@otherbench/core/ports/computer.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { FAKE_COMPUTER_APP, FakeComputerDriver, fakeComputerTarget } from '@otherbench/core/testing/fake-computer.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { COMPUTER_NO_SCREENSHOT_REASON } from '@otherbench/tools/computer-tool.js';
import { OtherBenchToolProvider } from '@otherbench/tools/provider.js';
import {
  cancelChatReplies,
  COMPUTER_CONFIRMING_REASON,
  COMPUTER_END_UNCONFIRMED_REASON,
  COMPUTER_NO_SESSION_REASON,
  COMPUTER_OTHER_CHAT_REASON,
  COMPUTER_START_STOPPED_REASON,
  ComputerSessions,
  endSessionsLeftWithoutAReply,
} from '../../src/computer/sessions.js';
import { AppEventBus } from '../../src/stream/events.js';

/**
 * `ComputerSessions` over `FakeComputerDriver` only: nothing here moves a
 * mouse, presses a key or looks at a screen. Actions are what core's
 * `parseAction` returns and expectations what `expectationOf` returns, as the
 * fake insists.
 */

/** A canonical action, built the only way one is built. */
function action(args: Record<string, unknown>): ComputerAction {
  const parsed = parseAction(args, { bounds: { width: 1366, height: 768 }, reserved: [] });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.action as ComputerAction;
}

/** The expectation a card for the fake's app would carry. */
function expectFor(over: Partial<typeof FAKE_COMPUTER_APP> = {}): ComputerExpectation {
  const t = fakeComputerTarget(over);
  const expectation = expectationOf({ app: t.path, appShellView: t.shellView, appWindow: t.windowId, appPid: t.pid, appStarted: t.startedAt });
  if (expectation === null) throw new Error('no expectation');
  return expectation;
}

const CLICK = action({ action: 'left_click', coordinate: [10, 10] });
const EXPECT = expectFor();

/** A fake whose native start dialog stays up until the test answers it. */
class DialogDriver extends FakeComputerDriver {
  /** Every call that reached the driver's `ensureSession`. */
  readonly asked: string[] = [];
  /** While true, a start waits for `answer()`. */
  dialogUp = false;
  private readonly waiting: (() => void)[] = [];

  override async ensureSession(chatId: string, chatTitle: string): Promise<ComputerAnswer> {
    this.asked.push(chatId);
    if (this.dialogUp) await new Promise<void>((resolve) => this.waiting.push(resolve));
    return super.ensureSession(chatId, chatTitle);
  }

  /** The person answers every dialog that is up (with `startAnswer`). */
  answer(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

function setup(driver: DialogDriver = new DialogDriver(), more: { chatExists?: (chatId: string) => boolean; endTimeoutMs?: number } = {}) {
  const events: AppEvent[] = [];
  const cancelChat = vi.fn();
  const sessions = new ComputerSessions(
    driver,
    { emit: (e) => events.push(e), cancelChat, ...(more.chatExists ? { chatExists: more.chatExists } : {}) },
    more.endTimeoutMs !== undefined ? { endTimeoutMs: more.endTimeoutMs } : {}
  );
  const stopped: [string, ComputerStopReason][] = [];
  sessions.onStopped((chatId, why) => stopped.push([chatId, why]));
  return { driver, events, cancelChat, sessions, stopped };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Called once, with exactly these arguments. */
function calledOnceWith(spy: { mock: { calls: unknown[][] } }, ...args: unknown[]): void {
  expect(spy.mock.calls).toEqual([args]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ComputerSessions', () => {
  it('announces a started session once, then each action it carried out with a one-line summary', async () => {
    const { sessions, events } = setup();
    expect(await sessions.ensureSession('c1', 'Budget')).toEqual({ ok: true });
    expect(await sessions.ensureSession('c1', 'Budget')).toEqual({ ok: true });
    await sessions.screenshot('c1');
    expect(await sessions.cursorPosition('c1')).toEqual({ x: 0, y: 0 });
    expect(await sessions.act('c1', CLICK, EXPECT)).toEqual({ ok: true });
    expect(await sessions.act('c1', action({ action: 'key', text: 'ctrl+s' }), EXPECT)).toEqual({ ok: true });
    expect(events).toEqual([
      { type: 'computer-session', chatId: 'c1', active: true },
      { type: 'computer-session', chatId: 'c1', active: true, lastAction: 'click at 10, 10' },
      { type: 'computer-session', chatId: 'c1', active: true, lastAction: 'press ctrl+s' },
    ]);
    expect(sessions.activeChat()).toBe('c1');
  });

  it('refuses a second chat while one is in control, without asking the shell', async () => {
    const { sessions, driver } = setup();
    await sessions.ensureSession('c1', 'One');
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: false, reason: 'Another chat is controlling this computer. Stop it first.' });
    expect(COMPUTER_OTHER_CHAT_REASON).toBe('Another chat is controlling this computer. Stop it first.');
    expect(driver.asked).toEqual(['c1']);
    expect(driver.started.map((s) => s.chatId)).toEqual(['c1']);
  });

  it('does not count a refused start as a session, and asks again the next time', async () => {
    const { sessions, driver, events, stopped } = setup();
    const refusal = { ok: false as const, reason: "The user didn't let OtherBench control the computer." };
    driver.startAnswer = refusal;
    // The driver's own answer, the same object: nothing is reworded.
    expect(await sessions.ensureSession('c1', 'One')).toBe(refusal);
    expect(sessions.activeChat()).toBeNull();
    expect(events).toEqual([]);
    expect(stopped).toEqual([]);
    // A refusal is not remembered: the next call shows the dialog again, and nothing was retried in between.
    expect(driver.started).toHaveLength(1);
    expect(await sessions.ensureSession('c1', 'One')).toBe(refusal);
    expect(driver.started).toHaveLength(2);
    driver.startAnswer = { ok: true };
    expect(await sessions.ensureSession('c1', 'One')).toEqual({ ok: true });
    expect(driver.started).toHaveLength(3);
    expect(sessions.activeChat()).toBe('c1');
    // A refused chat does not hold the computer either.
    expect(events).toEqual([{ type: 'computer-session', chatId: 'c1', active: true }]);
  });

  it("ends the session, cancels the chat's reply and tells its own listeners when the shell stops it", async () => {
    const { sessions, driver, events, cancelChat, stopped } = setup();
    await sessions.ensureSession('c1', 'One');
    driver.stop('c1', 'hotkey');
    expect(sessions.activeChat()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: false });
    calledOnceWith(cancelChat, 'c1');
    expect(stopped).toEqual([['c1', 'hotkey']]);
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
  });

  it('stop() ends the session and cancels the reply; ending a chat with no session announces nothing', async () => {
    const { sessions, driver, events, cancelChat, stopped } = setup();
    await sessions.endSession('c9');
    expect(events).toEqual([]);
    expect(stopped).toEqual([]);
    await sessions.ensureSession('c1', 'One');
    await sessions.stop('c1');
    expect(driver.ended).toEqual(['c1']);
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: false });
    calledOnceWith(cancelChat, 'c1');
    expect(stopped).toEqual([['c1', 'button']]);
    // Stop for a chat that has nothing still cancels its reply, and says nothing else.
    await sessions.stop('c7');
    expect(cancelChat).toHaveBeenLastCalledWith('c7');
    expect(events.filter((e) => e.type === 'computer-session' && e.chatId === 'c7')).toEqual([]);
    expect(stopped).toEqual([['c1', 'button']]);
  });

  it('still ends its own side and cancels the reply when the driver cannot be told', async () => {
    const { sessions, driver, events, cancelChat } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sessions.ensureSession('c1', 'One');
    vi.spyOn(driver, 'endSession').mockRejectedValue(new Error('the desktop app is gone'));
    await expect(sessions.stop('c1')).resolves.toBeUndefined();
    expect(sessions.activeChat()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: false });
    calledOnceWith(cancelChat, 'c1');
    expect(errors).toHaveBeenCalledTimes(1);
    // The port's own endSession says so, and leaves the end unconfirmed like Stop does.
    await expect(sessions.endSession('c1')).rejects.toThrow('the desktop app is gone');
    expect(sessions.activeChat()).toBeNull();
    // Nothing starts while the driver may still hold that session: no dialog, no session.
    expect(await sessions.ensureSession('c1', 'One')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    expect(driver.started).toHaveLength(1);
    expect(sessions.activeChat()).toBeNull();
  });
});

describe('ComputerSessions is the port, and adds nothing to what passes through', () => {
  it('hands act the very action and the whole expectation it was given, and returns the answer as it is', async () => {
    const { sessions, driver } = setup();
    await sessions.ensureSession('c1', 'One');
    const act = vi.spyOn(driver, 'act');
    const answer = await sessions.act('c1', CLICK, EXPECT);
    calledOnceWith(act, 'c1', CLICK, EXPECT);
    expect(act.mock.calls[0]![1]).toBe(CLICK);
    expect(act.mock.calls[0]![2]).toBe(EXPECT);
    expect(answer).toBe(driver.actAnswer);
    expect(driver.actions).toEqual([{ chatId: 'c1', action: CLICK, expect: { app: FAKE_COMPUTER_APP.path, shellView: false, windowId: 'hwnd-1', pid: 4242, startedAt: '2026-10-12T09:00:00.000Z' } }]);
  });

  it('never turns a refusal into a retry, and announces nothing for an action that was not carried out', async () => {
    const { sessions, driver, events } = setup();
    await sessions.ensureSession('c1', 'One');
    const act = vi.spyOn(driver, 'act');
    // The window is no longer the one the card was about.
    driver.pointTarget = fakeComputerTarget({ windowId: 'hwnd-2' });
    const refused = await sessions.act('c1', CLICK, EXPECT);
    expect(refused).toEqual({ ok: false, reason: 'The window changed after OtherBench asked, so nothing was done.' });
    expect(act).toHaveBeenCalledTimes(1);
    expect(driver.actions).toEqual([]);
    expect(driver.refused).toHaveLength(1);
    // A driver that throws is not asked again either.
    act.mockRejectedValueOnce(new Error('the desktop app went away'));
    await expect(sessions.act('c1', CLICK, EXPECT)).rejects.toThrow('the desktop app went away');
    expect(act).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ type: 'computer-session', chatId: 'c1', active: true }]);
    // And the session is still the chat's: a refusal ends nothing.
    expect(sessions.activeChat()).toBe('c1');
  });

  it('passes a target, a refusal to tell one, the cursor and a screenshot through untouched', async () => {
    const { sessions, driver } = setup();
    await sessions.ensureSession('c1', 'One');
    const odd = Object.freeze({ ...FAKE_COMPUTER_APP, path: 'C:\\Users\\Jos\u00e9\\App\\Tool.exe', title: '  A  title  ' });
    driver.pointTarget = odd;
    expect(await sessions.target('c1', { x: 3, y: 4 })).toBe(odd);
    const refusal = { refuse: 'OtherBench could not open that process.' };
    driver.foregroundTarget = refusal;
    expect(await sessions.target('c1', 'foreground')).toBe(refusal);
    expect(driver.targets).toEqual([
      { chatId: 'c1', at: { x: 3, y: 4 } },
      { chatId: 'c1', at: 'foreground' },
    ]);
    driver.cursor = { x: 7, y: 9 };
    expect(await sessions.cursorPosition('c1')).toEqual({ x: 7, y: 9 });
    const shot = await sessions.screenshot('c1');
    expect(shot).toEqual({ png: expect.any(Buffer), width: 1366, height: 768 });
    expect(driver.screenshots).toEqual(['c1']);
  });

  it("answers reservedKeys with the driver's own answer, null included, and available with the driver's", () => {
    const { sessions, driver } = setup();
    driver.reserved = null;
    expect(sessions.reservedKeys()).toBeNull();
    driver.reserved = [];
    expect(sessions.reservedKeys()).toBe(driver.reserved);
    driver.reserved = ['Ctrl+Shift+Space', 'F9'];
    expect(sessions.reservedKeys()).toBe(driver.reserved);
    expect(sessions.available()).toBe(true);
    driver.isAvailable = false;
    expect(sessions.available()).toBe(false);
  });

  it('with no session of its own for the chat, shows, tells and does nothing, and does not ask the driver', async () => {
    const { sessions, driver } = setup();
    const spies = [vi.spyOn(driver, 'act'), vi.spyOn(driver, 'target'), vi.spyOn(driver, 'screenshot'), vi.spyOn(driver, 'cursorPosition')];
    await sessions.ensureSession('c1', 'One');
    // Another chat, while c1 is in control.
    expect(await sessions.act('c2', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(await sessions.target('c2', 'foreground')).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
    await expect(sessions.screenshot('c2')).rejects.toThrow(COMPUTER_NO_SESSION_REASON);
    await expect(sessions.cursorPosition('c2')).rejects.toThrow(COMPUTER_NO_SESSION_REASON);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('one native dialog per chat', () => {
  it('shares one start between calls made at the same time, and announces the session once', async () => {
    const { sessions, driver, events } = setup();
    driver.dialogUp = true;
    const calls = [sessions.ensureSession('c1', 'One'), sessions.ensureSession('c1', 'One'), sessions.ensureSession('c1', 'One')];
    await tick();
    expect(driver.asked).toEqual(['c1']);
    // Not in control until the person says so.
    expect(sessions.activeChat()).toBeNull();
    expect(events).toEqual([]);
    driver.answer();
    expect(await Promise.all(calls)).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(driver.asked).toEqual(['c1']);
    expect(driver.started).toEqual([{ chatId: 'c1', chatTitle: 'One' }]);
    expect(events).toEqual([{ type: 'computer-session', chatId: 'c1', active: true }]);
  });

  it('shares a refusal between the calls that were waiting, and asks again for the next one', async () => {
    const { sessions, driver } = setup();
    driver.dialogUp = true;
    driver.startAnswer = { ok: false, reason: "The user didn't let OtherBench control the computer." };
    const calls = [sessions.ensureSession('c1', 'One'), sessions.ensureSession('c1', 'One')];
    await tick();
    driver.answer();
    expect(await Promise.all(calls)).toEqual([driver.startAnswer, driver.startAnswer]);
    expect(driver.asked).toEqual(['c1']);
    // Not cached: a later call is a new dialog.
    const again = sessions.ensureSession('c1', 'One');
    await tick();
    expect(driver.asked).toEqual(['c1', 'c1']);
    driver.startAnswer = { ok: true };
    driver.answer();
    expect(await again).toEqual({ ok: true });
  });

  it("refuses another chat while one chat's dialog is up, without a second dialog", async () => {
    const { sessions, driver } = setup();
    driver.dialogUp = true;
    const first = sessions.ensureSession('c1', 'One');
    await tick();
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: false, reason: COMPUTER_OTHER_CHAT_REASON });
    expect(driver.asked).toEqual(['c1']);
    driver.answer();
    expect(await first).toEqual({ ok: true });
  });

  it('is not left holding a start the driver threw on: the next call asks again', async () => {
    const { sessions, driver, events } = setup();
    const ensure = vi.spyOn(driver, 'ensureSession').mockRejectedValueOnce(new Error('the desktop app did not answer'));
    const end = vi.spyOn(driver, 'endSession');
    const both = [sessions.ensureSession('c1', 'One'), sessions.ensureSession('c1', 'One')];
    await expect(both[0]).rejects.toThrow('the desktop app did not answer');
    await expect(both[1]).rejects.toThrow('the desktop app did not answer');
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(sessions.activeChat()).toBeNull();
    expect(events).toEqual([]);
    // Whether a session came of it is unknown, so the driver is told to end one.
    calledOnceWith(end, 'c1');
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('forgets a session the driver no longer has, when the person refuses to start it again', async () => {
    const { sessions, driver, events, stopped, cancelChat } = setup();
    await sessions.ensureSession('c1', 'One');
    // The shell dropped the session without saying so (it should say; this is the fail-closed side).
    await driver.endSession('c1');
    driver.startAnswer = { ok: false, reason: "The user didn't let OtherBench control the computer." };
    expect(await sessions.ensureSession('c1', 'One')).toBe(driver.startAnswer);
    expect(sessions.activeChat()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: false });
    expect(stopped).toEqual([['c1', 'button']]);
    // The call that asked gets the refusal; its reply goes on.
    expect(cancelChat).not.toHaveBeenCalled();
  });
});

describe('a late OK on the start dialog', () => {
  it('ends the session it made when Stop came while the dialog was up, and nothing acts afterwards', async () => {
    const { sessions, driver, events, cancelChat, stopped } = setup();
    driver.dialogUp = true;
    const starting = sessions.ensureSession('c1', 'One');
    await tick();
    await sessions.stop('c1');
    calledOnceWith(cancelChat, 'c1');
    expect(stopped).toEqual([['c1', 'button']]);
    // The person says OK to a dialog nobody is waiting on any more.
    driver.answer();
    expect(await starting).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    expect(driver.started).toEqual([{ chatId: 'c1', chatTitle: 'One' }]);
    expect(driver.ended).toEqual(['c1']);
    expect(driver.hasSession('c1')).toBe(false);
    expect(sessions.activeChat()).toBeNull();
    // It was never announced as in control.
    expect(events).toEqual([]);
    // The call that was waiting on the dialog can't act: the driver is not even asked.
    const act = vi.spyOn(driver, 'act');
    expect(await sessions.act('c1', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(act).not.toHaveBeenCalled();
    // The computer is free again.
    driver.dialogUp = false;
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
  });

  it('ends the session it made when the reply ended while the dialog was up', async () => {
    const { sessions, driver, events, cancelChat } = setup();
    driver.dialogUp = true;
    const starting = sessions.ensureSession('c1', 'One');
    await tick();
    sessions.replyEnded('c1');
    driver.answer();
    expect(await starting).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    expect(driver.ended).toEqual(['c1']);
    expect(driver.hasSession('c1')).toBe(false);
    expect(sessions.activeChat()).toBeNull();
    expect(events).toEqual([]);
    // The reply is already over: there is nothing to cancel.
    expect(cancelChat).not.toHaveBeenCalled();
  });

  it('ends the session it made when the shell said stopped while the dialog was up', async () => {
    const { sessions, driver, cancelChat } = setup();
    driver.dialogUp = true;
    const starting = sessions.ensureSession('c1', 'One');
    await tick();
    driver.stop('c1', 'quit');
    calledOnceWith(cancelChat, 'c1');
    driver.answer();
    expect(await starting).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    expect(driver.hasSession('c1')).toBe(false);
    expect(sessions.activeChat()).toBeNull();
  });

  it('passes a late No on as it is', async () => {
    const { sessions, driver } = setup();
    driver.dialogUp = true;
    driver.startAnswer = { ok: false, reason: "The user didn't let OtherBench control the computer." };
    const starting = sessions.ensureSession('c1', 'One');
    await tick();
    await sessions.stop('c1');
    driver.answer();
    expect(await starting).toBe(driver.startAnswer);
    expect(driver.ended).toEqual([]);
  });

  it('ends a session that was started and never used once its chat has no reply, and keeps one that was used', async () => {
    const { sessions, driver, events, stopped, cancelChat } = setup();
    // The dialog was answered after the reply had been stopped: the tool does nothing with the session.
    await sessions.ensureSession('c1', 'One');
    sessions.replyEnded('c1');
    expect(driver.ended).toEqual(['c1']);
    expect(sessions.activeChat()).toBeNull();
    expect(events).toEqual([
      { type: 'computer-session', chatId: 'c1', active: true },
      { type: 'computer-session', chatId: 'c1', active: false },
    ]);
    expect(stopped).toEqual([['c1', 'button']]);
    expect(cancelChat).not.toHaveBeenCalled();

    // A session that has been used stays for the chat's next reply (Stop, idle or quit ends it).
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    sessions.replyEnded('c1');
    sessions.replyEnded('c2');
    expect(sessions.activeChat()).toBe('c1');
    expect(driver.ended).toEqual(['c1']);
  });
});

describe('Stop is absolute', () => {
  it('lets nothing more reach the driver for that session', async () => {
    const { sessions, driver } = setup();
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    expect(await sessions.act('c1', CLICK, EXPECT)).toEqual({ ok: true });
    await sessions.stop('c1');
    const spies = [vi.spyOn(driver, 'act'), vi.spyOn(driver, 'target'), vi.spyOn(driver, 'screenshot'), vi.spyOn(driver, 'cursorPosition')];
    expect(await sessions.act('c1', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(await sessions.act('c1', action({ action: 'type', text: 'hello' }), EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(await sessions.target('c1', { x: 1, y: 1 })).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
    await expect(sessions.screenshot('c1')).rejects.toThrow(COMPUTER_NO_SESSION_REASON);
    await expect(sessions.cursorPosition('c1')).rejects.toThrow(COMPUTER_NO_SESSION_REASON);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(driver.actions).toHaveLength(1);
    expect(driver.refused).toEqual([]);
  });

  it('is in force before the driver has answered the stop: an act made in the same moment does not reach it', async () => {
    const { sessions, driver } = setup();
    await sessions.ensureSession('c1', 'One');
    let release: () => void = () => {};
    const end = vi.spyOn(driver, 'endSession').mockImplementation(async () => {
      await new Promise<void>((resolve) => (release = resolve));
    });
    const act = vi.spyOn(driver, 'act');
    const stopping = sessions.stop('c1');
    // The driver was told at once, and has not answered yet.
    calledOnceWith(end, 'c1');
    expect(await sessions.act('c1', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(act).not.toHaveBeenCalled();
    release();
    await stopping;
  });

  it("releases what the driver pressed through the driver's own end of session, and touches no key the person holds", async () => {
    const { sessions, driver } = setup();
    await sessions.ensureSession('c1', 'One');
    const seen: { during: string[]; afterStop: string[]; heldAfterStop: string[] } = { during: [], afterStop: [], heldAfterStop: [] };
    let stopping: Promise<void> = Promise.resolve();
    driver.midAction = (down) => {
      seen.during = [...down];
      // Half-way through the key action: the driver has ctrl and shift down, the person leans on alt, and Stop comes.
      driver.held = ['alt'];
      stopping = sessions.stop('c1');
      seen.afterStop = [...driver.pressed];
      seen.heldAfterStop = [...driver.held];
    };
    await sessions.act('c1', action({ action: 'key', text: 'ctrl+shift+s' }), EXPECT);
    await stopping;
    expect(seen.during).toEqual(['ctrl', 'shift']);
    expect(seen.afterStop).toEqual([]);
    expect(seen.heldAfterStop).toEqual(['alt']);
    expect(driver.pressed).toEqual([]);
    expect(driver.held).toEqual(['alt']);
    expect(driver.ended).toEqual(['c1']);
    // And the next action is not sent at all.
    driver.midAction = null;
    const act = vi.spyOn(driver, 'act');
    expect(await sessions.act('c1', action({ action: 'key', text: 'ctrl+s' }), EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(act).not.toHaveBeenCalled();
    expect(driver.held).toEqual(['alt']);
  });

  it('announces nothing for an action that was still in the driver when the session ended', async () => {
    const { sessions, driver, events } = setup();
    await sessions.ensureSession('c1', 'One');
    driver.midAction = () => void sessions.stop('c1');
    await sessions.act('c1', CLICK, EXPECT);
    await tick();
    expect(events).toEqual([
      { type: 'computer-session', chatId: 'c1', active: true },
      { type: 'computer-session', chatId: 'c1', active: false },
    ]);
    // Nor for one that comes back after the same chat has started a new session.
    driver.midAction = null;
    let finish: (answer: ComputerAnswer) => void = () => {};
    vi.spyOn(driver, 'act').mockImplementationOnce(() => new Promise<ComputerAnswer>((resolve) => (finish = resolve)));
    await sessions.ensureSession('c1', 'One');
    const slow = sessions.act('c1', CLICK, EXPECT);
    await sessions.stop('c1');
    await sessions.ensureSession('c1', 'One');
    finish({ ok: true });
    await slow;
    expect(events.filter((e) => e.type === 'computer-session' && e.lastAction !== undefined)).toEqual([]);
  });
});

describe('when the server ends a session itself', () => {
  it('tells its stopped listeners for stop, endSession and shutdown, and not once they have unsubscribed', async () => {
    const driver = new DialogDriver();
    const sessions = new ComputerSessions(driver, { emit: () => {}, cancelChat: () => {} });
    const heard: [string, ComputerStopReason][] = [];
    const off = sessions.onStopped((chatId, why) => heard.push([chatId, why]));
    const other = vi.fn(() => {
      throw new Error('a listener that fails');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sessions.onStopped(other);

    await sessions.ensureSession('c1', 'One');
    await sessions.stop('c1');
    await sessions.ensureSession('c2', 'Two');
    await sessions.endSession('c2');
    await sessions.ensureSession('c3', 'Three');
    sessions.dispose();
    expect(heard).toEqual([
      ['c1', 'button'],
      ['c2', 'button'],
      ['c3', 'quit'],
    ]);
    // One listener failing does not stop the other hearing.
    expect(other).toHaveBeenCalledTimes(3);
    expect(driver.ended).toEqual(['c1', 'c2', 'c3']);

    off();
    const again = new ComputerSessions(driver, { emit: () => {}, cancelChat: () => {} });
    const quiet = vi.fn();
    again.onStopped(quiet)();
    await again.ensureSession('c4', 'Four');
    await again.stop('c4');
    expect(quiet).not.toHaveBeenCalled();
  });

  it('shutdown ends the session on the driver, stops listening to it, and starts nothing afterwards', async () => {
    const { sessions, driver, events, cancelChat } = setup();
    await sessions.ensureSession('c1', 'One');
    sessions.dispose();
    expect(driver.ended).toEqual(['c1']);
    expect(driver.hasSession('c1')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: false });
    expect(sessions.activeChat()).toBeNull();
    const before = events.length;
    driver.stop('c1', 'quit');
    expect(events).toHaveLength(before);
    expect(cancelChat).not.toHaveBeenCalled();
    const asked = driver.asked.length;
    expect((await sessions.ensureSession('c1', 'One')).ok).toBe(false);
    expect(driver.asked).toHaveLength(asked);
  });

  it('shutdown while the dialog is up ends the session a late OK makes', async () => {
    const { sessions, driver } = setup();
    driver.dialogUp = true;
    const starting = sessions.ensureSession('c1', 'One');
    await tick();
    sessions.dispose();
    driver.answer();
    expect((await starting).ok).toBe(false);
    expect(driver.hasSession('c1')).toBe(false);
  });

  it("makes the computer tool forget the chat's last screenshot, so a point from before the stop is refused", async () => {
    const store = new InMemoryStore();
    store.chats.create({ id: 'chat-1', title: 'Budget', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const driver = new DialogDriver();
    const sessions = new ComputerSessions(driver, { emit: () => {}, cancelChat: () => {} });
    // The provider is given the sessions, not the driver: that is what wires the tool's stopped hook to them.
    const provider = new OtherBenchToolProvider(store, new PermissionBroker(store), { listFor: () => [], refresh: async () => {}, shutdown: async () => {} } as never, { computer: sessions });
    const policy = { fs: 'off' as const, shell: false, mcpServerIds: [], approvalMode: 'always_ask' as const, computer: true, artifacts: false, recall: false };
    const tool = (await provider.listTools(policy)).find((t) => t.name === 'computer')!;
    const abort = new AbortController();
    const ctx = { chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: abort.signal };

    await tool.execute({ action: 'screenshot' }, ctx);
    // With the screenshot remembered, a click gets as far as asking what is under the point (and then waits on its card).
    const waiting = tool.execute({ action: 'left_click', coordinate: [10, 20] }, ctx);
    await vi.waitFor(() => expect(driver.targets).toHaveLength(1));
    abort.abort();
    await waiting;

    await sessions.stop('chat-1');
    const after = (await tool.execute({ action: 'left_click', coordinate: [10, 20] }, { ...ctx, signal: new AbortController().signal })) as { error: boolean; message: string };
    expect(after).toMatchObject({ error: true });
    expect(after.message).toContain(COMPUTER_NO_SCREENSHOT_REASON);
    // Refused before any new session was asked for.
    expect(driver.asked).toEqual(['chat-1', 'chat-1']);
    expect(driver.targets).toHaveLength(1);
  });
});

describe('typed text never leaves the action', () => {
  it('is in no event, no hello and no log line', async () => {
    const SECRET = 'hunter2-CorrectHorseBatteryStaple';
    const logged: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const bus = new AppEventBus();
    const seen: AppEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const driver = new DialogDriver();
    const sessions = new ComputerSessions(driver, { emit: (e) => bus.emit(e), cancelChat: () => {} });
    await sessions.ensureSession('c1', `Notes ${SECRET.length}`);

    const typed = action({ action: 'type', text: `${SECRET}\nsecond line` });
    expect(await sessions.act('c1', typed, EXPECT)).toEqual({ ok: true });
    // Carried out with the text...
    expect(driver.actions[0]!.action).toEqual({ action: 'type', text: `${SECRET}\nsecond line` });
    // ...and summarised without it.
    expect(seen.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: true, lastAction: `type ${SECRET.length + 12} characters (2 lines)` });
    expect(seen.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: true, lastAction: actionSummary(typed) });
    expect(bus.computerSessions()).toEqual([{ chatId: 'c1', lastAction: actionSummary(typed) }]);

    // The same when the driver refuses or throws while typing, and when the session then ends.
    driver.foregroundTarget = fakeComputerTarget({ windowId: 'hwnd-9' });
    await sessions.act('c1', typed, EXPECT);
    vi.spyOn(driver, 'act').mockRejectedValueOnce(new Error('the desktop app went away'));
    await sessions.act('c1', typed, EXPECT).catch(() => {});
    vi.spyOn(driver, 'endSession').mockRejectedValueOnce(new Error('the desktop app went away'));
    await sessions.stop('c1');
    sessions.dispose();

    const everything = JSON.stringify({ seen, hello: bus.computerSessions(), logged: logged.map((args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : a))) });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('second line');
    // The event carries exactly these fields and no others.
    for (const e of seen) expect(Object.keys(e).filter((k) => !['type', 'chatId', 'active', 'lastAction'].includes(k))).toEqual([]);
  });

  it('summarises only the action it was handed: nothing the driver says about the app is added', async () => {
    const { sessions, driver, events } = setup();
    await sessions.ensureSession('c1', 'One');
    const odd = fakeComputerTarget({ path: 'C:\\Apps\\Evil Name.exe', title: 'TITLE-FROM-THE-APP' });
    driver.pointTarget = odd;
    await sessions.target('c1', { x: 10, y: 10 });
    await sessions.act('c1', CLICK, expectFor({ path: odd.path }));
    const text = JSON.stringify(events);
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: true, lastAction: 'click at 10, 10' });
    expect(text).not.toContain('Evil Name');
    expect(text).not.toContain('TITLE-FROM-THE-APP');
  });
});

describe('an end the driver could not confirm', () => {
  /** The driver's `endSession` fails `times` times (always, when left out), then works again. */
  function failingEnd(driver: DialogDriver, times?: number) {
    const real = driver.endSession.bind(driver);
    let left = times ?? Number.POSITIVE_INFINITY;
    return vi.spyOn(driver, 'endSession').mockImplementation(async (chatId: string) => {
      if (left > 0) {
        left -= 1;
        throw new Error('the desktop app did not answer');
      }
      return real(chatId);
    });
  }

  it('after Stop: the chat does not restart without a new native dialog', async () => {
    const { sessions, driver, cancelChat } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    const end = failingEnd(driver, 1);
    await sessions.stop('c1');
    calledOnceWith(cancelChat, 'c1');
    // The shell still holds the session the server has stopped.
    expect(driver.hasSession('c1')).toBe(true);
    expect(driver.started).toHaveLength(1);

    // The next start ends it first (this time the driver answers), and only then asks: a new dialog.
    expect(await sessions.ensureSession('c1', 'One')).toEqual({ ok: true });
    expect(end).toHaveBeenCalledTimes(2);
    expect(driver.ended).toEqual(['c1']);
    expect(driver.started).toHaveLength(2);
    expect(driver.asked).toEqual(['c1', 'c1']);
  });

  it('refuses every start, for any chat, while the end stays unconfirmed, and lets nothing reach the driver', async () => {
    const { sessions, driver, events } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    const end = failingEnd(driver);
    await sessions.stop('c1');
    const spies = [vi.spyOn(driver, 'act'), vi.spyOn(driver, 'target'), vi.spyOn(driver, 'screenshot'), vi.spyOn(driver, 'cursorPosition')];

    for (const chatId of ['c1', 'c2', 'c1']) {
      expect(await sessions.ensureSession(chatId, 'Any')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
      expect(await sessions.act(chatId, CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
      expect(await sessions.target(chatId, 'foreground')).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
      await expect(sessions.screenshot(chatId)).rejects.toThrow(COMPUTER_NO_SESSION_REASON);
      await expect(sessions.cursorPosition(chatId)).rejects.toThrow(COMPUTER_NO_SESSION_REASON);
    }
    // The driver was never asked to start anything, and nothing was done; each refused start tried the end again.
    expect(driver.asked).toEqual(['c1']);
    expect(driver.started).toHaveLength(1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(4);
    expect(sessions.activeChat()).toBeNull();
    expect(events.filter((e) => e.type === 'computer-session' && e.active)).toHaveLength(1);

    // Once the driver confirms, another chat starts, with its own dialog.
    end.mockRestore();
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
    expect(driver.ended).toEqual(['c1']);
    expect(driver.started.map((s) => s.chatId)).toEqual(['c1', 'c2']);
  });

  it('after a session was ended for want of a reply: the same', async () => {
    const { sessions, driver } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await sessions.ensureSession('c1', 'One');
    const end = failingEnd(driver);
    sessions.replyEnded('c1');
    await tick();
    expect(sessions.activeChat()).toBeNull();
    expect(driver.hasSession('c1')).toBe(true);
    expect(await sessions.ensureSession('c1', 'One')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    expect(driver.started).toHaveLength(1);
    end.mockRestore();
    expect(await sessions.ensureSession('c1', 'One')).toEqual({ ok: true });
    expect(driver.started).toHaveLength(2);
  });

  it('after a late OK was ended: the same', async () => {
    const { sessions, driver } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    driver.dialogUp = true;
    const starting = sessions.ensureSession('c1', 'One');
    await tick();
    await sessions.stop('c1');
    // From here the driver can't be told to end anything; then the person says OK to the old dialog.
    const end = failingEnd(driver);
    driver.answer();
    expect(await starting).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    expect(driver.hasSession('c1')).toBe(true);
    driver.dialogUp = false;
    for (const chatId of ['c1', 'c2']) {
      expect(await sessions.ensureSession(chatId, 'Any')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    }
    expect(driver.started).toHaveLength(1);
    expect(await sessions.act('c1', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(driver.actions).toEqual([]);
    end.mockRestore();
    expect(await sessions.ensureSession('c1', 'One')).toEqual({ ok: true });
    expect(driver.started).toHaveLength(2);
  });

  it('after a start the driver threw on: the same', async () => {
    const { sessions, driver } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(driver, 'ensureSession').mockRejectedValueOnce(new Error('the desktop app did not answer'));
    const end = failingEnd(driver);
    await expect(sessions.ensureSession('c1', 'One')).rejects.toThrow('the desktop app did not answer');
    await tick();
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    end.mockRestore();
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
  });

  it('a driver that never answers the end does not hang Stop: the reply is cancelled at once and the end counts as unconfirmed', async () => {
    const { sessions, driver, cancelChat, events } = setup(new DialogDriver(), { endTimeoutMs: 30 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sessions.ensureSession('c1', 'One');
    const hung = vi.spyOn(driver, 'endSession').mockImplementation(() => new Promise<void>(() => {}));
    const before = Date.now();
    const stopping = sessions.stop('c1');
    // Before the driver has said anything: the record is cleared, the banner is off and the reply is cancelled.
    expect(sessions.activeChat()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: false });
    calledOnceWith(cancelChat, 'c1');
    await stopping;
    expect(Date.now() - before).toBeLessThan(2000);
    expect(errors).toHaveBeenCalledTimes(1);
    // Unconfirmed: nothing starts (the retry is bounded too).
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    expect(driver.asked).toEqual(['c1']);
    hung.mockRestore();
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
    expect(driver.ended).toEqual(['c1']);
  });

  it("takes the shell's own word that the session is over", async () => {
    const { sessions, driver } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await sessions.ensureSession('c1', 'One');
    const end = failingEnd(driver);
    await sessions.stop('c1');
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    // The shell ends it itself (its idle limit, say) and says so; the server can still not get an end through.
    driver.stop('c1', 'idle');
    end.mockClear();
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
    expect(end).not.toHaveBeenCalled();
    expect(driver.started.map((s) => s.chatId)).toEqual(['c1', 'c2']);
  });

  it('waits for an end the driver has not answered yet before it asks for a start', async () => {
    const { sessions, driver } = setup();
    await sessions.ensureSession('c1', 'One');
    const real = driver.endSession.bind(driver);
    let finish: () => void = () => {};
    vi.spyOn(driver, 'endSession').mockImplementationOnce(async (chatId: string) => {
      await new Promise<void>((resolve) => (finish = resolve));
      return real(chatId);
    });
    const stopping = sessions.stop('c1');
    const next = sessions.ensureSession('c2', 'Two');
    await tick();
    // The driver is still ending c1: it has not been asked about c2.
    expect(driver.asked).toEqual(['c1']);
    finish();
    await stopping;
    expect(await next).toEqual({ ok: true });
    expect(driver.asked).toEqual(['c1', 'c2']);
    expect(driver.ended).toEqual(['c1']);
  });
});

describe('Stop racing a start of the same chat', () => {
  it('a session being checked again when Stop comes is not brought back by the driver saying it is fine', async () => {
    const { sessions, driver, events, cancelChat } = setup();
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    // The tool's next call checks the session again; the driver is slow to answer.
    driver.dialogUp = true;
    const again = sessions.ensureSession('c1', 'One');
    await tick();
    expect(driver.asked).toEqual(['c1', 'c1']);
    // Stop lands first; the fake ends its session.
    await sessions.stop('c1');
    calledOnceWith(cancelChat, 'c1');
    expect(driver.hasSession('c1')).toBe(false);
    // Then the driver answers the check with OK, as a shell would that took the check for a new start: a live session again.
    driver.answer();
    expect(await again).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    // Whatever the driver made of it is ended, and the server never showed it as in control again.
    expect(driver.started).toHaveLength(2);
    expect(driver.ended).toEqual(['c1', 'c1']);
    expect(driver.hasSession('c1')).toBe(false);
    expect(sessions.activeChat()).toBeNull();
    expect(events.filter((e) => e.type === 'computer-session').map((e) => (e as { active: boolean }).active)).toEqual([true, false]);
    expect(await sessions.act('c1', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
  });

  it('a start made in the same moment as Stop is a new session with a new dialog, asked for after the end', async () => {
    const { sessions, driver, events } = setup();
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    const order: string[] = [];
    const realEnd = driver.endSession.bind(driver);
    vi.spyOn(driver, 'endSession').mockImplementation(async (chatId: string) => {
      order.push('end:called');
      await tick();
      await realEnd(chatId);
      order.push('end:done');
    });
    const realEnsure = driver.ensureSession.bind(driver);
    vi.spyOn(driver, 'ensureSession').mockImplementation(async (chatId: string, chatTitle: string) => {
      order.push('ensure:called');
      return realEnsure(chatId, chatTitle);
    });
    const stopping = sessions.stop('c1');
    const restart = sessions.ensureSession('c1', 'One');
    await stopping;
    expect(await restart).toEqual({ ok: true });
    expect(order).toEqual(['end:called', 'end:done', 'ensure:called']);
    // The old session was ended and a dialog was shown for the new one.
    expect(driver.ended).toEqual(['c1']);
    expect(driver.started).toHaveLength(2);
    expect(events.filter((e) => e.type === 'computer-session').map((e) => (e as { active: boolean }).active)).toEqual([true, false, true]);
  });

  it('a start that was stopped before the driver was even asked shows no dialog', async () => {
    const { sessions, driver } = setup();
    await sessions.ensureSession('c1', 'One');
    const realEnd = driver.endSession.bind(driver);
    vi.spyOn(driver, 'endSession').mockImplementation(async (chatId: string) => {
      await tick();
      return realEnd(chatId);
    });
    void sessions.stop('c1');
    // Waiting for that end to be confirmed, the new start is stopped too.
    const restart = sessions.ensureSession('c1', 'One');
    const stopping = sessions.stop('c1');
    expect(await restart).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    await stopping;
    expect(driver.asked).toEqual(['c1']);
    expect(driver.started).toHaveLength(1);
  });
});

describe('stops that are not about the chat in control', () => {
  it("a stop from the shell for a chat the server has no record of still cancels that chat's replies", () => {
    const { driver, cancelChat, stopped, events } = setup();
    // A late OK after a start that timed out: the shell has a session the server never heard of, and the person stops it.
    driver.stop('c5', 'hotkey');
    calledOnceWith(cancelChat, 'c5');
    expect(stopped).toEqual([['c5', 'hotkey']]);
    expect(events).toEqual([]);
  });

  it("stopping another chat does not end the holder's session on the driver or release its keys", async () => {
    const { sessions, driver, cancelChat } = setup();
    await sessions.ensureSession('c1', 'One');
    const end = vi.spyOn(driver, 'endSession');
    let pressedAfterOtherStop: string[] = [];
    let stops: Promise<void>[] = [];
    driver.midAction = () => {
      // c1 is half-way through ctrl+shift+s when someone stops (and someone else ends) a chat that is not in control.
      stops = [sessions.stop('c2'), sessions.endSession('c3')];
      pressedAfterOtherStop = [...driver.pressed];
    };
    expect(await sessions.act('c1', action({ action: 'key', text: 'ctrl+shift+s' }), EXPECT)).toEqual({ ok: true });
    await Promise.all(stops);
    expect(pressedAfterOtherStop).toEqual(['ctrl', 'shift']);
    expect(end).not.toHaveBeenCalled();
    expect(sessions.activeChat()).toBe('c1');
    expect(driver.hasSession('c1')).toBe(true);
    // The other chat's reply is still cancelled by its Stop.
    calledOnceWith(cancelChat, 'c2');
    // The same while a dialog is up for c4 after c1 has gone.
    driver.midAction = null;
    await sessions.stop('c1');
    end.mockClear();
    driver.dialogUp = true;
    const starting = sessions.ensureSession('c4', 'Four');
    await tick();
    await sessions.stop('c2');
    expect(end).not.toHaveBeenCalled();
    driver.answer();
    expect(await starting).toEqual({ ok: true });
    // Stopping the holder tells the driver every time.
    await sessions.stop('c4');
    await sessions.stop('c4');
    expect(end.mock.calls).toEqual([['c4'], ['c4']]);
  });
});

describe('a chat that is gone', () => {
  it('endIfChatGone ends the session of a holder whose chat no longer exists, cancels its reply and frees the computer', async () => {
    const chats = new Set(['c1', 'c2']);
    const { sessions, driver, events, cancelChat, stopped } = setup(new DialogDriver(), { chatExists: (id) => chats.has(id) });
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    await sessions.endIfChatGone();
    expect(sessions.activeChat()).toBe('c1');
    expect(cancelChat).not.toHaveBeenCalled();

    chats.delete('c1');
    await sessions.endIfChatGone();
    expect(driver.ended).toEqual(['c1']);
    expect(sessions.activeChat()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: false });
    calledOnceWith(cancelChat, 'c1');
    expect(stopped).toEqual([['c1', 'button']]);
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
    expect(driver.started.map((s) => s.chatId)).toEqual(['c1', 'c2']);
    // With nothing to tell it whether a chat exists, it ends nothing.
    const plain = setup();
    await plain.sessions.ensureSession('c1', 'One');
    await plain.sessions.endIfChatGone();
    expect(plain.sessions.activeChat()).toBe('c1');
  });

  it('a holder whose chat is gone is ended before anything else is started or done, even when nobody said so', async () => {
    const chats = new Set(['c1', 'c2']);
    const { sessions, driver, cancelChat } = setup(new DialogDriver(), { chatExists: (id) => chats.has(id) });
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    chats.delete('c1');
    const spies = [vi.spyOn(driver, 'act'), vi.spyOn(driver, 'target'), vi.spyOn(driver, 'screenshot'), vi.spyOn(driver, 'cursorPosition')];
    // Its own next action is not sent...
    expect(await sessions.act('c1', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(sessions.activeChat()).toBeNull();
    calledOnceWith(cancelChat, 'c1');
    await tick();
    expect(driver.ended).toEqual(['c1']);

    // ...and with the other calls it is the same.
    for (const call of [() => sessions.target('c3', 'foreground'), () => sessions.screenshot('c3').catch(() => null), () => sessions.cursorPosition('c3').catch(() => null)]) {
      chats.add('c3');
      await sessions.ensureSession('c3', 'Three');
      chats.delete('c3');
      await call();
      expect(sessions.activeChat()).toBeNull();
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();

    // Another chat's start ends a gone holder first, and gets a dialog of its own.
    chats.add('c4');
    await sessions.ensureSession('c4', 'Four');
    await sessions.screenshot('c4');
    chats.delete('c4');
    const started = driver.started.length;
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
    expect(driver.ended.at(-1)).toBe('c4');
    expect(driver.hasSession('c4')).toBe(false);
    expect(driver.started.slice(started)).toEqual([{ chatId: 'c2', chatTitle: 'Two' }]);
    expect(sessions.activeChat()).toBe('c2');
  });

  it('a dialog still up for a chat that is gone makes no session when it is answered', async () => {
    const chats = new Set(['c1']);
    const { sessions, driver, cancelChat } = setup(new DialogDriver(), { chatExists: (id) => chats.has(id) });
    driver.dialogUp = true;
    const starting = sessions.ensureSession('c1', 'One');
    await tick();
    chats.delete('c1');
    await sessions.endIfChatGone();
    calledOnceWith(cancelChat, 'c1');
    driver.answer();
    expect(await starting).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    expect(driver.hasSession('c1')).toBe(false);
  });

  it('a check that throws ends nothing', async () => {
    const { sessions } = setup(new DialogDriver(), {
      chatExists: () => {
        throw new Error('the database is closed');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sessions.ensureSession('c1', 'One')).toEqual({ ok: true });
    await sessions.endIfChatGone();
    expect(sessions.activeChat()).toBe('c1');
  });
});

describe('available()', () => {
  it('is false, not a throw, when the driver cannot say', () => {
    const { sessions, driver } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(driver, 'available').mockImplementation(() => {
      throw new Error('the desktop app is gone');
    });
    expect(sessions.available()).toBe(false);
  });
});

describe('AppEventBus and computer sessions', () => {
  it('remembers the chats in control, with their last action, for a late subscriber', () => {
    const bus = new AppEventBus();
    expect(bus.computerSessions()).toEqual([]);
    bus.emit({ type: 'computer-session', chatId: 'c1', active: true });
    expect(bus.computerSessions()).toEqual([{ chatId: 'c1' }]);
    bus.emit({ type: 'computer-session', chatId: 'c1', active: true, lastAction: 'click at 1, 2' });
    // A plain "still in control" does not wipe the last action.
    bus.emit({ type: 'computer-session', chatId: 'c1', active: true });
    expect(bus.computerSessions()).toEqual([{ chatId: 'c1', lastAction: 'click at 1, 2' }]);
    bus.emit({ type: 'computer-session', chatId: 'c1', active: false });
    expect(bus.computerSessions()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The reply is stopped while the native dialog is up, then the person says OK.
// The runner, the provider, the broker, the tool, the bus and the sessions are
// the real ones; the driver is the fake and the engine a stand-in that calls
// the tool the way an engine does.

function profile(): ResolvedProfile {
  return {
    id: 'profile-1', name: 'P', description: null, colour: null, connectionId: 'conn-1', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', computer: true, artifacts: false, recall: false }, isDefault: false, archivedAt: null,
    connection: { id: 'conn-1', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null },
    apiKey: null, model: null,
  };
}

/** An engine whose model asks for a screenshot. `waitsForTheTool`: the stream only ends when the tool call does (as the AI SDK's does); otherwise it ends as soon as the reply is stopped. */
function screenshotEngine(waitsForTheTool: boolean): ChatEngine {
  return {
    async *stream(req) {
      const tool = req.tools.find((t) => t.name === 'computer')!;
      const call = tool.execute({ action: 'screenshot' }, { chatId: req.chatId, messageId: req.messageId, profileId: req.profile.id, workspaceRoot: null, signal: req.signal });
      const stopped = new Promise<'stopped'>((resolve) => req.signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
      const result = waitsForTheTool ? await call : await Promise.race([call, stopped]);
      if (result === 'stopped') return;
      yield { type: 'tool-result', id: 'call-1', name: 'computer', result, isError: false };
    },
    listModels: async () => [],
    testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
  };
}

describe.each([
  ['the reply ends only when the tool call does', true],
  ['the reply ends at once', false],
])('a late OK after the reply was stopped (%s)', (_name, waitsForTheTool) => {
  it('does not leave a session with no reply', async () => {
    const store = new InMemoryStore();
    store.chats.create({ id: 'chat-1', title: 'Budget', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const bus = new AppEventBus();
    const driver = new DialogDriver();
    driver.dialogUp = true;
    // Read lazily: the runner is made after the sessions, as in the container.
    const holder: { runner?: TurnRunner } = {};
    const sessions = new ComputerSessions(driver, { emit: (e) => bus.emit(e), cancelChat: (chatId) => cancelChatReplies(bus, holder.runner!, chatId) });
    const provider = new OtherBenchToolProvider(store, new PermissionBroker(store), { listFor: () => [], refresh: async () => {}, shutdown: async () => {} } as never, { computer: sessions });
    const runner = new TurnRunner(store, screenshotEngine(waitsForTheTool), { toolProvider: provider });
    holder.runner = runner;
    bus.attach(runner, store);
    endSessionsLeftWithoutAReply(bus, sessions);
    const seen: AppEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const { assistantMessageIds } = await runner.run({ chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'look' }], profiles: [profile()] });
    bus.emit({ type: 'turn-started', chatId: 'chat-1', messageIds: assistantMessageIds });
    const replyId = assistantMessageIds[0]!;
    // The native dialog is up for the model's first look.
    await vi.waitFor(() => expect(driver.asked).toEqual(['chat-1']));

    // The person stops the reply (the reply's own Stop, not the computer's), then says OK to the dialog.
    runner.cancel(replyId);
    if (!waitsForTheTool) await vi.waitFor(() => expect(store.messages.get(replyId)?.status).toBe('cancelled'));
    driver.answer();

    await vi.waitFor(() => expect(store.messages.get(replyId)?.status).toBe('cancelled'));
    await vi.waitFor(() => expect(driver.ended).toEqual(['chat-1']));
    expect(driver.started).toEqual([{ chatId: 'chat-1', chatTitle: 'Budget' }]);
    expect(driver.hasSession('chat-1')).toBe(false);
    expect(sessions.activeChat()).toBeNull();
    expect(bus.computerSessions()).toEqual([]);
    // Nothing was looked at and nothing was done.
    expect(driver.screenshots).toEqual([]);
    expect(driver.actions).toEqual([]);
    // Whatever was announced ended with "not in control".
    const session = seen.filter((e) => e.type === 'computer-session');
    if (session.length > 0) expect(session.at(-1)).toEqual({ type: 'computer-session', chatId: 'chat-1', active: false });
  });
});

describe('endSessionsLeftWithoutAReply', () => {
  it('waits for the last reply of the chat, and leaves other chats alone', async () => {
    const bus = new AppEventBus();
    const driver = new DialogDriver();
    const sessions = new ComputerSessions(driver, { emit: (e) => bus.emit(e), cancelChat: () => {} });
    const off = endSessionsLeftWithoutAReply(bus, sessions);
    await sessions.ensureSession('c1', 'One');
    bus.emit({ type: 'turn-started', chatId: 'c1', messageIds: ['m1', 'm2'] });
    bus.emit({ type: 'turn-finished', chatId: 'c2', messageId: 'x', status: 'cancelled' });
    bus.emit({ type: 'turn-finished', chatId: 'c1', messageId: 'm1', status: 'cancelled' });
    // Another reply of the chat is still running (a compare variant): the session may be its.
    expect(sessions.activeChat()).toBe('c1');
    bus.emit({ type: 'turn-finished', chatId: 'c1', messageId: 'm2', status: 'complete' });
    expect(sessions.activeChat()).toBeNull();
    expect(driver.ended).toEqual(['c1']);

    off();
    await sessions.ensureSession('c1', 'One');
    bus.emit({ type: 'turn-finished', chatId: 'c1', messageId: 'm3', status: 'cancelled' });
    expect(sessions.activeChat()).toBe('c1');
  });
});

describe('cancelChatReplies', () => {
  it("cancels each reply the bus says is running in that chat, and no other chat's", () => {
    const bus = new AppEventBus();
    bus.emit({ type: 'turn-started', chatId: 'c1', messageIds: ['m1', 'm2'] });
    bus.emit({ type: 'turn-started', chatId: 'c2', messageIds: ['m3'] });
    const cancel = vi.fn();
    cancelChatReplies(bus, { cancel }, 'c1');
    expect(cancel.mock.calls).toEqual([['m1'], ['m2']]);
  });
});

describe('while an earlier end is still being confirmed', () => {
  /** The driver's `endSession` waits until the test lets it go, then fails or succeeds as told. */
  function heldEnd(driver: DialogDriver) {
    const real = driver.endSession.bind(driver);
    const waiting: ((ok: boolean) => void)[] = [];
    const spy = vi.spyOn(driver, 'endSession').mockImplementation(async (chatId: string) => {
      const ok = await new Promise<boolean>((resolve) => waiting.push(resolve));
      if (!ok) throw new Error('the desktop app did not answer');
      return real(chatId);
    });
    return { spy, release: (ok: boolean) => waiting.splice(0).forEach((resolve) => resolve(ok)), held: () => waiting.length };
  }

  it('tries the ends it could not confirm one at a time and stops at the first that still fails', async () => {
    const { sessions, driver } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await sessions.ensureSession('c1', 'One');
    const end = vi.spyOn(driver, 'endSession').mockRejectedValue(new Error('the desktop app did not answer'));
    // Five chats whose end the desktop app would not confirm.
    for (const chatId of ['c1', 'c2', 'c3', 'c4', 'c5']) await sessions.stop(chatId);
    expect(end).toHaveBeenCalledTimes(5);

    expect(await sessions.ensureSession('c9', 'Nine')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    // One more try, not five: the answer is the same, and the caller does not wait five times over for it.
    expect(end).toHaveBeenCalledTimes(6);
    expect(driver.asked).toEqual(['c1']);

    // When the desktop app answers again, they are all confirmed before anything starts.
    end.mockRestore();
    const ended = vi.spyOn(driver, 'endSession');
    expect(await sessions.ensureSession('c9', 'Nine')).toEqual({ ok: true });
    expect(ended.mock.calls.map((call) => call[0])).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('says what to do when it stays that way', () => {
    expect(COMPUTER_END_UNCONFIRMED_REASON).toBe(
      "OtherBench couldn't confirm that the last control session was stopped, so nothing was started. Try again in a moment; if this keeps happening, restart OtherBench."
    );
  });

  it('tells another chat that OtherBench is still confirming, not that a chat is in control: nobody is', async () => {
    const { sessions, driver } = setup();
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    const end = heldEnd(driver);
    const stopping = sessions.stop('c1');
    // c1 asks again and waits for that end; nobody controls the computer meanwhile.
    const restart = sessions.ensureSession('c1', 'One');
    await tick();
    expect(sessions.activeChat()).toBeNull();
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: false, reason: COMPUTER_CONFIRMING_REASON });
    expect(COMPUTER_CONFIRMING_REASON).toBe('OtherBench is still confirming that the last control session was stopped. Try again in a moment.');
    expect(COMPUTER_CONFIRMING_REASON).not.toBe(COMPUTER_OTHER_CHAT_REASON);

    // Once the end is confirmed and c1's dialog is up, c1 does hold the computer, and the other chat is told so.
    driver.dialogUp = true;
    end.release(true);
    await stopping;
    await vi.waitFor(() => expect(driver.asked).toEqual(['c1', 'c1']));
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: false, reason: COMPUTER_OTHER_CHAT_REASON });
    driver.answer();
    expect(await restart).toEqual({ ok: true });
  });

  it("a reply stopped with its own Stop while its start waits: no native dialog comes up afterwards", async () => {
    const { sessions, driver, events } = setup();
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    const end = heldEnd(driver);
    const stopping = sessions.stop('c1');
    const restart = sessions.ensureSession('c1', 'One');
    await tick();

    // The reply's own Stop: the turn is cancelled, and may take a while to wind down. The start must not outlive it.
    sessions.replyStopping('c1');
    end.release(true);
    await stopping;
    expect(await restart).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    // The driver was asked once, for the first session, and never for the one that was waiting.
    expect(driver.asked).toEqual(['c1']);
    expect(driver.started).toHaveLength(1);
    expect(sessions.holder()).toBeNull();
    expect(events.filter((e) => e.type === 'computer-session').map((e) => (e as { active: boolean }).active)).toEqual([true, false]);
    // The chat can start again afterwards.
    end.spy.mockRestore();
    expect(await sessions.ensureSession('c1', 'One')).toEqual({ ok: true });
  });

  it('the same when the reply has finished by then (replyEnded)', async () => {
    const { sessions, driver } = setup();
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    const end = heldEnd(driver);
    const stopping = sessions.stop('c1');
    const restart = sessions.ensureSession('c1', 'One');
    await tick();
    sessions.replyEnded('c1');
    await tick();
    end.release(true);
    await stopping;
    expect(await restart).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    expect(driver.asked).toEqual(['c1']);
  });

  it("a reply's Stop does nothing to a dialog that is already up, a session in control, or another chat", async () => {
    const { sessions, driver } = setup();
    // Another chat, and a chat with nothing going on.
    sessions.replyStopping('c2');
    // A dialog that is up: answering it still starts the session (the tool then sees its reply was stopped and does nothing).
    driver.dialogUp = true;
    const starting = sessions.ensureSession('c1', 'One');
    await tick();
    sessions.replyStopping('c1');
    sessions.replyStopping('c2');
    driver.answer();
    expect(await starting).toEqual({ ok: true });
    // A session in control stays the chat's.
    await sessions.screenshot('c1');
    sessions.replyStopping('c1');
    expect(sessions.activeChat()).toBe('c1');
    expect(driver.ended).toEqual([]);
  });
});

describe('a driver that ended a session itself (it could no longer trust it)', () => {
  /** A fake that can say, as the desktop driver does after a timeout, an unreadable answer or a lost channel, that it ended a chat's session. */
  class LosingDriver extends DialogDriver {
    private readonly lostListeners = new Set<(chatId: string) => void>();

    onLost(cb: (chatId: string) => void): () => void {
      this.lostListeners.add(cb);
      return () => {
        this.lostListeners.delete(cb);
      };
    }

    /** The driver ended `chatId`'s session on its side. */
    lose(chatId: string): void {
      for (const cb of [...this.lostListeners]) cb(chatId);
    }

    listening(): number {
      return this.lostListeners.size;
    }
  }

  function losing() {
    const driver = new LosingDriver();
    return { ...setup(driver), driver };
  }

  it("drops the record, announces the end, tells the stopped listeners and asks the driver to confirm the end, and cancels the chat's replies", async () => {
    const { sessions, driver, events, stopped, cancelChat } = losing();
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    const end = vi.spyOn(driver, 'endSession');
    driver.lose('c1');
    expect(sessions.activeChat()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: false });
    expect(stopped).toEqual([['c1', 'button']]);
    expect(end.mock.calls).toEqual([['c1']]);
    // As for a stop from the shell: the reply that was using the session does not go on without it.
    expect(cancelChat.mock.calls).toEqual([['c1']]);
    // The chat's next call needs a new start, with the dialog again.
    expect(await sessions.act('c1', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(await sessions.ensureSession('c1', 'One')).toEqual({ ok: true });
    expect(driver.asked).toEqual(['c1', 'c1']);
  });

  it('an end the driver then cannot confirm holds every start back, as any other', async () => {
    const { sessions, driver } = losing();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await sessions.ensureSession('c1', 'One');
    const end = vi.spyOn(driver, 'endSession').mockRejectedValue(new Error('the desktop app went away'));
    driver.lose('c1');
    await tick();
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    end.mockRestore();
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
  });

  it("a chat that is not the one in control: nothing of the chat in control changes, the driver's end is not asked of it, and only the lost chat's replies are cancelled", async () => {
    const { sessions, driver, events, cancelChat } = losing();
    await sessions.ensureSession('c1', 'One');
    const end = vi.spyOn(driver, 'endSession');
    const before = events.length;
    driver.lose('c2');
    expect(sessions.activeChat()).toBe('c1');
    expect(events).toHaveLength(before);
    expect(end).not.toHaveBeenCalled();
    expect(cancelChat.mock.calls).toEqual([['c2']]);
  });

  it('stops listening when the server shuts down', () => {
    const { sessions, driver } = losing();
    expect(driver.listening()).toBe(1);
    sessions.dispose();
    expect(driver.listening()).toBe(0);
  });
});

describe('a driver whose shell started over', () => {
  /** A fake that can say, as the desktop driver does on a hello the shell answered, that the shell holds no session at all. */
  class ResettingDriver extends DialogDriver {
    private readonly resetListeners = new Set<() => void>();

    onReset(cb: () => void): () => void {
      this.resetListeners.add(cb);
      return () => {
        this.resetListeners.delete(cb);
      };
    }

    /** The shell answered a fresh hello. */
    reset(): void {
      for (const cb of [...this.resetListeners]) cb();
    }

    listening(): number {
      return this.resetListeners.size;
    }
  }

  function resetting() {
    const driver = new ResettingDriver();
    return { ...setup(driver), driver };
  }

  it('confirms every end it could not confirm: the next start goes ahead without the driver being asked to end anything', async () => {
    const { sessions, driver } = resetting();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    const end = vi.spyOn(driver, 'endSession').mockRejectedValue(new Error('the desktop app did not answer'));
    await sessions.stop('c1');
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: false, reason: COMPUTER_END_UNCONFIRMED_REASON });
    const asked = end.mock.calls.length;

    driver.reset();
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
    expect(end).toHaveBeenCalledTimes(asked);
    expect(sessions.activeChat()).toBe('c2');
  });

  it('drops the session it had on record, as when the shell says stopped: announced, listeners told, replies cancelled', async () => {
    const { sessions, driver, events, cancelChat, stopped } = resetting();
    await sessions.ensureSession('c1', 'One');
    await sessions.screenshot('c1');
    const end = vi.spyOn(driver, 'endSession');
    const spies = [vi.spyOn(driver, 'act'), vi.spyOn(driver, 'target'), vi.spyOn(driver, 'screenshot'), vi.spyOn(driver, 'cursorPosition')];

    driver.reset();
    expect(sessions.activeChat()).toBeNull();
    expect(sessions.holder()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'computer-session', chatId: 'c1', active: false });
    expect(stopped).toEqual([['c1', 'quit']]);
    expect(cancelChat.mock.calls).toEqual([['c1']]);
    // The shell holds nothing: there is nothing to ask it to end.
    expect(end).not.toHaveBeenCalled();

    expect(await sessions.act('c1', CLICK, EXPECT)).toEqual({ ok: false, reason: COMPUTER_NO_SESSION_REASON });
    expect(await sessions.target('c1', 'foreground')).toEqual({ refuse: COMPUTER_NO_SESSION_REASON });
    await expect(sessions.screenshot('c1')).rejects.toThrow(COMPUTER_NO_SESSION_REASON);
    await expect(sessions.cursorPosition('c1')).rejects.toThrow(COMPUTER_NO_SESSION_REASON);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // Another chat can start, with its own dialog.
    expect(await sessions.ensureSession('c2', 'Two')).toEqual({ ok: true });
    expect(driver.started.map((s) => s.chatId)).toEqual(['c1', 'c2']);
  });

  it("a start whose dialog was up is nobody's any more: a yes that comes afterwards is ended", async () => {
    const { sessions, driver, cancelChat, events, stopped } = resetting();
    driver.dialogUp = true;
    const starting = sessions.ensureSession('c1', 'One');
    await tick();
    driver.reset();
    expect(cancelChat.mock.calls).toEqual([['c1']]);
    expect(stopped).toEqual([['c1', 'quit']]);
    driver.answer();
    expect(await starting).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    expect(driver.ended).toEqual(['c1']);
    expect(sessions.activeChat()).toBeNull();
    expect(events.filter((e) => e.type === 'computer-session')).toEqual([]);
  });

  it('with nothing on record: announces nothing and cancels nothing', () => {
    const { driver, events, cancelChat, stopped } = resetting();
    driver.reset();
    expect(events).toEqual([]);
    expect(stopped).toEqual([]);
    expect(cancelChat).not.toHaveBeenCalled();
  });

  it('stops listening when the server shuts down, and a reset after that does nothing', async () => {
    const { sessions, driver, cancelChat } = resetting();
    expect(driver.listening()).toBe(1);
    sessions.dispose();
    expect(driver.listening()).toBe(0);
    sessions.shellReset();
    expect(cancelChat).not.toHaveBeenCalled();
  });

  it('a driver that cannot say so (the fake) is taken as it is', async () => {
    const { sessions } = setup();
    expect(await sessions.ensureSession('c1', 'One')).toEqual({ ok: true });
    expect(sessions.activeChat()).toBe('c1');
  });
});
