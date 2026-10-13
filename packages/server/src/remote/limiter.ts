/**
 * Slows password guessing (spec 2026-10-12-remote-access, "Rate limit").
 * Per address: 5 failures in 15 minutes lock it for 15 minutes, and while
 * locked even the right password is refused. Globally: 100 failures in an
 * hour close sign-in for everyone for the rest of that hour. This trades
 * guessing for denial of service, on purpose (spec §8).
 */
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;
export const GLOBAL_MAX_FAILURES = 100;
export const GLOBAL_WINDOW_MS = 60 * 60_000;
export const MAX_TRACKED = 10_000;
export const MAX_CONCURRENT_CHECKS = 2;

export type LimitCheck = { ok: true } | { ok: false; retryAfterSec: number };

interface Entry {
  failures: number[];
  lockedUntil: number;
}

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/** The 429 text for a lock: whole minutes, rounded up. */
export function tooManyMessage(retryAfterSec: number): string {
  const minutes = Math.ceil(retryAfterSec / 60);
  return minutes <= 1 ? 'Too many tries. Try again in a minute.' : `Too many tries. Try again in ${minutes} minutes.`;
}

export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();
  private globalStart = Number.NEGATIVE_INFINITY;
  private globalFailures = 0;
  private running = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxTracked: number;

  constructor(opts: { now?: () => number; log?: (line: string) => void; maxTracked?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    this.maxTracked = opts.maxTracked ?? MAX_TRACKED;
  }

  check(address: string): LimitCheck {
    const now = this.now();
    const globalUntil = this.globalStart + GLOBAL_WINDOW_MS;
    if (this.globalFailures >= GLOBAL_MAX_FAILURES && now < globalUntil) return { ok: false, retryAfterSec: seconds(globalUntil - now) };
    const entry = this.entries.get(address);
    if (entry && entry.lockedUntil > now) return { ok: false, retryAfterSec: seconds(entry.lockedUntil - now) };
    return { ok: true };
  }

  fail(address: string): void {
    const now = this.now();
    if (now >= this.globalStart + GLOBAL_WINDOW_MS) {
      this.globalStart = now;
      this.globalFailures = 0;
    }
    this.globalFailures += 1;
    if (this.globalFailures === GLOBAL_MAX_FAILURES) {
      const until = new Date(this.globalStart + GLOBAL_WINDOW_MS).toISOString();
      this.log(`[grunt-server] SIGN-IN IS CLOSED FOR EVERYONE until ${until}: ${GLOBAL_MAX_FAILURES} wrong passwords in an hour. Someone may be guessing.`);
    }

    const entry = this.entries.get(address) ?? { failures: [], lockedUntil: 0 };
    // Re-inserted, so the map's order is oldest-used first.
    this.entries.delete(address);
    if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) {
      entry.lockedUntil = 0;
      entry.failures = [];
    }
    entry.failures = entry.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    entry.failures.push(now);
    if (entry.failures.length >= MAX_FAILURES) {
      entry.lockedUntil = now + LOCK_MS;
      entry.failures = [];
    }
    this.entries.set(address, entry);
    while (this.entries.size > this.maxTracked) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  succeed(address: string): void {
    this.entries.delete(address);
  }

  /** One of the two password-check slots, released by calling the result; null when both are busy. */
  acquire(): (() => void) | null {
    if (this.running >= MAX_CONCURRENT_CHECKS) return null;
    this.running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
    };
  }
}
