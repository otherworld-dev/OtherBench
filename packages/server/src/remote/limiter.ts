import { limitKey } from './client-address.js';

/**
 * Slows password guessing (spec 2026-10-12-remote-access, "Rate limit", as
 * changed by Adam on 2026-10-14 and by change 8's fix round 1).
 *
 * Per address: 5 failures in 15 minutes lock it for 15 minutes, and while
 * locked even the right password is refused. An IPv6 address counts as its
 * /64 (`limitKey`), here and for the waiting caps below.
 *
 * Globally sign-in never closes. Two things bound it instead, and a browser
 * with a valid remembered-device cookie (`devices.ts`) skips both:
 * - A budget of password checks: a token bucket of 20 that refills one
 *   every 45 s (GCRA). However many addresses guess, at most 100 checks run
 *   in any hour, the old lockout's number (`limiter.test.ts` floods it for
 *   an hour and counts). It applies whatever the failure count, because
 *   attempts sent together all see the same low count; the 20 at hand mean
 *   ordinary sign-ins never notice it.
 * - A slow-down: wrong passwords from anywhere in the last hour (counted by
 *   the minute) delay every attempt before its password is read, right or
 *   wrong: none under 20; 625 ms at 20, doubling with each further 20 (1.25
 *   s at 40, 2.5 s at 60, 5 s at 80) up to 10 s from 100 on.
 * An attempt waits for the later of its delay and its token, never more
 * than 10 s; when its token is further off than that it gets 429 at once,
 * with `Retry-After` until the token, and nothing is reserved for it.
 *
 * Waiting holds no lock and no database: a timer per waiting attempt, then
 * a place in a FIFO for one of the two password-check slots (remembered
 * devices go first, then clean addresses). At most 50 attempts wait or
 * queue at once, at most 2 per address; more get 429 at once and make no
 * timer. An attempt whose client disconnects leaves at once, clearing its
 * timer.
 *
 * A clean address (no wrong password from it, or its /64, in the last 24
 * hours) may also take 5 tokens of the 20 and 5 of the 50 places that the
 * rest can't, and queues ahead of them (fix round 2). What that guarantees:
 * addresses that have guessed wrong can't spend the reserve, so however
 * hard they flood, a correct sign-in from a clean address gets a token
 * within its 10 s wait while the reserve has one; and, being the same
 * tokens, the 100-an-hour bound holds. What it doesn't: every address is
 * clean until its first wrong password, so an attacker can spend the
 * reserve with fresh addresses (IPv4 addresses or IPv6 /64s). Each takes
 * at most 2 tokens (the per-address waiting cap) and is then not clean for
 * a day, and the reserve refills by at most one token every 45 s, so
 * keeping it empty takes about 1,900 fresh addresses a day (plus 5 to
 * empty it). Below that, a clean sign-in gets in within a token's refill;
 * above it, a new device waits its turn (Retry-After up to 55 s). Only a
 * remembered device is admitted whatever the flood.
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
/** The longest delay, reached at 100 failures, and the longest any attempt waits for a token. */
export const SLOW_MAX_MS = 10_000;
/** Password checks the budget holds at most (its burst). */
export const BUDGET_BURST = 20;
/** One more check every this long: 80 an hour, so 100 at most in any hour with the burst. */
export const BUDGET_REFILL_MS = 45_000;
/**
 * Of the budget, checks only an address with no failures in its window may
 * take (fix round 2): a flood from addresses that have already guessed
 * wrong can spend 15 of the 20, never these 5. They are the same tokens, so
 * the hourly bound doesn't change.
 */
export const BUDGET_RESERVED = 5;
/** How long a wrong password keeps its address (its /64) from counting as clean. */
export const CLEAN_WINDOW_MS = 24 * 60 * 60_000;
/** Attempts waiting (for a delay, a token or a check slot) at once; more get 429. */
export const MAX_DELAYED = 50;
/** Of those places, the ones only a clean address or a remembered device may take. */
export const RESERVED_PLACES = 5;
/** Of those, from one address (one IPv6 /64). */
export const MAX_DELAYED_PER_ADDRESS = 2;
export const MAX_TRACKED = 10_000;
export const MAX_CONCURRENT_CHECKS = 2;
/** Distinct addresses a log summary names a count of; past this it says "at least". */
const MAX_SUMMARY_ADDRESSES = 1000;

export type LimitCheck = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * `go`: check the password now, in a check slot freed by `release`.
 * `busy`: refused at once, by the budget or because too many are waiting.
 * `gone`: the client went away while waiting.
 */
export type Admission =
  | { kind: 'go'; waitedMs: number; release: () => void }
  | { kind: 'busy'; retryAfterSec: number; why: 'budget' | 'places' }
  | { kind: 'gone' };

export interface LimiterStats {
  /** Attempts holding a waiting place (on a timer or queued for a slot). */
  waiting: number;
  /** Of those, queued for a check slot. */
  queued: number;
  /** Password checks running. */
  running: number;
  /** Addresses with a waiting place. */
  waitingAddresses: number;
  /** Addresses the lockout remembers. */
  tracked: number;
  /** Checks a clean address could start now without waiting for a token (0 to `BUDGET_BURST`). */
  budget: number;
}

interface Entry {
  failures: number[];
  lockedUntil: number;
}

interface Queued {
  key: string;
  grant: () => void;
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
  /** When each address (its /64) last guessed wrong, for a day: oldest first, at most `maxTracked`. */
  private readonly lastFailure = new Map<string, number>();
  /** Global failures per minute (`floor(now / GLOBAL_BUCKET_MS)`), the last hour's only. */
  private readonly buckets = new Map<number, number>();
  /** The budget's theoretical arrival time (GCRA): a check conforms from `tat - (BURST - 1) * REFILL`. */
  private tat = Number.NEGATIVE_INFINITY;
  private running = 0;
  private waiting = 0;
  private readonly waitingByKey = new Map<string, number>();
  /** Queues for a check slot, served in this order: remembered devices, clean addresses, the rest. */
  private readonly deviceQueue: Queued[] = [];
  private readonly cleanQueue: Queued[] = [];
  private readonly queue: Queued[] = [];
  private summary: { minute: number; count: number; addresses: Set<string>; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxTracked: number;

  constructor(opts: { now?: () => number; log?: (line: string) => void; maxTracked?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    this.maxTracked = opts.maxTracked ?? MAX_TRACKED;
  }

  /** Whether this address (its /64 for IPv6) may try now; nothing global ever refuses here. */
  check(address: string): LimitCheck {
    const now = this.now();
    const entry = this.entries.get(limitKey(address));
    if (entry && entry.lockedUntil > now) return { ok: false, retryAfterSec: seconds(entry.lockedUntil - now) };
    return { ok: true };
  }

  /**
   * Whether the address (its /64) has no wrong password in the last 24
   * hours and no running lock: one that hasn't been guessing. Attempts the
   * limits refused don't count against it (no password was checked), so a
   * new device told to wait stays clean for its next try, and a correct
   * sign-in makes its address clean again. The key comes from the socket,
   * or from the right-most hop a trusted proxy wrote, never from anything
   * the client sends.
   */
  isClean(address: string): boolean {
    const now = this.now();
    const key = limitKey(address);
    const entry = this.entries.get(key);
    if (entry && entry.lockedUntil > now) return false;
    const last = this.lastFailure.get(key);
    return last === undefined || now - last >= CLEAN_WINDOW_MS;
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

  stats(): LimiterStats {
    return {
      waiting: this.waiting,
      queued: this.queued(),
      running: this.running,
      waitingAddresses: this.waitingByKey.size,
      tracked: this.entries.size,
      budget: Math.max(0, Math.min(BUDGET_BURST, Math.floor((this.now() - (this.tat - BUDGET_BURST * BUDGET_REFILL_MS)) / BUDGET_REFILL_MS))),
    };
  }

  private queued(): number {
    return this.deviceQueue.length + this.cleanQueue.length + this.queue.length;
  }

  /**
   * Gets one password check under the limits (see the top of this file).
   * `device`: the attempt carries a valid remembered-device cookie (its
   * HMAC already checked by the caller), so it skips the budget and the
   * delay, though not the caps on waiting. An address with no recent
   * failures (`isClean`) may also take the reserved tokens and places and
   * queues ahead of the rest. On `go` the caller runs its check and then
   * calls `release`.
   *
   * A disconnect is seen through `signal`, which `@hono/node-server` (2.1.3,
   * checked) aborts when the client closes the connection early. If that
   * ever stops happening, an abandoned attempt still leaves within 10 s of
   * waiting plus its turn in the bounded queue.
   */
  admit(address: string, opts: { device?: boolean; signal?: AbortSignal } = {}): Promise<Admission> {
    const { device = false, signal } = opts;
    if (signal?.aborted) return Promise.resolve({ kind: 'gone' });
    const now = this.now();
    const key = limitKey(address);
    const clean = this.isClean(address);
    let waitMs = 0;
    let allowAt = now;
    if (!device) {
      const burst = clean ? BUDGET_BURST : BUDGET_BURST - BUDGET_RESERVED;
      allowAt = Math.max(now, this.tat - (burst - 1) * BUDGET_REFILL_MS);
      const tokenWait = allowAt - now;
      if (tokenWait > SLOW_MAX_MS) return Promise.resolve({ kind: 'busy', retryAfterSec: seconds(tokenWait), why: 'budget' });
      waitMs = Math.max(this.delayMs(), tokenWait);
    }
    const slotFree = waitMs === 0 && this.running < MAX_CONCURRENT_CHECKS && this.queued() === 0;
    const places = device || clean ? MAX_DELAYED : MAX_DELAYED - RESERVED_PLACES;
    if (!slotFree && (this.waiting >= places || (this.waitingByKey.get(key) ?? 0) >= MAX_DELAYED_PER_ADDRESS)) {
      return Promise.resolve({ kind: 'busy', retryAfterSec: seconds(Math.max(waitMs, 1000)), why: 'places' });
    }
    // Admitted: the token is spent now, whatever happens next (an abandoned attempt doesn't hand it back).
    if (!device) this.tat = Math.max(this.tat, now) + BUDGET_REFILL_MS;
    if (slotFree) {
      this.running += 1;
      return Promise.resolve({ kind: 'go', waitedMs: 0, release: this.releaser() });
    }

    this.waiting += 1;
    this.waitingByKey.set(key, (this.waitingByKey.get(key) ?? 0) + 1);
    const line = device ? this.deviceQueue : clean ? this.cleanQueue : this.queue;
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let queued: Queued | null = null;
      const leave = () => {
        this.waiting -= 1;
        const left = (this.waitingByKey.get(key) ?? 1) - 1;
        if (left <= 0) this.waitingByKey.delete(key);
        else this.waitingByKey.set(key, left);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (queued) {
          const at = line.indexOf(queued);
          if (at >= 0) line.splice(at, 1);
        }
        leave();
        resolve({ kind: 'gone' });
      };
      const grant = () => {
        if (done) return;
        done = true;
        leave();
        resolve({ kind: 'go', waitedMs: this.now() - now, release: this.releaser() });
      };
      const toQueue = () => {
        timer = null;
        if (done) return;
        if (this.running < MAX_CONCURRENT_CHECKS && this.queued() === 0) {
          this.running += 1;
          grant();
          return;
        }
        queued = { key, grant: () => grant() };
        line.push(queued);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (waitMs > 0) timer = setTimeout(toQueue, waitMs);
      else toQueue();
    });
  }

  /** Releases a check slot once, handing it to the next queued attempt (remembered devices, then clean addresses, then the rest). */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.deviceQueue.shift() ?? this.cleanQueue.shift() ?? this.queue.shift();
      // The slot passes straight to `next`, so `running` stays as it is.
      if (next) next.grant();
      else this.running -= 1;
    };
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

    const key = limitKey(address);
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    // Re-inserted, so the map's order is oldest-used first.
    this.entries.delete(key);
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
    this.entries.set(key, entry);
    this.lastFailure.delete(key);
    this.lastFailure.set(key, now);
    while (this.lastFailure.size > this.maxTracked) {
      const oldest = this.lastFailure.keys().next().value;
      if (oldest === undefined) break;
      this.lastFailure.delete(oldest);
    }
    while (this.entries.size > this.maxTracked) this.evictOne(now, key);
  }

  /**
   * Drops the oldest-used address that isn't locked (an expired lock counts
   * as not locked), so a flood of new addresses can't free a locked one to
   * guess again. Only when every one is locked, the lock that ends soonest.
   * Never `keep`, the address just counted, or a newcomer could guess
   * without ever being counted once every other address is locked.
   */
  private evictOne(now: number, keep: string): void {
    let soonest: string | undefined;
    let soonestUntil = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (key === keep) continue;
      if (entry.lockedUntil <= now) {
        this.entries.delete(key);
        return;
      }
      if (entry.lockedUntil < soonestUntil) {
        soonest = key;
        soonestUntil = entry.lockedUntil;
      }
    }
    if (soonest !== undefined) this.entries.delete(soonest);
  }

  succeed(address: string): void {
    this.entries.delete(limitKey(address));
    this.lastFailure.delete(limitKey(address));
  }

  /**
   * Logs a wrong password: one line each while sign-in isn't slowed down,
   * then one line a minute with the count and the number of addresses, so a
   * flood doesn't flood the log too.
   */
  noteWrong(address: string): void {
    if (this.delayMs() === 0 && !this.summary) {
      this.log(`[grunt-server] wrong password from ${address}`);
      return;
    }
    const minute = Math.floor(this.now() / GLOBAL_BUCKET_MS);
    if (this.summary && this.summary.minute !== minute) this.flushSummary();
    if (!this.summary) {
      const timer = setTimeout(() => this.flushSummary(), GLOBAL_BUCKET_MS);
      timer.unref?.();
      this.summary = { minute, count: 0, addresses: new Set(), timer };
    }
    this.summary.count += 1;
    if (this.summary.addresses.size < MAX_SUMMARY_ADDRESSES) this.summary.addresses.add(address);
  }

  private flushSummary(): void {
    const s = this.summary;
    if (!s) return;
    this.summary = null;
    clearTimeout(s.timer);
    const n = s.addresses.size;
    const from = n >= MAX_SUMMARY_ADDRESSES ? `at least ${n} addresses` : n === 1 ? '1 address' : `${n} addresses`;
    this.log(`[grunt-server] ${s.count} wrong password${s.count === 1 ? '' : 's'} in the last minute from ${from}`);
  }

  /** Writes out a pending log summary and stops its timer. */
  close(): void {
    this.flushSummary();
  }
}
