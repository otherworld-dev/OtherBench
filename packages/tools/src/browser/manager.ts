import { randomBytes } from 'node:crypto';
import { browserHostDenial, isPublicAddress, siteOf } from '@otherbench/core/domain/browser-hosts.js';
import { startEgressProxy, type EgressProxy, type EgressProxyOptions } from './proxy.js';
import { BrowserBusyError, type BrowserSession, type SessionFactory } from './session.js';

/** A chat's browser closes after this long with no command. */
export const CHAT_IDLE_MS = 15 * 60_000;
/** The Chromium process closes this long after the last chat's browser closes. */
export const BROWSER_IDLE_MS = 5 * 60_000;
/** At most this many chats have a browser open at once. */
export const MAX_OPEN_BROWSERS = 4;
export const BUSY_MESSAGE = "This chat's browser is in use by another reply.";
const FULL_MESSAGE = 'Four chats already have a browser open and in use. Try again when one of those replies finishes.';

export interface BrowserState {
  open: boolean;
  url: string | null;
  title: string | null;
  host: string | null;
  /** The reply (message id) holding the browser, or null. */
  holder: string | null;
}
export const CLOSED_STATE: BrowserState = { open: false, url: null, title: null, host: null, holder: null };

/** One live-view frame: a server-wide sequence number and the JPEG as base64. */
export interface BrowserFrame {
  seq: number;
  jpeg: string;
}

/** One chat's browser, as the tool uses it. */
export interface ChatBrowser {
  readonly chatId: string;
  readonly session: BrowserSession;
  /** Each ref's line in the latest snapshot (so a card can say what `click e12` points at). */
  refs: Map<string, string>;
  /** Which snapshot `refs` came from: counts up each time they are replaced, so a ref described against an older one can be told apart. */
  refsGen: number;
  /** The page's notes since the last result, plus how many requests the proxy refused. Reading clears them. */
  takeNotes(): string[];
}

export interface BrowserManagerOptions {
  factory: SessionFactory;
  /** Tests only (OTHERBENCH_BROWSER_ALLOW_LOOPBACK_PORTS). 127.0.0.1 may be reached on these ports and nothing else local. */
  allowLoopbackPorts?: readonly number[];
  /** Defaults to startEgressProxy; tests pass a fake. */
  startProxy?: (options: EgressProxyOptions) => Promise<EgressProxy>;
  chatIdleMs?: number;
  browserIdleMs?: number;
  maxOpen?: number;
}

interface Holder {
  messageId: string;
  signal: AbortSignal;
  release: () => void;
}

interface Watcher {
  onFrame(frame: BrowserFrame): void;
  onState(state: BrowserState): void;
}

class OpenBrowser implements ChatBrowser {
  refs = new Map<string, string>();
  refsGen = 0;
  /**
   * The sites the proxy refuses for this browser: every list handed in by the
   * calls of the reply in `blockedFor`. A sub-agent's calls come in under its
   * parent reply's message id with a longer list (its own profile's blocked
   * sites added to the parent's), and the two can call at the same moment; the
   * union means neither call can lift what the other blocks. It starts again
   * when another reply takes the browser.
   */
  blockedHosts: readonly string[] = [];
  blockedFor: string | null = null;
  refused = 0;
  holder: Holder | null = null;
  lastUsed = 0;
  title: string | null = null;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  stopNavigate: () => void = () => {};

  constructor(
    readonly chatId: string,
    readonly session: BrowserSession,
    readonly proxyUser: string
  ) {}

  takeNotes(): string[] {
    const notes = this.session.takeNotes();
    if (this.refused === 1) notes.push('1 request to a blocked or local address was refused.');
    else if (this.refused > 1) notes.push(`${this.refused} requests to blocked or local addresses were refused.`);
    this.refused = 0;
    return notes;
  }
}

/**
 * The model's browsers (spec 2026-10-12-model-browser-design §2): one
 * in-memory context per chat in one headless Chromium per server, started on
 * first use. Enforces the holder rule (the reply that last acted keeps the
 * chat's browser until its turn's signal aborts), closes idle ones, keeps at
 * most four, and fans the live view out to watchers.
 */
export class BrowserManager {
  private readonly open = new Map<string, OpenBrowser>();
  private readonly byUser = new Map<string, OpenBrowser>();
  private readonly opening = new Map<string, Promise<OpenBrowser>>();
  private readonly watchers = new Map<string, Set<Watcher>>();
  private proxy: Promise<EgressProxy> | null = null;
  /** A shutdown in progress; starting a browser waits for it. */
  private stopping: Promise<void> | null = null;
  private browserTimer: ReturnType<typeof setTimeout> | undefined;
  private uses = 0;
  private frames = 0;
  private readonly loopback: readonly number[];

  constructor(private readonly options: BrowserManagerOptions) {
    this.loopback = options.allowLoopbackPorts ?? [];
  }

  /** The chat's open browser, without starting or claiming it. */
  peek(chatId: string): ChatBrowser | null {
    return this.open.get(chatId) ?? null;
  }

  /** The chat's browser for this reply, started if need be. Throws BrowserBusyError when another live reply holds it. */
  async acquire(chatId: string, messageId: string, signal: AbortSignal, blockedHosts: readonly string[]): Promise<ChatBrowser> {
    let entry = this.open.get(chatId);
    if (entry) {
      this.claim(entry, messageId, signal);
    } else {
      let pending = this.opening.get(chatId);
      if (!pending) {
        pending = this.start(chatId).finally(() => this.opening.delete(chatId));
        this.opening.set(chatId, pending);
      }
      entry = await pending;
      this.claim(entry, messageId, signal);
    }
    if (entry.blockedFor !== messageId) {
      entry.blockedFor = messageId;
      entry.blockedHosts = [];
    }
    entry.blockedHosts = [...new Set([...entry.blockedHosts, ...blockedHosts])];
    this.touch(entry);
    return entry;
  }

  state(chatId: string): BrowserState {
    const entry = this.open.get(chatId);
    if (!entry) return CLOSED_STATE;
    const url = entry.session.url();
    const holder = entry.holder && !entry.holder.signal.aborted ? entry.holder.messageId : null;
    return { open: true, url, title: entry.title, host: siteOf(url), holder };
  }

  /** Live view: frames while anyone watches (the screencast runs only then), and every state change. Returns an unsubscribe function. */
  watch(chatId: string, onFrame: (frame: BrowserFrame) => void, onState: (state: BrowserState) => void): () => void {
    const watcher: Watcher = { onFrame, onState };
    let set = this.watchers.get(chatId);
    if (!set) {
      set = new Set();
      this.watchers.set(chatId, set);
    }
    set.add(watcher);
    const entry = this.open.get(chatId);
    if (entry && set.size === 1) this.startScreencast(entry);
    return () => {
      const current = this.watchers.get(chatId);
      if (!current || !current.delete(watcher) || current.size > 0) return;
      this.watchers.delete(chatId);
      const open = this.open.get(chatId);
      if (open) void open.session.stopScreencast().catch(() => undefined);
    };
  }

  async close(chatId: string): Promise<void> {
    // Only wait when the browser is still starting: an open one must be detached
    // in this same tick, so nothing can claim it once it is being closed.
    const starting = this.opening.get(chatId);
    if (starting) await starting.catch(() => undefined);
    const entry = this.open.get(chatId);
    if (!entry) return;
    this.open.delete(chatId);
    this.byUser.delete(entry.proxyUser);
    clearTimeout(entry.idleTimer);
    entry.stopNavigate();
    if (entry.holder) entry.holder.signal.removeEventListener('abort', entry.holder.release);
    await entry.session.close().catch((err: unknown) => console.warn(`[browser] closing chat ${chatId}'s browser failed:`, err));
    this.emitState(chatId);
    if (this.open.size === 0) this.scheduleShutdown();
  }

  /** Server shutdown: every chat's browser, the Chromium process and the proxy. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.opening.values()].map((p) => p.catch(() => undefined)));
    await Promise.all([...this.open.keys()].map((id) => this.close(id)));
    clearTimeout(this.browserTimer);
    await this.shutdown();
  }

  private async start(chatId: string): Promise<OpenBrowser> {
    clearTimeout(this.browserTimer);
    try {
      // A shutdown already under way finishes first: its proxy and Chromium are going away.
      while (this.stopping) await this.stopping;
      await this.makeRoom(chatId);
      const proxy = await this.startProxy();
      const user = randomBytes(12).toString('hex');
      const session = await this.options.factory.open({ server: proxy.server, username: user, password: proxy.password });
      const entry = new OpenBrowser(chatId, session, user);
      this.open.set(chatId, entry);
      this.byUser.set(user, entry);
      entry.stopNavigate = session.onNavigate(() => this.navigated(entry));
      if ((this.watchers.get(chatId)?.size ?? 0) > 0) this.startScreencast(entry);
      return entry;
    } catch (err) {
      // A failed start may have left the proxy or Chromium running; with nothing else open they still get their turn to close.
      if (this.open.size === 0) this.scheduleShutdown();
      throw err;
    }
  }

  private async makeRoom(chatId: string): Promise<void> {
    const max = this.options.maxOpen ?? MAX_OPEN_BROWSERS;
    // Other browsers still starting hold a slot too, so several first uses at once can't overshoot the cap.
    const others = (): number => this.open.size + this.opening.size - (this.opening.has(chatId) ? 1 : 0);
    while (others() >= max) {
      let oldest: OpenBrowser | null = null;
      for (const entry of this.open.values()) {
        if (entry.holder && !entry.holder.signal.aborted) continue;
        if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
      }
      if (!oldest) throw new BrowserBusyError(FULL_MESSAGE);
      await this.close(oldest.chatId);
    }
  }

  private claim(entry: OpenBrowser, messageId: string, signal: AbortSignal): void {
    const held = entry.holder;
    if (held && !held.signal.aborted && held.messageId !== messageId) throw new BrowserBusyError(BUSY_MESSAGE);
    if (held && held.messageId === messageId && held.signal === signal) return;
    if (held) held.signal.removeEventListener('abort', held.release);
    const release = (): void => {
      if (entry.holder?.release !== release) return;
      entry.holder = null;
      this.emitState(entry.chatId);
    };
    entry.holder = { messageId, signal, release };
    signal.addEventListener('abort', release, { once: true });
    this.emitState(entry.chatId);
  }

  private touch(entry: OpenBrowser): void {
    entry.lastUsed = ++this.uses;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.close(entry.chatId).catch((err: unknown) => console.warn(`[browser] closing idle chat ${entry.chatId}'s browser failed:`, err));
    }, this.options.chatIdleMs ?? CHAT_IDLE_MS);
    entry.idleTimer.unref?.();
  }

  private navigated(entry: OpenBrowser): void {
    if (this.open.get(entry.chatId) !== entry) return;
    this.emitState(entry.chatId);
    void entry.session.title().then(
      (title) => {
        entry.title = title;
        this.emitState(entry.chatId);
      },
      () => undefined
    );
  }

  private emitState(chatId: string): void {
    const set = this.watchers.get(chatId);
    if (!set || set.size === 0) return;
    const state = this.state(chatId);
    for (const w of set) {
      try {
        w.onState(state);
      } catch (err) {
        console.error('[browser] a live-view watcher failed:', err);
      }
    }
  }

  private startScreencast(entry: OpenBrowser): void {
    void entry.session
      .startScreencast((jpeg) => {
        const set = this.watchers.get(entry.chatId);
        if (!set || set.size === 0) return;
        const frame: BrowserFrame = { seq: ++this.frames, jpeg: jpeg.toString('base64') };
        for (const w of set) {
          try {
            w.onFrame(frame);
          } catch (err) {
            console.error('[browser] a live-view watcher failed:', err);
          }
        }
      })
      .catch((err: unknown) => console.warn(`[browser] the live view of chat ${entry.chatId} couldn't start:`, err));
  }

  private startProxy(): Promise<EgressProxy> {
    if (!this.proxy) {
      const start = this.options.startProxy ?? startEgressProxy;
      const loopback = this.loopback;
      const proxyOptions: EgressProxyOptions = {
        check: (user, host, port) => {
          const entry = this.byUser.get(user);
          if (!entry) return 'This browser session has ended.';
          return browserHostDenial(host, { browserBlockedHosts: entry.blockedHosts }, { allowLoopbackPorts: loopback, port });
        },
        onRefused: (user) => {
          const entry = this.byUser.get(user);
          if (entry) entry.refused += 1;
        },
      };
      // Without configured loopback ports the proxy keeps its own default
      // (public addresses only); there is no permissive override to pass.
      if (loopback.length > 0) {
        proxyOptions.allowLoopbackPorts = loopback;
        // The one local address a test fixture lives on: 127.0.0.1, on a configured port. Nothing else local or private.
        proxyOptions.addressAllowed = (ip, port) => isPublicAddress(ip) || (ip === '127.0.0.1' && loopback.includes(port));
      }
      const started = start(proxyOptions);
      this.proxy = started;
      started.catch(() => {
        if (this.proxy === started) this.proxy = null;
      });
    }
    return this.proxy;
  }

  private scheduleShutdown(): void {
    clearTimeout(this.browserTimer);
    this.browserTimer = setTimeout(() => {
      if (this.open.size > 0 || this.opening.size > 0) return;
      this.shutdown().catch((err: unknown) => console.warn('[browser] stopping the browser failed:', err));
    }, this.options.browserIdleMs ?? BROWSER_IDLE_MS);
    this.browserTimer.unref?.();
  }

  /**
   * Stops Chromium and the proxy. The proxy is detached here, in this tick, so a
   * browser started meanwhile gets a new one (it also waits for `stopping`
   * before starting anything). Never rejects.
   */
  private shutdown(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = null;
    const previous = this.stopping;
    const stop = async (): Promise<void> => {
      await this.options.factory.shutdown().catch((err: unknown) => console.warn('[browser] stopping the browser failed:', err));
      const started = proxy ? await proxy.catch(() => null) : null;
      await started?.close().catch((err: unknown) => console.warn('[browser] stopping the proxy failed:', err));
    };
    const running = previous ? previous.then(stop) : stop();
    const tracked: Promise<void> = running.finally(() => {
      if (this.stopping === tracked) this.stopping = null;
    });
    this.stopping = tracked;
    return tracked;
  }
}
