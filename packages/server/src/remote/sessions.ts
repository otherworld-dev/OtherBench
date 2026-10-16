import { createHash, randomBytes } from 'node:crypto';

/** spec 2026-10-12-remote-access §2: 12 hours, or 30 days with "Keep me signed in on this device". No idle timeout. */
export const SESSION_MS = 12 * 60 * 60_000;
export const REMEMBER_MS = 30 * 24 * 60 * 60_000;
export const MAX_SESSIONS = 100;
export const SWEEP_MS = 60_000;

export interface Session {
  createdAt: number;
  expiresAt: number;
  remember: boolean;
  /** The password file's epoch when it was made: a password change ends it. */
  epoch: string;
  address: string | null;
  userAgent: string | null;
}

export interface NewSession {
  remember: boolean;
  epoch: string;
  address: string | null;
  userAgent: string | null;
}

const digest = (id: string): string => createHash('sha256').update(id).digest('hex');

/**
 * Signed-in browsers, in this process's memory only: a restart signs every
 * device out (spec, "Decided without Adam"). Only each id's SHA-256 is kept,
 * so a heap dump doesn't hand out usable cookies.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly now: () => number;
  private readonly max: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { now?: () => number; max?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.max = opts.max ?? MAX_SESSIONS;
  }

  get size(): number {
    return this.sessions.size;
  }

  create(input: NewSession): { id: string; session: Session } {
    while (this.sessions.size >= this.max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.endKey(oldest);
    }
    const now = this.now();
    const id = randomBytes(32).toString('base64url');
    const session: Session = { ...input, createdAt: now, expiresAt: now + (input.remember ? REMEMBER_MS : SESSION_MS) };
    this.sessions.set(digest(id), session);
    return { id, session };
  }

  /** The session, or null when there's none or it has expired (which ends it). */
  get(id: string): Session | null {
    const key = digest(id);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (this.now() >= session.expiresAt) {
      this.endKey(key);
      return null;
    }
    return session;
  }

  end(id: string): void {
    this.endKey(digest(id));
  }

  endAll(): void {
    for (const key of [...this.sessions.keys()]) this.endKey(key);
  }

  /** `cb` runs once when the session ends, however it ends. Returns the unsubscribe. */
  onEnd(id: string, cb: () => void): () => void {
    const key = digest(id);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);
    return () => {
      const current = this.listeners.get(key);
      current?.delete(cb);
      if (current && current.size === 0) this.listeners.delete(key);
    };
  }

  /** Ends expired sessions and, when `currentEpoch` is given, any made under another password. */
  sweep(currentEpoch?: string | null): void {
    const now = this.now();
    for (const [key, session] of [...this.sessions]) {
      if (now >= session.expiresAt || (currentEpoch !== undefined && session.epoch !== currentEpoch)) this.endKey(key);
    }
  }

  /** Sweeps once a minute, so open streams close when their session expires. The timer doesn't keep the process alive. */
  startSweeping(currentEpoch: () => string | null): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(currentEpoch()), SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private endKey(key: string): void {
    this.sessions.delete(key);
    const set = this.listeners.get(key);
    this.listeners.delete(key);
    for (const cb of set ?? []) {
      try {
        cb();
      } catch (err) {
        console.error('[otherbench-server] a session-end listener failed:', err);
      }
    }
  }
}
