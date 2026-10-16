import { limitKey } from './client-address.js';

/**
 * Slows password guessing (spec 2026-10-12-remote-access, "Rate limit", as
 * changed by Adam on 2026-10-14 and by change 8's fix rounds 1-3).
 *
 * Per address: 5 failures in 15 minutes lock it for 15 minutes, and while
 * locked even the right password is refused. An IPv6 address counts as its
 * /64 (`limitKey`), here and for the waiting caps below. An attempt that
 * took a token and ended without a password check (its client went away,
 * or its address was locked while it waited) counts as a failure too.
 *
 * Globally sign-in never closes. Two things bound attempts without a
 * remembered-device cookie (`devices.ts`):
 * - A budget of password checks: a token bucket of 20 that refills one
 *   every 45 s (GCRA). However many addresses guess, at most 100 such
 *   checks run in any hour, the old lockout's number. It applies whatever
 *   the failure count, because attempts sent together all see the same low
 *   count; the 20 at hand mean ordinary sign-ins never notice it.
 * - A slow-down: wrong passwords from anywhere in the last hour (counted by
 *   the minute) delay every such attempt before its password is read, right
 *   or wrong: none under 20; 625 ms at 20, doubling with each further 20
 *   (1.25 s at 40, 2.5 s at 60, 5 s at 80) up to 10 s from 100 on.
 * An attempt waits for the later of its delay and its token, never more
 * than 10 s; when its token is further off than that it gets 429 at once,
 * with `Retry-After` until the token, and nothing is reserved for it.
 *
 * A remembered device skips both, and is locked by its cookie's id instead
 * of its address: 5 wrong passwords in a day and that id counts as no
 * cookie for a day. Device attempts have a bucket of their own, 5 that
 * refill one every 4 minutes: at most 20 checks in any hour. So the worst
 * case is 100 + 20 = 120 password checks in any hour
 * (`limiter.test.ts` floods both and counts).
 *
 * Waiting holds no lock and no database: a timer per waiting attempt, then
 * a place in a FIFO for one of the two password-check slots (remembered
 * devices go first, then clean addresses). At most 50 attempts wait or
 * queue at once, at most 2 per address; more get 429 at once and make no
 * timer. An attempt whose client disconnects leaves at once, clearing its
 * timer.
 *
 * A clean address (no failure from it, or its /64, in the last 24 hours)
 * may also take 5 tokens of the 20 and 5 of the 50 places that the rest
 * can't, and queues ahead of them (fix round 2). What that guarantees:
 * addresses that have failed can't spend the reserve, so however hard they
 * flood, a correct sign-in from a clean address gets a token within its 10
 * s wait while the reserve has one; and, being the same tokens, the
 * 100-an-hour bound holds. An address that takes a token and walks away is
 * charged a failure, so it can't stay clean by never finishing (fix round
 * 3). What it doesn't guarantee: every address is clean until its first
 * failure, so an attacker can spend the reserve with fresh addresses (IPv4
 * addresses or IPv6 /64s). Each takes at most 2 tokens (the per-address
 * waiting cap) and is then not clean for a day, and the reserve refills by
 * at most one token every 45 s, so keeping it empty takes about 1,900 fresh
 * addresses a day (plus 5 to empty it). Above that, a new device waits its
 * turn (Retry-After up to 55 s). Only a remembered device is admitted
 * whatever the flood.
 *
 * Everything here lives in memory: a restart resets the counts, the locks
 * and the budgets. Time comes from a monotonic clock, so a change of the
 * system clock doesn't move them.
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
 * take (fix round 2): a flood from addresses that have already failed can
 * spend 15 of the 20, never these 5. They are the same tokens, so the
 * hourly bound doesn't change.
 */
export const BUDGET_RESERVED = 5;
/** How long a failure keeps its address (its /64) from counting as clean. */
export const CLEAN_WINDOW_MS = 24 * 60 * 60_000;
/** Device-cookie checks at hand at most. */
export const DEVICE_BURST = 5;
/** One more device-cookie check every this long: at most 20 in any hour with the burst. */
export const DEVICE_REFILL_MS = 4 * 60_000;
/** Wrong passwords with one device cookie before it counts as no cookie. */
export const DEVICE_MAX_FAILURES = 5;
/** The window those are counted in, and how long the id then counts as no cookie. */
export const DEVICE_WINDOW_MS = 24 * 60 * 60_000;
/** Attempts waiting (for a delay, a token or a check slot) at once; more get 429. */
export const MAX_DELAYED = 50;
/** Of those places, the ones only a clean address or a remembered device may take. */
export const RESERVED_PLACES = 5;
/** Of those, from one address (one IPv6 /64). */
export const MAX_DELAYED_PER_ADDRESS = 2;
export const MAX_TRACKED = 10_000;
export const MAX_CONCURRENT_CHECKS = 2;
/** Distinct addresses a log summary counts; past this it says "at least". */
export const MAX_SUMMARY_ADDRESSES = 1000;

/** Milliseconds on a clock that only goes forward, whatever happens to the system clock. */
export const monotonicNow = (): number => performance.timeOrigin + performance.now();

export type LimitCheck = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * How a granted check ended: `right` and `wrong` after the password was
 * checked; `unchecked` when it wasn't though it could have been (the
 * address or device was locked while it waited), which counts as a
 * failure; `unavailable` when there was nothing to check against (no
 * password file), which doesn't.
 */
export type Outcome = 'right' | 'wrong' | 'unchecked' | 'unavailable';

const ISSUER = Symbol('LoginLimiter');

/**
 * A check slot and its spent token, which only `LoginLimiter.admit` hands
 * out (its constructor wants a symbol this module keeps). `verifyPassword`
 * requires one, so the type checker won't let a password be checked
 * without going through the limiter, and `spend` lets it be used once.
 */
export class Granted {
  #spent = false;
  #settled = false;

  constructor(
    issuer: typeof ISSUER,
    private readonly settle: (outcome: Outcome) => void
  ) {
    if (issuer !== ISSUER) throw new Error('Only the sign-in limiter grants a password check.');
  }

  /** For `verifyPassword`: true the first time only, and never after `release`. */
  spend(): boolean {
    if (this.#spent || this.#settled) return false;
    this.#spent = true;
    return true;
  }

  /** Ends the attempt: counts it as `outcome` and frees the check slot. The first call wins. */
  release(outcome: Outcome): void {
    if (this.#settled) return;
    this.#settled = true;
    this.settle(outcome);
  }
}

/**
 * `go`: check the password now with `granted`, then `release` it.
 * `busy`: refused at once, by a budget or because too many are waiting.
 * `gone`: the client went away while waiting.
 */
export type Admission = { kind: 'go'; waitedMs: number; granted: Granted } | { kind: 'busy'; retryAfterSec: number; why: 'budget' | 'places' } | { kind: 'gone' };

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
  /** Device ids the device lockout remembers. */
  trackedDevices: number;
  /** Checks a clean address could start now without waiting for a token (0 to `BUDGET_BURST`). */
  budget: number;
  /** Device-cookie checks that could start now (0 to `DEVICE_BURST`). */
  deviceBudget: number;
  /** Whether a log summary is pending (it holds the one timer that isn't an attempt's). */
  summarising: boolean;
}

/** What the per-minute log summary counts. */
export type LogReason = 'wrong' | 'budget' | 'places' | 'locked' | 'abandoned' | 'no-password-file';

const REASON_TEXT: Record<LogReason, [string, string]> = {
  wrong: ['wrong password', 'wrong passwords'],
  budget: ['told to wait (budget spent)', 'told to wait (budget spent)'],
  places: ['told to wait (too many waiting)', 'told to wait (too many waiting)'],
  locked: ['refused while locked', 'refused while locked'],
  abandoned: ['left before its check', 'left before their check'],
  'no-password-file': ['refused (no password file)', 'refused (no password file)'],
};

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

/** A GCRA token bucket: `burst` at hand, one more every `refillMs`. */
class Bucket {
  private tat = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly burst: number,
    private readonly refillMs: number
  ) {}

  /** How long until a check may start, using at most `burst - held` of the burst. */
  waitMs(now: number, held = 0): number {
    return Math.max(now, this.tat - (this.burst - held - 1) * this.refillMs) - now;
  }

  spend(now: number): void {
    this.tat = Math.max(this.tat, now) + this.refillMs;
  }

  /** Checks that could start now without waiting. */
  available(now: number): number {
    return Math.max(0, Math.min(this.burst, Math.floor((now - (this.tat - this.burst * this.refillMs)) / this.refillMs)));
  }
}

/** A per-key failure count and lock, capped in size: see `evictOne`. */
class Lockout {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly lockMs: number,
    private readonly maxTracked: number
  ) {}

  get size(): number {
    return this.entries.size;
  }

  check(key: string, now: number): LimitCheck {
    const entry = this.entries.get(key);
    if (entry && entry.lockedUntil > now) return { ok: false, retryAfterSec: seconds(entry.lockedUntil - now) };
    return { ok: true };
  }

  fail(key: string, now: number): void {
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    // Re-inserted, so the map's order is oldest-used first.
    this.entries.delete(key);
    if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) {
      entry.lockedUntil = 0;
      entry.failures = [];
    }
    entry.failures = entry.failures.filter((t) => now - t < this.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.maxFailures) {
      entry.lockedUntil = now + this.lockMs;
      entry.failures = [];
    }
    this.entries.set(key, entry);
    while (this.entries.size > this.maxTracked) this.evictOne(now, key);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Drops the oldest-used key that isn't locked (an expired lock counts as
   * not locked), so a flood of new keys can't free a locked one to guess
   * again. Only when every one is locked, the lock that ends soonest. Never
   * `keep`, the key just counted, or a newcomer could guess without ever
   * being counted once every other key is locked.
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
}

export class LoginLimiter {
  private readonly addresses: Lockout;
  private readonly devices: Lockout;
  /** When each address (its /64) last failed, for a day: oldest first, at most `maxTracked`. */
  private readonly lastFailure = new Map<string, number>();
  /** Global failures per minute (`floor(now / GLOBAL_BUCKET_MS)`), the last hour's only. */
  private readonly buckets = new Map<number, number>();
  private readonly budget = new Bucket(BUDGET_BURST, BUDGET_REFILL_MS);
  private readonly deviceBudget = new Bucket(DEVICE_BURST, DEVICE_REFILL_MS);
  private running = 0;
  private waiting = 0;
  private readonly waitingByKey = new Map<string, number>();
  /** Queues for a check slot, served in this order: remembered devices, clean addresses, the rest. */
  private readonly deviceQueue: Queued[] = [];
  private readonly cleanQueue: Queued[] = [];
  private readonly queue: Queued[] = [];
  private summary: { minute: number; counts: Map<LogReason, number>; addresses: Set<string>; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxTracked: number;
  private readonly maxDelayed: number;

  /** `maxTracked` and `maxDelayed` are for tests; the budgets keep the waiting far below 50. */
  constructor(opts: { now?: () => number; log?: (line: string) => void; maxTracked?: number; maxDelayed?: number } = {}) {
    this.now = opts.now ?? monotonicNow;
    this.log = opts.log ?? ((line) => console.error(line));
    this.maxTracked = opts.maxTracked ?? MAX_TRACKED;
    this.maxDelayed = opts.maxDelayed ?? MAX_DELAYED;
    this.addresses = new Lockout(MAX_FAILURES, FAILURE_WINDOW_MS, LOCK_MS, this.maxTracked);
    this.devices = new Lockout(DEVICE_MAX_FAILURES, DEVICE_WINDOW_MS, DEVICE_WINDOW_MS, this.maxTracked);
  }

  /** Whether this address (its /64 for IPv6) may try now; nothing global ever refuses here. */
  check(address: string): LimitCheck {
    return this.addresses.check(limitKey(address), this.now());
  }

  /** Whether this remembered device's id may still be used; when not, its cookie counts as none. */
  checkDevice(id: string): LimitCheck {
    return this.devices.check(id, this.now());
  }

  /**
   * Whether the address (its /64) has no failure in the last 24 hours and
   * no running lock: one that hasn't been guessing. Attempts the limits
   * refused don't count against it (no password was checked and no token
   * spent), so a new device told to wait stays clean for its next try, and
   * a correct sign-in makes its address clean again. The key comes from the
   * socket, or from the right-most hop a trusted proxy wrote, never from
   * anything the client sends.
   */
  isClean(address: string): boolean {
    const now = this.now();
    const key = limitKey(address);
    if (!this.addresses.check(key, now).ok) return false;
    const last = this.lastFailure.get(key);
    return last === undefined || now - last >= CLEAN_WINDOW_MS;
  }

  /** Wrong passwords (and abandoned checks) from anywhere in the last hour. */
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
    const now = this.now();
    return {
      waiting: this.waiting,
      queued: this.queued(),
      running: this.running,
      waitingAddresses: this.waitingByKey.size,
      tracked: this.addresses.size,
      trackedDevices: this.devices.size,
      budget: this.budget.available(now),
      deviceBudget: this.deviceBudget.available(now),
      summarising: this.summary !== null,
    };
  }

  private queued(): number {
    return this.deviceQueue.length + this.cleanQueue.length + this.queue.length;
  }

  /**
   * Gets one password check under the limits (see the top of this file).
   * `device`: the id of a remembered-device cookie whose HMAC the caller has
   * checked and whose id isn't locked; the attempt then spends a device
   * token instead of a budget token and skips the delay, though not the
   * caps on waiting. An address with no recent failures (`isClean`) may
   * also take the reserved tokens and places and queues ahead of the rest.
   * On `go` the caller checks the password with `granted` and releases it
   * with the outcome. An attempt that is admitted and then leaves (its
   * client goes away) is charged a failure, to its device id or address.
   *
   * A disconnect is seen through `signal`, which `@hono/node-server` (2.1.3,
   * checked) aborts when the client closes the connection early. If that
   * ever stops happening, an abandoned attempt still leaves within 10 s of
   * waiting plus its turn in the bounded queue.
   */
  admit(address: string, opts: { device?: string | null; signal?: AbortSignal } = {}): Promise<Admission> {
    const { signal } = opts;
    const device = opts.device ?? null;
    if (signal?.aborted) return Promise.resolve({ kind: 'gone' });
    const now = this.now();
    const key = limitKey(address);
    const clean = this.isClean(address);
    let waitMs: number;
    if (device !== null) {
      waitMs = this.deviceBudget.waitMs(now);
    } else {
      const tokenWait = this.budget.waitMs(now, clean ? 0 : BUDGET_RESERVED);
      waitMs = tokenWait > SLOW_MAX_MS ? tokenWait : Math.max(this.delayMs(), tokenWait);
    }
    if (waitMs > SLOW_MAX_MS) {
      this.note('budget', address);
      return Promise.resolve({ kind: 'busy', retryAfterSec: seconds(waitMs), why: 'budget' });
    }
    const slotFree = waitMs === 0 && this.running < MAX_CONCURRENT_CHECKS && this.queued() === 0;
    const places = device !== null || clean ? this.maxDelayed : this.maxDelayed - RESERVED_PLACES;
    if (!slotFree && (this.waiting >= places || (this.waitingByKey.get(key) ?? 0) >= MAX_DELAYED_PER_ADDRESS)) {
      this.note('places', address);
      return Promise.resolve({ kind: 'busy', retryAfterSec: seconds(Math.max(waitMs, 1000)), why: 'places' });
    }
    // Admitted: the token is spent now, whatever happens next; an attempt that leaves is charged a failure.
    if (device !== null) this.deviceBudget.spend(now);
    else this.budget.spend(now);
    const charge = () => this.chargeFailure(address, device);
    if (slotFree) {
      this.running += 1;
      return Promise.resolve({ kind: 'go', waitedMs: 0, granted: this.granted(address, device) });
    }

    this.waiting += 1;
    this.waitingByKey.set(key, (this.waitingByKey.get(key) ?? 0) + 1);
    const line = device !== null ? this.deviceQueue : clean ? this.cleanQueue : this.queue;
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
        charge();
        this.note('abandoned', address);
        resolve({ kind: 'gone' });
      };
      const grant = () => {
        if (done) return;
        done = true;
        leave();
        resolve({ kind: 'go', waitedMs: this.now() - now, granted: this.granted(address, device) });
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

  /** A check slot's `Granted`: on release it counts the outcome and hands the slot on (devices, then clean addresses, then the rest). */
  private granted(address: string, device: string | null): Granted {
    return new Granted(ISSUER, (outcome) => {
      if (outcome === 'right') {
        if (device !== null) this.devices.clear(device);
        else this.succeed(address);
      } else if (outcome === 'wrong') {
        this.chargeFailure(address, device);
        this.note('wrong', address);
      } else if (outcome === 'unchecked') {
        this.chargeFailure(address, device);
        this.note('abandoned', address);
      }
      const next = this.deviceQueue.shift() ?? this.cleanQueue.shift() ?? this.queue.shift();
      // The slot passes straight to `next`, so `running` stays as it is.
      if (next) next.grant();
      else this.running -= 1;
    });
  }

  /** A failure against a device id (which isn't its address's) or an address. */
  private chargeFailure(address: string, device: string | null): void {
    if (device !== null) {
      this.countGlobal();
      this.devices.fail(device, this.now());
    } else {
      this.fail(address);
    }
  }

  private countGlobal(): void {
    const now = this.now();
    const before = this.globalFailures();
    const minute = Math.floor(now / GLOBAL_BUCKET_MS);
    this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + 1);
    const after = slowDownMs(before + 1);
    if (after > slowDownMs(before)) {
      this.log(
        `[otherbench-server] SIGN-IN IS SLOWED DOWN FOR EVERYONE: ${before + 1} wrong passwords in the last hour, so every attempt now waits ${after / 1000} s. Someone may be guessing.`
      );
    }
  }

  /** A failure from this address: its lockout count, its clean status and the global count. */
  fail(address: string): void {
    const now = this.now();
    this.countGlobal();
    const key = limitKey(address);
    this.addresses.fail(key, now);
    this.lastFailure.delete(key);
    this.lastFailure.set(key, now);
    while (this.lastFailure.size > this.maxTracked) {
      const oldest = this.lastFailure.keys().next().value;
      if (oldest === undefined) break;
      this.lastFailure.delete(oldest);
    }
  }

  succeed(address: string): void {
    const key = limitKey(address);
    this.addresses.clear(key);
    this.lastFailure.delete(key);
  }

  /**
   * Logs a sign-in event. A wrong password gets a line of its own while
   * sign-in isn't slowed down (fewer than 20 an hour); everything else, and
   * wrong passwords once it is, goes into one line a minute with a count
   * per reason and the number of addresses, so a flood can't flood the log.
   */
  note(reason: LogReason, address: string): void {
    if (reason === 'wrong' && this.delayMs() === 0 && !this.summary) {
      this.log(`[otherbench-server] wrong password from ${address}`);
      return;
    }
    const minute = Math.floor(this.now() / GLOBAL_BUCKET_MS);
    if (this.summary && this.summary.minute !== minute) this.flushSummary();
    if (!this.summary) {
      const timer = setTimeout(() => this.flushSummary(), GLOBAL_BUCKET_MS);
      timer.unref?.();
      this.summary = { minute, counts: new Map(), addresses: new Set(), timer };
    }
    this.summary.counts.set(reason, (this.summary.counts.get(reason) ?? 0) + 1);
    if (this.summary.addresses.size < MAX_SUMMARY_ADDRESSES) this.summary.addresses.add(address);
  }

  private flushSummary(): void {
    const s = this.summary;
    if (!s) return;
    this.summary = null;
    clearTimeout(s.timer);
    const n = s.addresses.size;
    const from = n >= MAX_SUMMARY_ADDRESSES ? `at least ${n} addresses` : n === 1 ? '1 address' : `${n} addresses`;
    const parts = [...s.counts].map(([reason, count]) => `${count} ${REASON_TEXT[reason][count === 1 ? 0 : 1]}`);
    this.log(`[otherbench-server] sign-in in the last minute: ${parts.join(', ')}, from ${from}`);
  }

  /** Writes out a pending log summary and stops its timer. */
  close(): void {
    this.flushSummary();
  }
}
