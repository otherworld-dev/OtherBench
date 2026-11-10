import { randomBytes } from 'node:crypto';
import { browserHostDenial, isPublicAddress, siteOf } from '@otherbench/core/domain/browser-hosts.js';
import { MAX_CONCURRENT_SUBAGENTS } from '@otherbench/core/domain/subagent.js';
import { startEgressProxy, type EgressProxy, type EgressProxyOptions } from './proxy.js';
import { BrowserBusyError, type BrowserInput, type BrowserSession, type SessionFactory } from './session.js';

/** A page closes after this long with no command. */
export const CHAT_IDLE_MS = 15 * 60_000;
/** The Chromium process closes this long after the last page closes. */
export const BROWSER_IDLE_MS = 5 * 60_000;
/**
 * At most this many pages are open at once, across every chat: each chat's
 * own and each of its sub-agents'. Each is a context and a window in the one
 * Chromium, so this is the cap on what the browser costs in memory.
 */
export const MAX_OPEN_BROWSERS = 8;
/** At most this many pages per chat: its own, and one for each sub-agent a reply may run at once. */
export const MAX_CHAT_PAGES = 1 + MAX_CONCURRENT_SUBAGENTS;
export const BUSY_MESSAGE = "This chat's browser is in use by another reply.";
const fullMessage = (max: number): string => `${max} browser pages are already open and in use. Try again when one of those replies or sub-agents finishes.`;
const chatFullMessage = (max: number): string =>
  `This chat already has ${max} browser pages open and in use (its own and its sub-agents'). Try again when a sub-agent finishes.`;

/** The id of a chat's own page, the one its replies use. A sub-agent's page has an id of its own (`isPageId`). */
export const MAIN_PAGE = 'main';
/** A page id as the routes take it: the chat's own page, or the random hex id of one of its sub-agents' pages. */
export function isPageId(value: unknown): value is string {
  return typeof value === 'string' && (value === MAIN_PAGE || /^[0-9a-f]{16}$/.test(value));
}

/**
 * Whose page a call uses. A chat id alone is the chat's own page. A tool
 * call's context picks the same page, unless it carries a sub-agent's tag:
 * then it is that sub-agent's own page, keyed on the reply and the
 * sub-agent's call id, so sub-agents running at once never share one, and
 * none shares the reply's.
 */
export type PageOwner = string | { chatId: string; messageId: string; subagent?: { callId: string; label: string } | undefined };

/** One of a chat's open pages, as the panel lists them. */
export interface BrowserPageSummary {
  /** What the routes take as `page`: MAIN_PAGE, or a sub-agent page's own id. */
  id: string;
  /** The sub-agent's label (the parent model's words, so the panel cleans them), or null for the chat's own page. */
  subagent: string | null;
  /** The site the page is on. */
  host: string | null;
}

export interface BrowserState {
  open: boolean;
  url: string | null;
  title: string | null;
  host: string | null;
  /** The reply (message id) holding the browser, or null. */
  holder: string | null;
  /** The browser is a real window on the machine running this chat. */
  visible: boolean;
  /** The page this state is about. */
  page: string;
  /** Every page the chat has open: its own first, then its sub-agents' in the order they opened. */
  pages: BrowserPageSummary[];
}
export const CLOSED_STATE: BrowserState = { open: false, url: null, title: null, host: null, holder: null, visible: false, page: MAIN_PAGE, pages: [] };

/** One live-view frame: a server-wide sequence number and the JPEG as base64. */
export interface BrowserFrame {
  seq: number;
  jpeg: string;
}

/** One page (a chat's own, or one of its sub-agents'), as the tool uses it. */
export interface ChatBrowser {
  readonly chatId: string;
  /** MAIN_PAGE, or this sub-agent page's own id. */
  readonly pageId: string;
  /** The sub-agent this page belongs to (its label), or null for the chat's own page. */
  readonly subagent: string | null;
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
  /** Pages open at once across every chat; MAX_OPEN_BROWSERS by default. */
  maxOpen?: number;
  /** Pages open at once in one chat; MAX_CHAT_PAGES by default. */
  maxChatPages?: number;
}

interface Holder {
  messageId: string;
  signal: AbortSignal;
  release: () => void;
}

interface Watcher {
  /** The page this watcher is shown. Every watcher of a chat gets its states, since each carries the chat's list of pages. */
  page: string;
  onFrame(frame: BrowserFrame): void;
  onState(state: BrowserState): void;
}

/** Where a page owner's page lives: its chat, its key among every open page, and its sub-agent's label. */
interface Slot {
  chatId: string;
  key: string;
  subagent: string | null;
}

/**
 * The slot of a page owner. The key joins its parts with NUL, which no chat id,
 * message id or call id holds, so two owners never share a key by accident.
 */
function slotOf(owner: PageOwner): Slot {
  if (typeof owner === 'string') return { chatId: owner, key: `${owner}\u0000${MAIN_PAGE}`, subagent: null };
  if (!owner.subagent) return { chatId: owner.chatId, key: `${owner.chatId}\u0000${MAIN_PAGE}`, subagent: null };
  return { chatId: owner.chatId, key: `${owner.chatId}\u0000sub\u0000${owner.messageId}\u0000${owner.subagent.callId}`, subagent: owner.subagent.label };
}

/** A page as the panel lists it. */
function summary(entry: OpenBrowser): BrowserPageSummary {
  return { id: entry.pageId, subagent: entry.subagent, host: siteOf(entry.session.url()) };
}

class OpenBrowser implements ChatBrowser {
  refs = new Map<string, string>();
  refsGen = 0;
  /**
   * The sites the proxy refuses for this page: every list handed in by the
   * calls of the reply in `blockedFor`. A sub-agent has a page of its own and
   * its calls bring the union of its parent's and its own profile's lists;
   * the union here only means a holder's later call with a shorter list can't
   * lift what an earlier one blocked. It starts again when another reply
   * takes the page.
   */
  blockedHosts: readonly string[] = [];
  blockedFor: string | null = null;
  refused = 0;
  holder: Holder | null = null;
  lastUsed = 0;
  title: string | null = null;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  stopNavigate: () => void = () => {};
  stopClosed: () => void = () => {};

  constructor(
    readonly chatId: string,
    readonly key: string,
    readonly pageId: string,
    readonly subagent: string | null,
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
 * context per page, each its own window, in one browser per server, started
 * on first use. A chat has its own page, which its replies use, and each of
 * its sub-agents gets a page of its own (`PageOwner`), so a reply and the
 * sub-agents it starts never tread on each other's refs. Enforces the holder
 * rule (the reply that last acted keeps the chat's page until its turn's
 * signal aborts; a sub-agent's page is only ever its own, and closes when the
 * sub-agent's signal does, since nothing can use it after that), closes idle
 * pages, keeps at most `MAX_CHAT_PAGES` per chat and `MAX_OPEN_BROWSERS` in
 * all, and fans the live view out to watchers. Every page has its own proxy
 * user, so the proxy tells them apart and holds each to its own blocked list.
 */
export class BrowserManager {
  private readonly open = new Map<string, OpenBrowser>();
  private readonly byUser = new Map<string, OpenBrowser>();
  private readonly opening = new Map<string, { chatId: string; promise: Promise<OpenBrowser> }>();
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

  /** The owner's open page, without starting or claiming it. */
  peek(owner: PageOwner): ChatBrowser | null {
    return this.open.get(slotOf(owner).key) ?? null;
  }

  /** The owner's page for this reply, started if need be. Throws BrowserBusyError when another live reply holds it, or no page can be had. */
  async acquire(owner: PageOwner, messageId: string, signal: AbortSignal, blockedHosts: readonly string[]): Promise<ChatBrowser> {
    const slot = slotOf(owner);
    let entry = this.open.get(slot.key);
    if (entry) {
      this.claim(entry, messageId, signal);
    } else {
      let pending = this.opening.get(slot.key)?.promise;
      if (!pending) {
        pending = this.start(slot).finally(() => this.opening.delete(slot.key));
        this.opening.set(slot.key, { chatId: slot.chatId, promise: pending });
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

  /** The state of one of the chat's pages (its own by default), with the list of all of them. */
  state(chatId: string, page: string = MAIN_PAGE): BrowserState {
    const pages = this.pagesOf(chatId);
    const entry = this.pageOf(chatId, page);
    if (!entry) return { ...CLOSED_STATE, page, pages: pages.map(summary) };
    const url = entry.session.url();
    const holder = entry.holder && !entry.holder.signal.aborted ? entry.holder.messageId : null;
    return { open: true, url, title: entry.title, host: siteOf(url), holder, visible: entry.session.visible, page, pages: pages.map(summary) };
  }

  /** Passes on what a person did in the Browser panel. False when the chat has no such page open. */
  async input(chatId: string, event: BrowserInput, page: string = MAIN_PAGE): Promise<boolean> {
    const entry = this.pageOf(chatId, page);
    if (!entry) return false;
    this.touch(entry);
    await entry.session.input(event);
    return true;
  }

  /** Brings a page's window to the person. False when the chat has no such page open. */
  async show(chatId: string, page: string = MAIN_PAGE): Promise<boolean> {
    const entry = this.pageOf(chatId, page);
    if (!entry) return false;
    this.touch(entry);
    await entry.session.reveal();
    return true;
  }

  /** Drops the saved sign-ins and cookie choices. Browsers open now keep theirs until they close, and don't save them. */
  forgetProfile(): Promise<void> {
    return this.options.factory.forgetProfile();
  }

  /**
   * Live view of one of the chat's pages (its own by default): frames while
   * anyone watches it (the screencast runs only then), and every state change
   * in the chat, so the list of pages stays current. Returns an unsubscribe
   * function.
   */
  watch(chatId: string, onFrame: (frame: BrowserFrame) => void, onState: (state: BrowserState) => void, page: string = MAIN_PAGE): () => void {
    const watcher: Watcher = { page, onFrame, onState };
    let set = this.watchers.get(chatId);
    if (!set) {
      set = new Set();
      this.watchers.set(chatId, set);
    }
    set.add(watcher);
    const entry = this.pageOf(chatId, page);
    if (entry && this.watching(entry) === 1) this.startScreencast(entry);
    return () => {
      const current = this.watchers.get(chatId);
      if (!current || !current.delete(watcher)) return;
      if (current.size === 0) this.watchers.delete(chatId);
      const open = this.pageOf(chatId, page);
      if (open && this.watching(open) === 0) void open.session.stopScreencast().catch(() => undefined);
    };
  }

  /**
   * Closes one of the chat's pages, or with no `page` every one of them (the
   * chat closing, or deleted), including any still starting.
   */
  async close(chatId: string, page?: string): Promise<void> {
    // Only wait when a page is still starting: an open one must be detached
    // in this same tick, so nothing can claim it once it is being closed.
    // Only the chat's own page has an id before it opens.
    const starting = [...this.opening.entries()]
      .filter(([key, o]) => o.chatId === chatId && (page === undefined || (page === MAIN_PAGE && key === slotOf(chatId).key)))
      .map(([, o]) => o.promise.catch(() => undefined));
    if (starting.length > 0) await Promise.all(starting);
    const entries = page === undefined ? this.pagesOf(chatId) : [this.pageOf(chatId, page)].filter((e): e is OpenBrowser => e !== null);
    await Promise.all(entries.map((entry) => this.closeEntry(entry)));
  }

  /** Server shutdown: every page, the Chromium process and the proxy. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.opening.values()].map((o) => o.promise.catch(() => undefined)));
    await Promise.all([...this.open.values()].map((entry) => this.closeEntry(entry)));
    clearTimeout(this.browserTimer);
    await this.shutdown();
  }

  /** The chat's open pages: its own first, then its sub-agents' in the order they opened. */
  private pagesOf(chatId: string): OpenBrowser[] {
    const pages = [...this.open.values()].filter((e) => e.chatId === chatId);
    return [...pages.filter((e) => e.subagent === null), ...pages.filter((e) => e.subagent !== null)];
  }

  private pageOf(chatId: string, page: string): OpenBrowser | null {
    for (const entry of this.open.values()) if (entry.chatId === chatId && entry.pageId === page) return entry;
    return null;
  }

  /** How many watchers are shown this page. */
  private watching(entry: OpenBrowser): number {
    let n = 0;
    for (const w of this.watchers.get(entry.chatId) ?? []) if (w.page === entry.pageId) n += 1;
    return n;
  }

  private async closeEntry(entry: OpenBrowser): Promise<void> {
    if (this.open.get(entry.key) !== entry) return;
    this.open.delete(entry.key);
    this.byUser.delete(entry.proxyUser);
    clearTimeout(entry.idleTimer);
    entry.stopNavigate();
    entry.stopClosed();
    if (entry.holder) entry.holder.signal.removeEventListener('abort', entry.holder.release);
    await entry.session.close().catch((err: unknown) => console.warn(`[browser] closing a page of chat ${entry.chatId} failed:`, err));
    this.emitState(entry.chatId);
    if (this.open.size === 0) this.scheduleShutdown();
  }

  private async start(slot: Slot): Promise<OpenBrowser> {
    clearTimeout(this.browserTimer);
    try {
      // A shutdown already under way finishes first: its proxy and Chromium are going away.
      while (this.stopping) await this.stopping;
      await this.makeRoom(slot);
      const proxy = await this.startProxy();
      // Each page is its own proxy user, so the proxy tells pages apart and holds each to its own blocked list.
      const user = randomBytes(12).toString('hex');
      const session = await this.options.factory.open({ server: proxy.server, username: user, password: proxy.password });
      const pageId = slot.subagent === null ? MAIN_PAGE : randomBytes(8).toString('hex');
      const entry = new OpenBrowser(slot.chatId, slot.key, pageId, slot.subagent, session, user);
      this.open.set(slot.key, entry);
      this.byUser.set(user, entry);
      entry.stopNavigate = session.onNavigate(() => this.navigated(entry));
      entry.stopClosed = session.onClosed(() => {
        this.closeEntry(entry).catch((err: unknown) => console.warn(`[browser] closing a page of chat ${slot.chatId} failed:`, err));
      });
      if (this.watching(entry) > 0) this.startScreencast(entry);
      // A new page is news to every watcher of the chat: it joins the list.
      this.emitState(slot.chatId);
      return entry;
    } catch (err) {
      // A failed start may have left the proxy or Chromium running; with nothing else open they still get their turn to close.
      if (this.open.size === 0) this.scheduleShutdown();
      throw err;
    }
  }

  /**
   * Makes room for one more page: at most `maxChatPages` in the chat and
   * `maxOpen` in all. Pages still starting count, so several first uses at
   * once can't overshoot either cap. When a cap is reached the least recently
   * used page nobody holds is closed (one of the chat's own when it is the
   * chat that is full); with none to close, the call is refused.
   */
  private async makeRoom(slot: Slot): Promise<void> {
    const max = this.options.maxOpen ?? MAX_OPEN_BROWSERS;
    const perChat = this.options.maxChatPages ?? MAX_CHAT_PAGES;
    const others = (chatId: string | null): number => {
      let n = 0;
      for (const entry of this.open.values()) if (chatId === null || entry.chatId === chatId) n += 1;
      for (const [key, o] of this.opening) if (key !== slot.key && (chatId === null || o.chatId === chatId)) n += 1;
      return n;
    };
    for (;;) {
      const chatFull = others(slot.chatId) >= perChat;
      if (!chatFull && others(null) < max) return;
      let oldest: OpenBrowser | null = null;
      for (const entry of this.open.values()) {
        if (chatFull && entry.chatId !== slot.chatId) continue;
        if (entry.holder && !entry.holder.signal.aborted) continue;
        if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
      }
      if (!oldest) throw new BrowserBusyError(chatFull ? chatFullMessage(perChat) : fullMessage(max));
      await this.closeEntry(oldest);
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
      // A sub-agent's page is its own: once its signal aborts (the sub-agent
      // finished or was stopped) nothing can use it again, so it closes now
      // rather than holding a slot until it idles out.
      if (entry.subagent !== null) {
        this.closeEntry(entry).catch((err: unknown) => console.warn(`[browser] closing a sub-agent's page of chat ${entry.chatId} failed:`, err));
        return;
      }
      this.emitState(entry.chatId);
    };
    entry.holder = { messageId, signal, release };
    signal.addEventListener('abort', release, { once: true });
    // A signal that aborted while the page was starting never fires again: let go now.
    if (signal.aborted) {
      release();
      return;
    }
    this.emitState(entry.chatId);
  }

  private touch(entry: OpenBrowser): void {
    entry.lastUsed = ++this.uses;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.closeEntry(entry).catch((err: unknown) => console.warn(`[browser] closing an idle page of chat ${entry.chatId} failed:`, err));
    }, this.options.chatIdleMs ?? CHAT_IDLE_MS);
    entry.idleTimer.unref?.();
  }

  private navigated(entry: OpenBrowser): void {
    if (this.open.get(entry.key) !== entry) return;
    this.emitState(entry.chatId);
    void entry.session.title().then(
      (title) => {
        entry.title = title;
        this.emitState(entry.chatId);
      },
      () => undefined
    );
  }

  /** Every watcher of the chat gets the state of the page it is shown, which carries the chat's list of pages. */
  private emitState(chatId: string): void {
    const set = this.watchers.get(chatId);
    if (!set || set.size === 0) return;
    const states = new Map<string, BrowserState>();
    for (const w of [...set]) {
      let state = states.get(w.page);
      if (!state) {
        state = this.state(chatId, w.page);
        states.set(w.page, state);
      }
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
        let frame: BrowserFrame | null = null;
        for (const w of [...set]) {
          if (w.page !== entry.pageId) continue;
          frame ??= { seq: ++this.frames, jpeg: jpeg.toString('base64') };
          try {
            w.onFrame(frame);
          } catch (err) {
            console.error('[browser] a live-view watcher failed:', err);
          }
        }
      })
      .catch((err: unknown) => console.warn(`[browser] the live view of a page of chat ${entry.chatId} couldn't start:`, err));
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
