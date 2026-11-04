import { createHash, randomBytes } from 'node:crypto';
import type { RemoteSession, RemoteSessionRepo } from '@otherbench/core/ports/store.js';
import { deviceLabel } from './device-label.js';

/** spec 2026-10-12-remote-access §2: 12 hours, or 30 days with "Keep me signed in on this device". No idle timeout. */
export const SESSION_MS = 12 * 60 * 60_000;
export const REMEMBER_MS = 30 * 24 * 60 * 60_000;
export const MAX_SESSIONS = 100;
export const SWEEP_MS = 60_000;
/** A session's last-seen time is written at most this often. */
export const SEEN_EVERY_MS = 60_000;

/** A signed-in browser as the server sees it: the stored row without its token's hash. */
export type Session = Omit<RemoteSession, 'tokenHash'>;

export interface NewSession {
  remember: boolean;
  epoch: string;
  address: string | null;
  userAgent: string | null;
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const withoutHash = ({ tokenHash: _hash, ...session }: RemoteSession): Session => session;

/**
 * Signed-in browsers, kept in the database (`remote_session`, migration 037)
 * so a restart keeps them signed in. The table never syncs to a paired
 * machine. The cookie's token is never stored: only its SHA-256, so neither
 * the database file nor a heap dump hands out a usable cookie. A session is
 * found by its token's hash; that lookup isn't constant-time, but the token is
 * 256 random bits and the hash is a one-way function of it, so its timing
 * tells nothing that helps make a cookie. Each session also has a random `id`
 * that isn't its token, for the devices list and Sign out.
 */
export class SessionStore {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly now: () => number;
  private readonly max: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repo: RemoteSessionRepo,
    opts: { now?: () => number; max?: number } = {}
  ) {
    this.now = opts.now ?? Date.now;
    this.max = opts.max ?? MAX_SESSIONS;
  }

  get size(): number {
    return this.repo.count();
  }

  /** A new session; `id` here is the cookie's token, returned once and never kept. */
  create(input: NewSession): { id: string; session: Session } {
    while (this.repo.count() >= this.max) {
      const oldest = this.repo.list()[0];
      if (!oldest) break;
      this.endKey(oldest.tokenHash);
    }
    const now = this.now();
    const token = randomBytes(32).toString('base64url');
    const row: RemoteSession = {
      id: randomBytes(12).toString('base64url'),
      tokenHash: digest(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + (input.remember ? REMEMBER_MS : SESSION_MS),
      remember: input.remember,
      epoch: input.epoch,
      address: input.address,
      deviceLabel: deviceLabel(input.userAgent),
    };
    this.repo.insert(row);
    return { id: token, session: withoutHash(row) };
  }

  /**
   * The session the token names, or null when there's none or it has expired
   * (which ends it). Notes it as seen, writing at most once a minute.
   */
  get(token: string): Session | null {
    const key = digest(token);
    const row = this.repo.byTokenHash(key);
    if (!row) return null;
    const now = this.now();
    if (now >= row.expiresAt) {
      this.endKey(key);
      return null;
    }
    if (now - row.lastSeenAt >= SEEN_EVERY_MS) {
      try {
        this.repo.touch(row.id, now);
        row.lastSeenAt = now;
      } catch (err) {
        // Only a label in the devices list: not worth failing the request over.
        console.error('[otherbench-server] could not note a session as seen:', err);
      }
    }
    return withoutHash(row);
  }

  /** Every live session made under `currentEpoch`, oldest first (expired and old-password ones are ended first). */
  list(currentEpoch: string | null): Session[] {
    this.sweep(currentEpoch);
    return this.repo.list().map(withoutHash);
  }

  end(token: string): void {
    this.endKey(digest(token));
  }

  /** Ends the session with this `id` (not its token). Whether there was one. */
  endById(id: string): boolean {
    const row = this.repo.get(id);
    if (!row) return false;
    this.endKey(row.tokenHash);
    return true;
  }

  endAll(): void {
    for (const row of this.repo.list()) this.endKey(row.tokenHash);
  }

  /** `cb` runs once when the session ends, however it ends. Returns the unsubscribe. */
  onEnd(token: string, cb: () => void): () => void {
    const key = digest(token);
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
    for (const row of this.repo.list()) {
      if (now >= row.expiresAt || (currentEpoch !== undefined && row.epoch !== currentEpoch)) this.endKey(row.tokenHash);
    }
  }

  /**
   * Sweeps now (rows that expired while the server was off, or made under a
   * password changed meanwhile) and then once a minute, so open streams close
   * when their session expires. The timer doesn't keep the process alive.
   */
  startSweeping(currentEpoch: () => string | null): void {
    if (this.timer) return;
    const sweep = (): void => {
      try {
        this.sweep(currentEpoch());
      } catch (err) {
        console.error('[otherbench-server] the session sweep failed:', err);
      }
    };
    sweep();
    this.timer = setInterval(sweep, SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private endKey(key: string): void {
    const row = this.repo.byTokenHash(key);
    if (row) this.repo.delete(row.id);
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
