import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Locator, type Page } from 'playwright-core';
import { siteOf } from '@grunt/core/domain/browser-hosts.js';
import { pageText } from './snapshot.js';
import { BrowserUnavailableError, PageMovedError, StaleRefError, type ActionGuard, type BrowserSession, type ProxyCredentials, type SessionFactory } from './session.js';

export const VIEWPORT = { width: 1280, height: 800 };
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

const INSTALL_HINT = 'Install one with "npx playwright install --only-shell chromium", or set GRUNT_BROWSER_PATH to a Chromium, Chrome or Edge.';
/** The longest page-sourced text (a dialog's message, a popup's address) put in a note. */
const NOTE_TEXT_CHARS = 300;

/** Which browsers to try, in order (spec §2): GRUNT_BROWSER_PATH alone, else Playwright's Chromium, Chrome, Edge. */
export function browserAttempts(env: NodeJS.ProcessEnv): { name: string; options: LaunchOptions }[] {
  const path = env['GRUNT_BROWSER_PATH']?.trim();
  if (path) return [{ name: path, options: { executablePath: path } }];
  return [
    { name: "Playwright's Chromium", options: {} },
    { name: 'Chrome', options: { channel: 'chrome' } },
    { name: 'Edge', options: { channel: 'msedge' } },
  ];
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
}

/**
 * Headless Chromium through Playwright (spec 2026-10-12-model-browser-design
 * §2): one process per server, started on the first session, with Chromium's
 * own sandbox on and no `--no-sandbox` fallback. Each session is a fresh
 * in-memory context whose traffic goes through Grunt's proxy as its own user.
 */
export class ChromiumSessions implements SessionFactory {
  private browser: Promise<Browser> | null = null;
  /** The attempt that launched first; kept for the server's life. */
  private preferred: number | null = null;
  /** The browser that launched last, while it is connected. */
  private live: Browser | null = null;
  /** The browser process's id, read from Chromium itself, so a hung close can be ended. */
  private readonly pids = new WeakMap<Browser, number>();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly options: ChromiumSessionsOptions = {}
  ) {}

  async open(proxy: ProxyCredentials): Promise<BrowserSession> {
    const browser = await this.launchOnce(proxy.server);
    const context = await browser.newContext({
      viewport: VIEWPORT,
      acceptDownloads: false,
      serviceWorkers: 'block',
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: '<-loopback>' },
    });
    try {
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      const page = await context.newPage();
      return new PageSession(context, page, this.options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
    } catch (err) {
      await context.close().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Closes Chromium. Bounded: if it hasn't closed within the timeout it is
   * killed, so a hung browser can't keep every new one waiting.
   */
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
      headless: true,
      chromiumSandbox: true,
      // Browser-level requests carry no proxy credentials, so the proxy refuses them.
      proxy: { server: proxyServer, bypass: '<-loopback>' },
      args: [...CHROMIUM_ARGS],
      // Grunt decides how it stops (see `grunt serve`); Playwright's own SIGINT/SIGTERM/SIGHUP handlers would
      // change that once a browser had launched. Its `exit` handler stays (always installed): when the server's
      // process exits, it kills Chromium's process tree (taskkill /T /F on Windows, the process group elsewhere).
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    };
    const launch = this.options.launch ?? ((o: LaunchOptions) => chromium.launch(o));
    const attempts = browserAttempts(this.env);
    const order = this.preferred === null ? attempts.map((_, i) => i) : [this.preferred];
    const failures: string[] = [];
    for (const i of order) {
      const attempt = attempts[i]!;
      try {
        const browser = await launch({ ...base, ...attempt.options });
        this.preferred = i;
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
    throw new BrowserUnavailableError(`Grunt couldn't start a browser. ${INSTALL_HINT} (${failures.join('; ')})`);
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

/** One chat's page: its events turned into notes, its actions by aria ref. */
class PageSession implements BrowserSession {
  private notes: string[] = [];
  private readonly navListeners = new Set<() => void>();
  private screencasting = false;
  private lastUrl = 'about:blank';
  private navId = 0;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly closeTimeoutMs: number
  ) {
    // One tab only: anything else that opens is closed and reported.
    context.on('page', (other) => {
      if (other !== page) void this.closePopup(other);
    });
    // Everything the page says is quoted and cleaned: it reaches the model as page content, not as Grunt's words.
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
    return this.page.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS });
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

  async close(): Promise<void> {
    this.remember();
    this.navListeners.clear();
    // A context that won't close is left to the browser's own shutdown; it must not hold the caller.
    await within(this.context.close(), this.closeTimeoutMs);
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
