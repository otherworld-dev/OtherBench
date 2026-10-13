/**
 * Slows password guessing (spec 2026-10-12-remote-access, "Rate limit", as
 * changed by Adam on 2026-10-14).
 *
 * Per address: 5 failures in 15 minutes lock it for 15 minutes, and while
 * locked even the right password is refused.
 *
 * Globally there is no lockout, only a slow-down. Wrong passwords from
 * anywhere in the last hour (counted by the minute) delay every attempt,
 * right or wrong, before its password is read: none under 20; 625 ms at 20,
 * doubling with each further 20 (1.25 s at 40, 2.5 s at 60, 5 s at 80) up to
 * 10 s from 100 on, the count that used to close sign-in for everyone. The
 * global count never refuses an attempt by itself. The delay is a timer, so
 * nothing blocks and nothing is held while it runs; at most 50 attempts wait
 * at once and more get 429 with `Retry-After`, so the delay can't be used to
 * hold sockets open without bound (each waits 10 s at most). An attempt
 * whose client goes away stops waiting and frees its place.
 */
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;
export const GLOBAL_WINDOW_MS = 60 * 60_000;
/** The global count is kept per minute, so a failure leaves the window between 59 and 60 minutes later. */
export const GLOBAL_BUCKET_MS = 60_000;
/** Global failures in the window before attempts are slowed down. */
export const SLOW_START = 20;
/** The delay doubles with each further this many global failures. */
export const SLOW_STEP = 20;
/** The delay at `SLOW_START` failures. */
export const SLOW_BASE_MS = 625;
/** The longest delay; reached at 100 failures. */
export const SLOW_MAX_MS = 10_000;
/** Attempts waiting out a delay at once; more get 429. */
export const MAX_DELAYED = 50;
export const MAX_TRACKED = 10_000;
export const MAX_CONCURRENT_CHECKS = 2;

export type LimitCheck = { ok: true } | { ok: false; retryAfterSec: number };

/** `go`: check the password now. `busy`: too many attempts already waiting. `gone`: the client went away while waiting. */
export type SlowDown = { kind: 'go'; delayedMs: number } | { kind: 'busy'; retryAfterSec: number } | { kind: 'gone' };

interface Entry {
  failures: number[];
  lockedUntil: number;
}

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/** The delay every attempt waits with `failures` wrong passwords in the global window. */
export function slowDownMs(failures: number): number {
  if (failures < SLOW_START) return 0;
  const steps = Math.floor((failures - SLOW_START) / SLOW_STEP);
  return Math.min(SLOW_MAX_MS, SLOW_BASE_MS * 2 ** steps);
}

/** The 429 text for a lock: whole minutes, rounded up. */
export function tooManyMessage(retryAfterSec: number): string {
  const minutes = Math.ceil(retryAfterSec / 60);
  return minutes <= 1 ? 'Too many tries. Try again in a minute.' : `Too many tries. Try again in ${minutes} minutes.`;
}

export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();
  /** Global failures per minute (`floor(now / GLOBAL_BUCKET_MS)`), the last hour's only. */
  private readonly buckets = new Map<number, number>();
  private running = 0;
  private delayed = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxTracked: number;

  constructor(opts: { now?: () => number; log?: (line: string) => void; maxTracked?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    this.maxTracked = opts.maxTracked ?? MAX_TRACKED;
  }

  /** Whether this address may try now; the global count never refuses. */
  check(address: string): LimitCheck {
    const now = this.now();
    const entry = this.entries.get(address);
    if (entry && entry.lockedUntil > now) return { ok: false, retryAfterSec: seconds(entry.lockedUntil - now) };
    return { ok: true };
  }

  /** Wrong passwords from anywhere in the last hour. */
  globalFailures(): number {
    const current = Math.floor(this.now() / GLOBAL_BUCKET_MS);
    const oldest = current - GLOBAL_WINDOW_MS / GLOBAL_BUCKET_MS;
    let total = 0;
    for (const [minute, count] of this.buckets) {
      if (minute <= oldest) this.buckets.delete(minute);
      else total += count;
    }
    return total;
  }

  /** The delay an attempt starting now waits. */
  delayMs(): number {
    return slowDownMs(this.globalFailures());
  }

  /**
   * Waits out the global delay before a password check, without blocking:
   * a timer, holding nothing but one of the `MAX_DELAYED` places. `busy`
   * when they are all taken; `gone` (and the place freed at once) when
   * `signal` aborts, i.e. the client disconnected.
   */
  slowDown(signal?: AbortSignal): Promise<SlowDown> {
    const ms = this.delayMs();
    if (ms === 0) return Promise.resolve({ kind: 'go', delayedMs: 0 });
    if (signal?.aborted) return Promise.resolve({ kind: 'gone' });
    if (this.delayed >= MAX_DELAYED) return Promise.resolve({ kind: 'busy', retryAfterSec: seconds(ms) });
    this.delayed += 1;
    return new Promise((resolve) => {
      let done = false;
      const finish = (outcome: SlowDown) => {
        if (done) return;
        done = true;
        this.delayed -= 1;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish({ kind: 'gone' });
      const timer = setTimeout(() => finish({ kind: 'go', delayedMs: ms }), ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  fail(address: string): void {
    const now = this.now();
    const before = this.globalFailures();
    const minute = Math.floor(now / GLOBAL_BUCKET_MS);
    this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + 1);
    const after = slowDownMs(before + 1);
    if (after > slowDownMs(before)) {
      this.log(
        `[grunt-server] SIGN-IN IS SLOWED DOWN FOR EVERYONE: ${before + 1} wrong passwords in the last hour, so every attempt now waits ${after / 1000} s. Someone may be guessing.`
      );
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
