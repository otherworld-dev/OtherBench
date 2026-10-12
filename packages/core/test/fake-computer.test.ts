import { describe, expect, it } from 'vitest';
import { FAKE_COMPUTER_APP, FAKE_PNG, FakeComputerDriver } from '../src/testing/fake-computer.js';

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

    expect(await driver.act('c1', { action: 'left_click', coordinate: [1, 2] }, 'c:\\x.exe')).toEqual({ ok: true });
    expect(driver.actions).toEqual([{ chatId: 'c1', action: { action: 'left_click', coordinate: [1, 2] }, expectApp: 'c:\\x.exe' }]);

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
});
