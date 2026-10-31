import type { Browser } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { browserAttempts, ChromiumSessions, CHROMIUM_ARGS, OFF_SCREEN, WEBRTC_SWITCHES } from '../../src/browser/chromium.js';
import { BrowserUnavailableError } from '../../src/browser/session.js';

describe('browserAttempts', () => {
  it("tries only OTHERBENCH_BROWSER_PATH when it's set, in a window and then headless", () => {
    expect(browserAttempts({ OTHERBENCH_BROWSER_PATH: ' C:\\Edge\\msedge.exe ' })).toEqual([
      { name: 'C:\\Edge\\msedge.exe', options: { executablePath: 'C:\\Edge\\msedge.exe' }, visible: true },
      { name: 'C:\\Edge\\msedge.exe', options: { executablePath: 'C:\\Edge\\msedge.exe' }, visible: false },
    ]);
  });

  it('otherwise tries real windows first, then headless where no window can open', () => {
    expect(browserAttempts({})).toEqual([
      { name: 'Chrome', options: { channel: 'chrome' }, visible: true },
      { name: 'Edge', options: { channel: 'msedge' }, visible: true },
      { name: "Playwright's Chromium", options: {}, visible: true },
      { name: "Playwright's Chromium", options: {}, visible: false },
      { name: 'Chrome', options: { channel: 'chrome' }, visible: false },
      { name: 'Edge', options: { channel: 'msedge' }, visible: false },
    ]);
  });

  it('never opens a window with OTHERBENCH_BROWSER_HEADLESS=1', () => {
    expect(browserAttempts({ OTHERBENCH_BROWSER_HEADLESS: '1' }).map((a) => a.visible)).toEqual([false, false, false]);
  });
});

/** A browser that only knows what ChromiumSessions asks of it. `closeNever` makes close() hang, as a wedged Chromium would. */
function fakeBrowser(opts: { closeNever?: boolean; pid?: number; connected?: () => boolean } = {}): Browser {
  return {
    on: () => undefined,
    isConnected: opts.connected ?? (() => true),
    close: () => (opts.closeNever ? new Promise<void>(() => undefined) : Promise.resolve()),
    newBrowserCDPSession: async () => ({
      send: async () => ({ processInfo: [{ type: 'renderer', id: 1 }, { type: 'browser', id: opts.pid ?? 4242 }] }),
      detach: async () => undefined,
    }),
    newContext: async () => {
      throw new Error('no contexts in this test');
    },
  } as unknown as Browser;
}

const creds = { server: 'http://127.0.0.1:1', username: 'u', password: 'p' };

describe('ChromiumSessions launching', () => {
  it('opens windows off screen, and with no display falls back to headless', async () => {
    const launch = vi.fn(async (o: { headless?: boolean }) => {
      if (!o.headless) throw new Error('Missing X server');
      return fakeBrowser();
    });
    await new ChromiumSessions({}, { launch }).open(creds).catch(() => undefined);
    const calls = launch.mock.calls.map(([o]) => o as { headless: boolean; args: string[] });
    expect(calls.slice(0, 3).every((o) => !o.headless && o.args.includes(OFF_SCREEN))).toBe(true);
    expect(calls[3]).toMatchObject({ headless: true });
    expect(calls[3]!.args).not.toContain(OFF_SCREEN);
  });

  it('starts headless with the sandbox on, the proxy (loopback not bypassed), both WebRTC switches and no signal handlers', async () => {
    const launch = vi.fn(async () => fakeBrowser());
    const sessions = new ChromiumSessions({ OTHERBENCH_BROWSER_HEADLESS: '1' }, { launch });
    await sessions.open(creds).catch(() => undefined); // newContext throws in the fake: only the launch matters here
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: true,
        chromiumSandbox: true,
        proxy: { server: creds.server, bypass: '<-loopback>' },
        args: [...CHROMIUM_ARGS],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      })
    );
    // The headless shell reads the --force- form, full Chromium, Chrome and Edge the plain one: both, whichever launches.
    expect(WEBRTC_SWITCHES).toEqual(['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp']);
    expect(CHROMIUM_ARGS).toEqual(expect.arrayContaining([...WEBRTC_SWITCHES, '--disable-quic']));
    expect(JSON.stringify(launch.mock.calls[0])).not.toContain('no-sandbox');
  });

  it('falls through the attempts in order, then keeps the one that worked', async () => {
    const tried: unknown[] = [];
    const launch = vi.fn(async (o: { channel?: string }) => {
      tried.push(o.channel ?? 'bundled');
      if (o.channel !== 'msedge') throw new Error('not here\nstack line');
      return fakeBrowser();
    });
    const sessions = new ChromiumSessions({}, { launch });
    await sessions.open(creds).catch(() => undefined);
    expect(tried).toEqual(['chrome', 'msedge']);
    await sessions.shutdown();
    tried.length = 0;
    await sessions.open(creds).catch(() => undefined);
    expect(tried).toEqual(['msedge']);
  });

  it('says what to install when nothing launches', async () => {
    const sessions = new ChromiumSessions({}, { launch: async () => { throw new Error('nope'); } });
    const err = await sessions.open(creds).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toContain('npx playwright install --only-shell chromium');
  });
});

describe('ChromiumSessions shutdown', () => {
  it('ends a Chromium that does not close in time, so it cannot hold up the next browser', async () => {
    const kill = vi.fn();
    const sessions = new ChromiumSessions({}, { launch: async () => fakeBrowser({ closeNever: true, pid: 777 }), closeTimeoutMs: 50, kill });
    await sessions.open(creds).catch(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await sessions.shutdown();
    warn.mockRestore();
    expect(kill).toHaveBeenCalledWith(777);
  });

  it("doesn't kill a Chromium that disconnected while it was closing (its process id may be another's by now)", async () => {
    const kill = vi.fn();
    let connected = true;
    const browser = fakeBrowser({ closeNever: true, pid: 777, connected: () => connected });
    const sessions = new ChromiumSessions({}, { launch: async () => browser, closeTimeoutMs: 50, kill });
    await sessions.open(creds).catch(() => undefined);
    setTimeout(() => {
      connected = false;
    }, 10);
    await sessions.shutdown();
    expect(kill).not.toHaveBeenCalled();
  });

  it("doesn't kill a Chromium that closed", async () => {
    const kill = vi.fn();
    const sessions = new ChromiumSessions({}, { launch: async () => fakeBrowser({ pid: 777 }), closeTimeoutMs: 50, kill });
    await sessions.open(creds).catch(() => undefined);
    await sessions.shutdown();
    expect(kill).not.toHaveBeenCalled();
  });

  it('does nothing when no browser was ever started', async () => {
    await expect(new ChromiumSessions({}, { launch: async () => fakeBrowser() }).shutdown()).resolves.toBeUndefined();
  });
});
