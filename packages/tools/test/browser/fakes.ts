import type { EgressProxy, EgressProxyOptions } from '../../src/browser/proxy.js';
import type { BrowserSession, ProxyCredentials, SessionFactory } from '../../src/browser/session.js';

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

  constructor(readonly proxy: ProxyCredentials) {}

  url(): string { return this.current; }
  async title(): Promise<string> { return this.pageTitle; }
  async snapshot(): Promise<string> {
    if (this.fail) throw this.fail;
    return this.snap;
  }
  async open(url: string): Promise<void> {
    this.act(`open ${url}`);
    this.navigate(url, 'Opened');
  }
  async click(ref: string, double: boolean): Promise<void> { this.act(`${double ? 'dblclick' : 'click'} ${ref}`); }
  async type(ref: string, text: string, submit: boolean): Promise<void> { this.act(`type ${ref} ${text}${submit ? ' +Enter' : ''}`); }
  async select(ref: string, values: string[]): Promise<void> { this.act(`select ${ref} ${values.join(',')}`); }
  async press(key: string): Promise<void> { this.act(`press ${key}`); }
  async scroll(direction: 'up' | 'down', ref?: string): Promise<void> { this.act(`scroll ${direction}${ref ? ` ${ref}` : ''}`); }
  async back(): Promise<void> { this.act('back'); }
  async settle(): Promise<void> {}
  takeNotes(): string[] {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }
  async startScreencast(onFrame: (jpeg: Buffer) => void): Promise<void> { this.onFrame = onFrame; }
  async stopScreencast(): Promise<void> { this.onFrame = null; }
  onNavigate(cb: () => void): () => void {
    this.nav.add(cb);
    return () => { this.nav.delete(cb); };
  }
  async close(): Promise<void> { this.closed = true; }

  navigate(url: string, title = ''): void {
    this.current = url;
    this.pageTitle = title;
    for (const cb of this.nav) cb();
  }

  private act(what: string): void {
    if (this.fail) throw this.fail;
    this.actions.push(what);
  }
}

export class FakeFactory implements SessionFactory {
  readonly sessions: FakeSession[] = [];
  shutdowns = 0;
  async open(proxy: ProxyCredentials): Promise<BrowserSession> {
    const session = new FakeSession(proxy);
    this.sessions.push(session);
    return session;
  }
  async shutdown(): Promise<void> { this.shutdowns += 1; }
}

/** A stand-in for startEgressProxy that keeps the options the manager gave it. */
export function fakeProxy(): { start: (o: EgressProxyOptions) => Promise<EgressProxy>; options: () => EgressProxyOptions; closes: () => number } {
  let given: EgressProxyOptions | null = null;
  let closes = 0;
  return {
    start: async (o) => {
      given = o;
      return { server: 'http://127.0.0.1:9', password: 'pw', close: async () => { closes += 1; } };
    },
    options: () => {
      if (!given) throw new Error('The proxy was never started.');
      return given;
    },
    closes: () => closes,
  };
}
