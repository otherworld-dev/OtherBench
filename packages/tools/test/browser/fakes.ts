import type { EgressProxy, EgressProxyOptions } from '../../src/browser/proxy.js';
import { siteOf } from '@grunt/core/domain/browser-hosts.js';
import { PageMovedError, type ActionGuard, type BrowserSession, type ProxyCredentials, type SessionFactory } from '../../src/browser/session.js';

/** Like the real sessions: every navigation takes the next number, across sessions. */
let navigations = 0;

/** A page that records what was done to it. `navigate` plays the page moving by itself (a redirect, a link). */
export class FakeSession implements BrowserSession {
  current = 'about:blank';
  pageTitle = '';
  snap = '- heading "Hello" [level=1] [ref=e1]\n- textbox "Search" [ref=e2]\n- button "Go" [ref=e3]';
  readonly actions: string[] = [];
  notes: string[] = [];
  closed = false;
  /** Set to make every action fail, as a page that died would. */
  fail: Error | null = null;
  onFrame: ((jpeg: Buffer) => void) | null = null;
  private readonly nav = new Set<() => void>();
  private navId = 0;
  /** Runs once as an action starts, after the tool's own look at the page and before the session's check: where a test makes the page move "just now". */
  beforeAct: (() => void) | null = null;

  constructor(readonly proxy: ProxyCredentials) {}

  url(): string { return this.current; }
  navigationId(): number { return this.navId; }
  async title(): Promise<string> { return this.pageTitle; }
  async snapshot(guard?: ActionGuard): Promise<string> {
    this.check(guard);
    if (this.fail) throw this.fail;
    return this.snap;
  }
  async open(url: string): Promise<void> {
    this.act(`open ${url}`);
    this.navigate(url, 'Opened');
  }
  async click(ref: string, double: boolean, guard?: ActionGuard): Promise<void> { this.act(`${double ? 'dblclick' : 'click'} ${ref}`, guard); }
  async type(ref: string, text: string, submit: boolean, guard?: ActionGuard): Promise<void> { this.act(`type ${ref} ${text}${submit ? ' +Enter' : ''}`, guard); }
  async select(ref: string, values: string[], guard?: ActionGuard): Promise<void> { this.act(`select ${ref} ${values.join(',')}`, guard); }
  async press(key: string, guard?: ActionGuard): Promise<void> { this.act(`press ${key}`, guard); }
  async scroll(direction: 'up' | 'down', ref?: string, guard?: ActionGuard): Promise<void> { this.act(`scroll ${direction}${ref ? ` ${ref}` : ''}`, guard); }
  async back(guard?: ActionGuard): Promise<void> { this.act('back', guard); }
  async settle(): Promise<void> {}
  takeNotes(): string[] {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }
  /** How many times the screencast was started. */
  screencastStarts = 0;
  /** Set to hold close() until it settles. */
  closeGate: Promise<void> | null = null;
  async startScreencast(onFrame: (jpeg: Buffer) => void): Promise<void> {
    this.screencastStarts += 1;
    this.onFrame = onFrame;
  }
  async stopScreencast(): Promise<void> { this.onFrame = null; }
  onNavigate(cb: () => void): () => void {
    this.nav.add(cb);
    return () => { this.nav.delete(cb); };
  }
  async close(): Promise<void> {
    await this.closeGate;
    this.closed = true;
  }

  navigate(url: string, title = ''): void {
    this.current = url;
    this.navId = ++navigations;
    this.pageTitle = title;
    for (const cb of this.nav) cb();
  }

  private check(guard: ActionGuard | undefined): void {
    if (!guard) return;
    const site = siteOf(this.current);
    if (site !== guard.site || (guard.navId !== undefined && guard.navId !== this.navId)) throw new PageMovedError(site);
  }

  private act(what: string, guard?: ActionGuard): void {
    if (this.fail) throw this.fail;
    const hook = this.beforeAct;
    this.beforeAct = null;
    hook?.();
    this.check(guard);
    this.actions.push(what);
  }
}

export class FakeFactory implements SessionFactory {
  readonly sessions: FakeSession[] = [];
  shutdowns = 0;
  /** Set to hold shutdown() until it settles, as a slow Chromium exit would. */
  shutdownGate: Promise<void> | null = null;
  /** Set to hold open() until it settles. */
  openGate: Promise<void> | null = null;
  /** Set to make the next open() fail. */
  failNextOpen: Error | null = null;
  async open(proxy: ProxyCredentials): Promise<BrowserSession> {
    await this.openGate;
    if (this.failNextOpen) {
      const err = this.failNextOpen;
      this.failNextOpen = null;
      throw err;
    }
    const session = new FakeSession(proxy);
    this.sessions.push(session);
    return session;
  }
  async shutdown(): Promise<void> {
    this.shutdowns += 1;
    await this.shutdownGate;
  }
}

/** A promise you settle by hand. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** A stand-in for startEgressProxy that keeps the options the manager gave it. */
export function fakeProxy(): { start: (o: EgressProxyOptions) => Promise<EgressProxy>; options: () => EgressProxyOptions; closes: () => number; starts: () => number } {
  let given: EgressProxyOptions | null = null;
  let closes = 0;
  let starts = 0;
  return {
    // Each start gets its own address (the first is :9), so a session can be traced to its proxy.
    start: async (o) => {
      given = o;
      starts += 1;
      return { server: `http://127.0.0.1:${8 + starts}`, password: 'pw', close: async () => { closes += 1; } };
    },
    starts: () => starts,
    options: () => {
      if (!given) throw new Error('The proxy was never started.');
      return given;
    },
    closes: () => closes,
  };
}
