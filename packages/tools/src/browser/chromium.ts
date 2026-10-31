import { chromium, type Browser, type BrowserContext, type CDPSession, type Frame, type LaunchOptions, type Locator, type Page } from 'playwright-core';
import { siteOf } from '@otherbench/core/domain/browser-hosts.js';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';
import { answerCookieBoxes } from './consent.js';
import type { BrowserProfile, ProfileState } from './profile.js';
import { pageText } from './snapshot.js';
import { BrowserUnavailableError, PageMovedError, StaleRefError, type ActionGuard, type BrowserInput, type BrowserSession, type ProxyCredentials, type SessionFactory } from './session.js';

/** A headless page's size; a real window has whatever size it is given. */
export const VIEWPORT = { width: 1280, height: 800 };
/** Where a real window sits once it is on screen: it is minimised there, so restoring it from the taskbar lands somewhere useful. */
export const WINDOW_BOUNDS = { left: 100, top: 100, width: 1280, height: 900 };
/**
 * New windows start off screen, so none flashes up before it is minimised.
 * They can't stay there: Chromium draws nothing for an off-screen window, so
 * the live view would stop. A minimised one keeps drawing.
 */
export const OFF_SCREEN = '--window-position=-32000,-32000';
/**
 * A new page's result waits this long from the navigation for a cookie box to
 * turn up. On a page with none the rules go on looking for seconds, so it
 * can't wait for them to give up: the box on a fixture page is gone in 0.7 s.
 */
export const CONSENT_LOOK_MS = 1_000;
/** The longest a result waits for all of that, once the page has loaded. */
export const CONSENT_WAIT_MS = 2_000;
export const SCREENCAST = { size: { width: 1024, height: 640 }, quality: 60 };
export const ACTION_TIMEOUT_MS = 15_000;
export const NAVIGATION_TIMEOUT_MS = 30_000;
export const SETTLE_MS = 3_000;
/** A hung Chromium or context is given this long to close before it is killed or left behind. */
export const CLOSE_TIMEOUT_MS = 5_000;
/**
 * Keep WebRTC to proxied connections: no UDP around the proxy. Only the
 * headless shell reads the `--force-` form; full Chromium, Chrome and Edge read
 * the plain one (each ignores the other), so both are passed, whichever
 * browser launches.
 */
export const WEBRTC_SWITCHES = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'] as const;
/**
 * Every switch Chromium starts with. `--disable-quic` is defence in depth:
 * Chromium doesn't speak QUIC through an HTTP proxy anyway, and with it off no
 * HTTP/3 attempt can go out over UDP whatever a page asks for.
 */
export const CHROMIUM_ARGS: readonly string[] = [...WEBRTC_SWITCHES, '--disable-quic'];

const INSTALL_HINT = 'Install one with "npx playwright install --only-shell chromium", or set OTHERBENCH_BROWSER_PATH to a Chromium, Chrome or Edge.';
/** The longest page-sourced text (a dialog's message, a popup's address) put in a note. */
const NOTE_TEXT_CHARS = 300;

export interface BrowserAttempt {
  name: string;
  options: LaunchOptions;
  /** A real window a person can use, rather than a headless page. */
  visible: boolean;
}

/**
 * Which browsers to try, in order: real windows first, so a person can step
 * in, then headless where no window can open (a server with no display).
 * Headless only with OTHERBENCH_BROWSER_HEADLESS=1 (tests). OTHERBENCH_BROWSER_PATH
 * names the one browser to use.
 */
export function browserAttempts(env: NodeJS.ProcessEnv): BrowserAttempt[] {
  const path = env['OTHERBENCH_BROWSER_PATH']?.trim();
  const builds: { name: string; options: LaunchOptions }[] = path
    ? [{ name: path, options: { executablePath: path } }]
    : [
        { name: 'Chrome', options: { channel: 'chrome' } },
        { name: 'Edge', options: { channel: 'msedge' } },
        { name: "Playwright's Chromium", options: {} },
      ];
  const windowed = builds.map((b) => ({ ...b, visible: true }));
  const headless = builds.map((b) => ({ ...b, visible: false }));
  // Playwright's own build first: it is what CI installs, and the one kept for this.
  headless.sort((a, b) => Number(b.name === "Playwright's Chromium") - Number(a.name === "Playwright's Chromium"));
  return env['OTHERBENCH_BROWSER_HEADLESS'] === '1' ? headless : [...windowed, ...headless];
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
}

/** Page-sourced text for a note: cleaned like every other page text, and quoted so it reads as the page's words. */
function quoted(text: string): string {
  return JSON.stringify(pageText(text, NOTE_TEXT_CHARS));
}

/** Resolves `true` when `work` settled (either way) within `ms`, `false` when the time ran out first. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** How the factory starts and measures things; replaced in tests so the unit tests need no browser. */
export interface ChromiumSessionsOptions {
  launch?: (options: LaunchOptions) => Promise<Browser>;
  closeTimeoutMs?: number;
  /** Kills the browser process with this id (default: process.kill). */
  kill?: (pid: number) => void;
  /** Where sign-ins and cookie choices are kept between chats; without one, every browser starts empty. */
  profile?: BrowserProfile;
}

/**
 * Chrome, Edge or Chromium through Playwright (spec
 * 2026-10-12-model-browser-design §2): one process per server, started on the
 * first session, with Chromium's own sandbox on and no `--no-sandbox` fallback.
 * Each session is its own context, and so its own minimised window, whose
 * traffic goes through OtherBench's proxy as its own user. That is why a
 * context each and not one persistent Chrome profile: the proxy tells chats
 * apart by their credentials, and each chat has its own blocked sites. What is
 * shared between chats is copied in and out through `BrowserProfile`.
 */
export class ChromiumSessions implements SessionFactory {
  private browser: Promise<Browser> | null = null;
  /** The attempt that launched first; kept for the server's life. */
  private preferred: number | null = null;
  /** The browser that launched last, while it is connected. */
  private live: Browser | null = null;
  /** The browser process's id, read from Chromium itself, so a hung close can be ended. */
  private readonly pids = new WeakMap<Browser, number>();
  /** Whether the browser that launched shows real windows. */
  private visible = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly options: ChromiumSessionsOptions = {}
  ) {}

  async open(proxy: ProxyCredentials): Promise<BrowserSession> {
    const browser = await this.launchOnce(proxy.server);
    const profile = this.options.profile ?? null;
    const generation = profile?.generation ?? 0;
    const saved = profile ? await profile.load() : null;
    const context = await browser.newContext({
      viewport: this.visible ? null : VIEWPORT,
      acceptDownloads: false,
      serviceWorkers: 'block',
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: '<-loopback>' },
      ...(saved ? { storageState: saved } : {}),
    });
    try {
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      const page = await context.newPage();
      const session = new PageSession(context, page, this.options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS, this.visible, profile && saved ? { profile, generation, before: saved } : null);
      await answerCookieBoxes(context, session.consent);
      if (this.visible) await session.park();
      return session;
    } catch (err) {
      await context.close().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Closes Chromium. Bounded: if it hasn't closed within the timeout it is
   * killed, so a hung browser can't keep every new one waiting.
   */
  async forgetProfile(): Promise<void> {
    await this.options.profile?.forget();
  }

  async shutdown(): Promise<void> {
    const pending = this.browser;
    this.browser = null;
    const browser = pending ? await pending.catch(() => null) : null;
    if (!browser) return;
    const closed = await within(browser.close(), this.options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
    // A browser that disconnected meanwhile has gone: its id may already belong to another process.
    if (closed || !browser.isConnected()) return;
    const pid = this.pids.get(browser);
    console.warn(`[browser] Chromium didn't close in time${pid === undefined ? '' : `; ending process ${pid}`}.`);
    if (pid === undefined) return;
    try {
      (this.options.kill ?? ((p: number) => process.kill(p)))(pid);
    } catch {
      // it may have exited just now
    }
  }

  private launchOnce(proxyServer: string): Promise<Browser> {
    if (!this.browser) {
      const launching = this.launch(proxyServer);
      this.browser = launching;
      launching.catch(() => {
        if (this.browser === launching) this.browser = null;
      });
    }
    return this.browser;
  }

  private async launch(proxyServer: string): Promise<Browser> {
    const base: LaunchOptions = {
      chromiumSandbox: true,
      // Browser-level requests carry no proxy credentials, so the proxy refuses them.
      proxy: { server: proxyServer, bypass: '<-loopback>' },
      // OtherBench decides how it stops (see `otherbench serve`); Playwright's own SIGINT/SIGTERM/SIGHUP handlers would
      // change that once a browser had launched. Its `exit` handler stays (always installed): when the server's
      // process exits, it kills Chromium's process tree (taskkill /T /F on Windows, the process group elsewhere).
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      // Playwright passes the server's environment to the browser by default; never its API token (core/domain/child-env.ts).
      env: withoutServerSecrets(this.env),
    };
    const launch = this.options.launch ?? ((o: LaunchOptions) => chromium.launch(o));
    const attempts = browserAttempts(this.env);
    const order = this.preferred === null ? attempts.map((_, i) => i) : [this.preferred];
    const failures: string[] = [];
    for (const i of order) {
      const attempt = attempts[i]!;
      try {
        const browser = await launch({ ...base, ...attempt.options, headless: !attempt.visible, args: attempt.visible ? [...CHROMIUM_ARGS, OFF_SCREEN] : [...CHROMIUM_ARGS] });
        this.preferred = i;
        this.visible = attempt.visible;
        this.live = browser;
        browser.on('disconnected', () => {
          // A browser that went away is replaced on the next session; a newer one is left alone.
          if (this.live === browser) {
            this.live = null;
            this.browser = null;
          }
        });
        await this.notePid(browser);
        return browser;
      } catch (err) {
        failures.push(`${attempt.name}: ${firstLine(err)}`);
      }
    }
    throw new BrowserUnavailableError(`OtherBench couldn't start a browser. ${INSTALL_HINT} (${failures.join('; ')})`);
  }

  /** Asks Chromium for its own process id (best effort: without it a hung close just can't be ended). */
  private async notePid(browser: Browser): Promise<void> {
    try {
      const cdp = await browser.newBrowserCDPSession();
      const info = await cdp.send('SystemInfo.getProcessInfo');
      const main = info.processInfo.find((p) => p.type === 'browser');
      if (main) this.pids.set(browser, main.id);
      await cdp.detach().catch(() => undefined);
    } catch {
      // not available on this build
    }
  }
}

/** Every main-frame navigation of every page takes the next number, so an id never repeats, even across sessions. */
let navigationCounter = 0;

/** Where a password field's value waits while a snapshot is read. On the element, so it is back even if the page rearranged itself meanwhile. */
const HIDDEN_VALUE = 'otherbench.hidden-value';

/** Takes the value out of every password field of a frame, or puts them back. Runs in the page. */
function swapPasswords(inputs: HTMLInputElement[], arg: { key: string; hide: boolean }): void {
  const key = Symbol.for(arg.key);
  for (const input of inputs) {
    const holder = input as unknown as Record<symbol, string | undefined>;
    if (arg.hide && input.value !== '') {
      holder[key] = input.value;
      input.value = '';
    } else if (!arg.hide && holder[key] !== undefined) {
      input.value = holder[key];
      delete holder[key];
    }
  }
}

/** A session's link to the saved profile. `before` is what the profile held for it the last time they were matched up. */
interface ProfileLink {
  profile: BrowserProfile;
  generation: number;
  before: ProfileState;
}

/** One chat's page: its events turned into notes, its actions by aria ref. */
class PageSession implements BrowserSession {
  private notes: string[] = [];
  private readonly navListeners = new Set<() => void>();
  private screencasting = false;
  private lastUrl = 'about:blank';
  private navId = 0;
  private readonly closedListeners = new Set<() => void>();
  /** A person has the window: what they open from it stays open. */
  private shown = false;
  private consentBusy = false;
  private consentAnswered = false;
  private navigatedAt = 0;
  private window: { cdp: CDPSession; id: number } | null = null;

  /** What Autoconsent reports as it answers a cookie box. */
  readonly consent = {
    found: (): void => {
      this.consentBusy = true;
    },
    finished: (cleared: boolean): void => {
      this.consentBusy = false;
      this.consentAnswered = true;
      if (cleared) this.notes.push('A cookie box on this page was answered for you.');
    },
  };

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly closeTimeoutMs: number,
    readonly visible: boolean,
    private readonly link: ProfileLink | null
  ) {
    // One tab only, unless a person has the window: anything else that opens is closed and reported.
    context.on('page', (other) => {
      if (other !== page && !this.shown) void this.closePopup(other);
    });
    page.on('close', () => {
      this.remember();
      for (const cb of this.closedListeners) cb();
    });
    // Everything the page says is quoted and cleaned: it reaches the model as page content, not as OtherBench's words.
    page.on('dialog', (dialog) => {
      this.notes.push(`The page showed a dialog (${dialog.type()}): ${quoted(dialog.message())}. It was dismissed.`);
      void dialog.dismiss().catch(() => undefined);
    });
    // With a listener here, Chromium shows no file chooser; nothing is ever chosen.
    page.on('filechooser', () => {
      this.notes.push("The page asked for a file to upload. Uploads aren't allowed, so none was given.");
    });
    page.on('download', (download) => {
      this.notes.push(`The page tried to download a file named ${quoted(download.suggestedFilename())}. Downloads aren't allowed.`);
      void download.cancel().catch(() => undefined);
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      // Same-document navigations (the history API, a #fragment) arrive here too.
      this.navId = ++navigationCounter;
      this.navigatedAt = Date.now();
      this.consentBusy = false;
      this.consentAnswered = false;
      this.remember();
      for (const cb of this.navListeners) cb();
    });
  }

  /** The page's address; after the page or context closed, the last one it had (never throws). */
  url(): string {
    this.remember();
    return this.lastUrl;
  }

  navigationId(): number {
    return this.navId;
  }

  title(): Promise<string> {
    return this.page.title().catch(() => '');
  }

  async snapshot(guard?: ActionGuard): Promise<string> {
    this.check(guard);
    // A snapshot carries what fields hold, and a person may have just signed in here: password fields are empty for as long as it takes.
    const frames = this.page.frames();
    await this.swapPasswords(frames, true);
    try {
      return await this.page.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS });
    } finally {
      await this.swapPasswords(frames, false);
    }
  }

  async open(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  }

  // Each action below finds its element (an await), then checks the guard and
  // hands the action to Playwright in the same synchronous step: no await
  // between the check and the call. The check reads Playwright's client-side
  // view of the page, which learns of a navigation only when Chromium's event
  // for it arrives. So a window remains: a navigation Chromium has already
  // committed (or commits before it dispatches the input) but hasn't yet
  // reported passes the check, and the input can land on that new document.
  // It is short (one round trip to Chromium) and the page itself must cause it;
  // an element-based action usually fails anyway, because its aria ref belongs
  // to the old document.

  async click(ref: string, double: boolean, guard?: ActionGuard): Promise<void> {
    const el = await this.element(ref);
    this.check(guard);
    if (double) await el.dblclick({ timeout: ACTION_TIMEOUT_MS });
    else await el.click({ timeout: ACTION_TIMEOUT_MS });
  }

  async type(ref: string, text: string, submit: boolean, guard?: ActionGuard): Promise<void> {
    const el = await this.element(ref);
    this.check(guard);
    await el.fill(text, { timeout: ACTION_TIMEOUT_MS });
    if (!submit) return;
    // The typing itself may have moved the page (a field that navigates on change): Enter is then not pressed on another website.
    // Same-site changes (a search box that updates the address as you type) are the page's own and fine.
    try {
      this.check(guard && { site: guard.site });
    } catch (err) {
      if (!(err instanceof PageMovedError)) throw err;
      this.notes.push("The page changed while the text was typed, so Enter wasn't pressed.");
      return;
    }
    await el.press('Enter', { timeout: ACTION_TIMEOUT_MS });
  }

  async select(ref: string, values: string[], guard?: ActionGuard): Promise<void> {
    const el = await this.element(ref);
    this.check(guard);
    await el.selectOption(values, { timeout: ACTION_TIMEOUT_MS });
  }

  async press(key: string, guard?: ActionGuard): Promise<void> {
    this.check(guard);
    await this.page.keyboard.press(key);
  }

  async scroll(direction: 'up' | 'down', ref?: string, guard?: ActionGuard): Promise<void> {
    if (ref !== undefined) {
      const el = await this.element(ref);
      this.check(guard);
      await el.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      return;
    }
    this.check(guard);
    await this.page.mouse.wheel(0, direction === 'down' ? 600 : -600);
  }

  async back(guard?: ActionGuard): Promise<void> {
    this.check(guard);
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  }

  async settle(): Promise<void> {
    await this.page.waitForLoadState('load', { timeout: SETTLE_MS }).catch(() => undefined);
    const until = Date.now() + CONSENT_WAIT_MS;
    const looking = (): boolean => !this.consentAnswered && Date.now() < this.navigatedAt + CONSENT_LOOK_MS;
    while ((this.consentBusy || looking()) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }

  takeNotes(): string[] {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }

  async startScreencast(onFrame: (jpeg: Buffer) => void): Promise<void> {
    if (this.screencasting) return;
    this.screencasting = true;
    try {
      await this.page.screencast.start({ ...SCREENCAST, onFrame: ({ data }) => onFrame(data) });
    } catch (err) {
      this.screencasting = false;
      throw err;
    }
  }

  async stopScreencast(): Promise<void> {
    if (!this.screencasting) return;
    this.screencasting = false;
    await this.page.screencast.stop().catch(() => undefined);
  }

  onNavigate(cb: () => void): () => void {
    this.navListeners.add(cb);
    return () => {
      this.navListeners.delete(cb);
    };
  }

  onClosed(cb: () => void): () => void {
    this.closedListeners.add(cb);
    return () => {
      this.closedListeners.delete(cb);
    };
  }

  /** Moves a new window on screen and minimises it, in that order: it can only be moved while it isn't minimised. Best effort. */
  async park(): Promise<void> {
    const window = await this.windowOf();
    await window?.cdp.send('Browser.setWindowBounds', { windowId: window.id, bounds: WINDOW_BOUNDS }).catch(() => undefined);
    await window?.cdp.send('Browser.setWindowBounds', { windowId: window.id, bounds: { windowState: 'minimized' } }).catch(() => undefined);
  }

  async reveal(): Promise<void> {
    this.shown = true;
    if (!this.visible) return;
    const window = await this.windowOf();
    await window?.cdp.send('Browser.setWindowBounds', { windowId: window.id, bounds: { windowState: 'normal' } }).catch(() => undefined);
    await this.page.bringToFront().catch(() => undefined);
  }

  async conceal(): Promise<void> {
    this.shown = false;
    await Promise.all(this.context.pages().filter((p) => p !== this.page).map((p) => p.close().catch(() => undefined)));
    if (!this.visible) return;
    const window = await this.windowOf();
    await window?.cdp.send('Browser.setWindowBounds', { windowId: window.id, bounds: { windowState: 'minimized' } }).catch(() => undefined);
  }

  async input(event: BrowserInput): Promise<void> {
    switch (event.type) {
      case 'click':
      case 'wheel': {
        const size = await this.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        const x = event.x * size.width;
        const y = event.y * size.height;
        if (event.type === 'click') return this.page.mouse.click(x, y);
        await this.page.mouse.move(x, y);
        return this.page.mouse.wheel(0, event.dy);
      }
      case 'key':
        return this.page.keyboard.press(event.key as Parameters<Page['keyboard']['press']>[0]);
      case 'text':
        return this.page.keyboard.insertText(event.text);
    }
  }

  async saveProfile(): Promise<void> {
    if (!this.link) return;
    const link = this.link;
    try {
      const after = await this.context.storageState();
      await link.profile.save(link.generation, link.before, after);
      link.before = after;
    } catch (err) {
      console.warn("[browser] this browser's sign-ins and cookie choices could not be saved:", err);
    }
  }

  async close(): Promise<void> {
    this.remember();
    this.navListeners.clear();
    this.closedListeners.clear();
    await within(this.saveProfile(), this.closeTimeoutMs);
    // A context that won't close is left to the browser's own shutdown; it must not hold the caller.
    await within(this.context.close(), this.closeTimeoutMs);
  }

  private async windowOf(): Promise<{ cdp: CDPSession; id: number } | null> {
    if (this.window) return this.window;
    try {
      const cdp = await this.context.newCDPSession(this.page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      this.window = { cdp, id: windowId };
    } catch {
      // a build that can't say: the window stays where it is
    }
    return this.window;
  }

  /** Every password field of the frames, including inside open shadow roots. A frame that has gone is skipped. */
  private async swapPasswords(frames: Frame[], hide: boolean): Promise<void> {
    await Promise.all(frames.map((f) => f.locator('input[type=password]').evaluateAll(swapPasswords, { key: HIDDEN_VALUE, hide }).catch(() => undefined)));
  }

  /** Throws PageMovedError unless the page is still on the approved site (and, when asked, on the same navigation). Synchronous. */
  private check(guard: ActionGuard | undefined): void {
    if (!guard) return;
    this.remember();
    const site = siteOf(this.lastUrl);
    if (site !== guard.site || (guard.navId !== undefined && guard.navId !== this.navId)) throw new PageMovedError(site);
  }

  private remember(): void {
    try {
      this.lastUrl = this.page.url() || this.lastUrl;
    } catch {
      // the page is gone: keep the last address
    }
  }

  /**
   * The element a snapshot ref names. Counted first, so a ref that matches
   * nothing fails at once instead of waiting out the 15-second action timeout.
   */
  private async element(ref: string): Promise<Locator> {
    const el = this.page.locator(`aria-ref=${ref}`);
    let count = 0;
    try {
      count = await el.count();
    } catch {
      throw new StaleRefError(ref);
    }
    if (count === 0) throw new StaleRefError(ref);
    return el.first();
  }

  private async closePopup(popup: Page): Promise<void> {
    try {
      await popup.waitForURL((u) => u.href !== 'about:blank', { timeout: 2_000 });
    } catch {
      // it may never leave about:blank
    }
    let address = 'about:blank';
    try {
      address = popup.url();
    } catch {
      // already gone
    }
    this.notes.push(`The page opened a new window at ${quoted(address)}. Only one tab is allowed, so it was closed: use open with that address to go there.`);
    await popup.close().catch(() => undefined);
  }
}
