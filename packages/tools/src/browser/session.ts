/** The credentials the browser uses to reach Grunt's egress proxy (one user per chat). */
export interface ProxyCredentials {
  server: string;
  username: string;
  password: string;
}

/** One chat's page, as the manager and the tool see it. The Playwright-backed version lives in chromium.ts. */
export interface BrowserSession {
  url(): string;
  title(): Promise<string>;
  /** The page's accessibility snapshot (`ariaSnapshot({ mode: 'ai' })`), whole. */
  snapshot(): Promise<string>;
  open(url: string): Promise<void>;
  click(ref: string, double: boolean): Promise<void>;
  type(ref: string, text: string, submit: boolean): Promise<void>;
  select(ref: string, values: string[]): Promise<void>;
  press(key: string): Promise<void>;
  scroll(direction: 'up' | 'down', ref?: string): Promise<void>;
  back(): Promise<void>;
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
