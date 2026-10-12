/** The credentials the browser uses to reach Grunt's egress proxy (one user per chat). */
export interface ProxyCredentials {
  server: string;
  username: string;
  password: string;
}

/**
 * What a call was approved against. The session checks it itself, in the same
 * synchronous step as it hands the action to the browser, so a page that moved
 * after the approval (a redirect, a script, the history API) is never acted on.
 */
export interface ActionGuard {
  /** The website the call was approved for; the page's committed URL must still be on it. */
  site: string;
  /** The navigation the call was described on; when set, the page must not have navigated since (reads leave it out). */
  navId?: number;
}

/** One chat's page, as the manager and the tool see it. The Playwright-backed version lives in chromium.ts. */
export interface BrowserSession {
  url(): string;
  /**
   * Counts the main frame's navigations (same-document ones, like the history
   * API, included). Increases with every navigation and never repeats, across
   * sessions too, so an id seen once can't match a different page later.
   */
  navigationId(): number;
  title(): Promise<string>;
  /** The page's accessibility snapshot (`ariaSnapshot({ mode: 'ai' })`), whole. */
  snapshot(guard?: ActionGuard): Promise<string>;
  open(url: string): Promise<void>;
  click(ref: string, double: boolean, guard?: ActionGuard): Promise<void>;
  type(ref: string, text: string, submit: boolean, guard?: ActionGuard): Promise<void>;
  select(ref: string, values: string[], guard?: ActionGuard): Promise<void>;
  press(key: string, guard?: ActionGuard): Promise<void>;
  scroll(direction: 'up' | 'down', ref?: string, guard?: ActionGuard): Promise<void>;
  back(guard?: ActionGuard): Promise<void>;
  /** Waits for the `load` state, at most 3 s; never throws. */
  settle(): Promise<void>;
  /** What the page did since the last call (popups closed, dialogs dismissed, ...); reading clears them. */
  takeNotes(): string[];
  startScreencast(onFrame: (jpeg: Buffer) => void): Promise<void>;
  stopScreencast(): Promise<void>;
  /** Called after each main-frame navigation; returns an unsubscribe function. */
  onNavigate(cb: () => void): () => void;
  close(): Promise<void>;
}

/** Starts the one Chromium per server and opens a context in it for each chat. */
export interface SessionFactory {
  open(proxy: ProxyCredentials): Promise<BrowserSession>;
  shutdown(): Promise<void>;
}

/** A ref the page no longer has (spec: "e12 isn't on the page any more: take a new snapshot."). */
export class StaleRefError extends Error {
  constructor(readonly ref: string) {
    super(`${ref} isn't on the page any more: take a new snapshot.`);
    this.name = 'StaleRefError';
  }
}

/** The page is no longer where the call was approved: another website, or (for a mutating call) another page. */
export class PageMovedError extends Error {
  constructor(readonly site: string | null) {
    super(`The page moved to ${site ?? 'a blank page'} since this was approved. Nothing was done: ask again.`);
    this.name = 'PageMovedError';
  }
}

/** Another reply holds the chat's browser, or every browser slot is held. */
export class BrowserBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserBusyError';
  }
}

/** No Chromium could be started; the message says what to install. */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}
