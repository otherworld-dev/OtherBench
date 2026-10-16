import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Admission,
  BUDGET_BURST,
  BUDGET_REFILL_MS,
  BUDGET_RESERVED,
  CLEAN_WINDOW_MS,
  DEVICE_BURST,
  DEVICE_MAX_FAILURES,
  DEVICE_REFILL_MS,
  DEVICE_WINDOW_MS,
  FAILURE_WINDOW_MS,
  GLOBAL_BUCKET_MS,
  GLOBAL_WINDOW_MS,
  Granted,
  LOCK_MS,
  LoginLimiter,
  type LogReason,
  MAX_CONCURRENT_CHECKS,
  MAX_DELAYED,
  MAX_DELAYED_PER_ADDRESS,
  MAX_FAILURES,
  MAX_SUMMARY_ADDRESSES,
  MAX_TRACKED,
  monotonicNow,
  type Outcome,
  SLOW_BASE_MS,
  SLOW_MAX_MS,
  slowDownMs,
  tooManyMessage,
} from '../../src/remote/limiter.js';

function limiter(maxTracked?: number) {
  const clock = { now: 1_000_000_000 };
  const log = vi.fn();
  return { clock, log, limiter: new LoginLimiter({ now: () => clock.now, log, ...(maxTracked !== undefined ? { maxTracked } : {}) }) };
}

/** The i-th of many addresses, none used more than 4 times by `i` running 0..n, so none is locked. */
const spread = (i: number): string => `10.${Math.floor(i / 1000)}.${Math.floor(i / 4) % 250}.${i % 4}`;

describe('LoginLimiter: per address', () => {
  it('locks an address on its 5th failure for 15 minutes, then lets it try again', () => {
    const { clock, limiter: l } = limiter();
    for (let i = 0; i < 4; i++) l.fail('10.0.0.7');
    expect(l.check('10.0.0.7')).toEqual({ ok: true });

    l.fail('10.0.0.7');
    expect(l.check('10.0.0.7')).toEqual({ ok: false, retryAfterSec: LOCK_MS / 1000 });
    expect(l.check('10.0.0.8')).toEqual({ ok: true });

    clock.now += LOCK_MS - 1000;
    expect(l.check('10.0.0.7')).toEqual({ ok: false, retryAfterSec: 1 });
    clock.now += 1000;
    expect(l.check('10.0.0.7')).toEqual({ ok: true });
  });

  it('forgets failures older than 15 minutes', () => {
    const { clock, limiter: l } = limiter();
    for (let i = 0; i < 4; i++) l.fail('10.0.0.7');
    clock.now += FAILURE_WINDOW_MS;
    l.fail('10.0.0.7');

    expect(l.check('10.0.0.7')).toEqual({ ok: true });
  });

  it('clears an address on success', () => {
    const { limiter: l } = limiter();
    for (let i = 0; i < 4; i++) l.fail('10.0.0.7');
    l.succeed('10.0.0.7');
    l.fail('10.0.0.7');

    expect(l.check('10.0.0.7')).toEqual({ ok: true });
  });

  it('counts an IPv6 address as its /64', () => {
    const { limiter: l } = limiter();
    for (let i = 1; i <= 5; i++) l.fail(`2001:db8:0:1::${i}`);

    expect(l.check('2001:db8:0:1:ffff::9').ok).toBe(false);
    expect(l.check('2001:db8:0:2::1')).toEqual({ ok: true });
  });

  it('tracks a bounded number of addresses, dropping the oldest unlocked one, never a lock that is still running', () => {
    const { limiter: l } = limiter(2);
    for (let i = 0; i < 5; i++) l.fail('10.0.0.1');
    for (let i = 0; i < 4; i++) l.fail('10.0.0.2');
    l.fail('10.0.0.3');

    expect(l.stats().tracked).toBe(2);
    expect(l.check('10.0.0.1').ok).toBe(false);
    // 10.0.0.2's four failures were dropped with it.
    l.fail('10.0.0.2');
    expect(l.check('10.0.0.2')).toEqual({ ok: true });
  });

  it('drops the lock that ends soonest only when every tracked address is locked', () => {
    const { clock, limiter: l } = limiter(2);
    for (let i = 0; i < 5; i++) l.fail('10.0.0.1');
    clock.now += 1000;
    for (let i = 0; i < 5; i++) l.fail('10.0.0.2');
    for (let i = 0; i < 5; i++) l.fail('10.0.0.3');

    expect(l.check('10.0.0.1')).toEqual({ ok: true });
    expect(l.check('10.0.0.2').ok).toBe(false);
    expect(l.check('10.0.0.3').ok).toBe(false);
  });
});

describe('LoginLimiter: global count', () => {
  it('never refuses because of the global count, even far past the old 100-an-hour lockout', () => {
    const { limiter: l } = limiter();
    for (let i = 0; i < 1000; i++) l.fail(spread(i));

    expect(l.globalFailures()).toBe(1000);
    expect(l.check('192.168.1.50')).toEqual({ ok: true });
    expect(l.delayMs()).toBe(SLOW_MAX_MS);
  });

  it('counts global failures over the last hour, by the minute', () => {
    const { clock, limiter: l } = limiter();
    clock.now = 100 * GLOBAL_BUCKET_MS;
    for (let i = 0; i < 20; i++) l.fail(`10.0.${i}.1`);
    expect(l.delayMs()).toBe(SLOW_BASE_MS);

    clock.now += GLOBAL_WINDOW_MS - GLOBAL_BUCKET_MS;
    for (let i = 0; i < 20; i++) l.fail(`10.1.${i}.1`);
    expect(l.globalFailures()).toBe(40);
    expect(l.delayMs()).toBe(2 * SLOW_BASE_MS);

    clock.now += GLOBAL_BUCKET_MS;
    expect(l.globalFailures()).toBe(20);
    clock.now += GLOBAL_WINDOW_MS;
    expect(l.globalFailures()).toBe(0);
    expect(l.delayMs()).toBe(0);
  });

  it('says loudly each time the slow-down grows, up to the cap', () => {
    const { log, limiter: l } = limiter();
    for (let i = 0; i < 200; i++) l.fail(spread(i));

    expect(log.mock.calls.map((call) => call[0])).toEqual(
      [
        [20, 0.625],
        [40, 1.25],
        [60, 2.5],
        [80, 5],
        [100, 10],
      ].map(([n, s]) => `[otherbench-server] SIGN-IN IS SLOWED DOWN FOR EVERYONE: ${n} wrong passwords in the last hour, so every attempt now waits ${s} s. Someone may be guessing.`)
    );
  });
});

describe('slowDownMs', () => {
  it('is nothing under 20 failures, then doubles with each 20 from 625 ms, capped at 10 s', () => {
    expect([0, 1, 19].map(slowDownMs)).toEqual([0, 0, 0]);
    expect([20, 39].map(slowDownMs)).toEqual([625, 625]);
    expect([40, 59, 60, 80, 99].map(slowDownMs)).toEqual([1250, 1250, 2500, 5000, 5000]);
    expect([100, 120, 10_000, 1_000_000].map(slowDownMs)).toEqual([10_000, 10_000, 10_000, 10_000]);
  });
});

/** Waits for real event-loop turns (setImmediate isn't faked) and says whether `p` has settled. */
async function settledYet<T>(p: Promise<T>): Promise<T | 'waiting'> {
  return Promise.race([p, new Promise<'waiting'>((r) => setImmediate(() => r('waiting')))]);
}

function track(p: Promise<Admission>): { result: Admission | null } {
  const box: { result: Admission | null } = { result: null };
  void p.then((r) => {
    box.result = r;
  });
  return box;
}

/** Releases a granted check with `outcome`; other admissions are left alone. */
const finish =
  (outcome: Outcome = 'right') =>
  (a: Admission): Admission => {
    if (a.kind === 'go') a.granted.release(outcome);
    return a;
  };

/** Takes both check slots with clean addresses and returns their releases. */
async function holdSlots(l: LoginLimiter): Promise<Array<() => void>> {
  const held: Array<() => void> = [];
  for (let i = 0; i < MAX_CONCURRENT_CHECKS; i++) {
    const a = await l.admit(`192.0.2.${i}`);
    if (a.kind !== 'go') throw new Error('expected a slot');
    held.push(() => a.granted.release('right'));
  }
  return held;
}

/** The most checks in any hour-long stretch of `times`. */
function worstHour(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let worst = 0;
  for (let i = 0, j = 0; j < sorted.length; j++) {
    while (sorted[j]! - sorted[i]! >= GLOBAL_WINDOW_MS) i++;
    worst = Math.max(worst, j - i + 1);
  }
  return worst;
}

describe('LoginLimiter.admit', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A limiter with `failures` wrong passwords in the window, none from one address more than 4 times. */
  function slowed(failures: number, opts: { maxDelayed?: number } = {}) {
    const clock = { now: 1_000_000_000 };
    const log = vi.fn();
    const l = new LoginLimiter({ now: () => clock.now, log, ...opts });
    for (let i = 0; i < failures; i++) l.fail(spread(i));
    return { clock, log, limiter: l };
  }

  it('lets an attempt straight into a check slot with fewer than 20 failures', async () => {
    const { limiter: l } = slowed(19);
    const a = await l.admit('10.0.0.1');

    expect(a).toMatchObject({ kind: 'go', waitedMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(l.stats().running).toBe(1);
    finish()(a);
    expect(l.stats().running).toBe(0);
  });

  it('holds an attempt for the delay on a timer, right password or wrong, then lets it go', async () => {
    const { clock, limiter: l } = slowed(40);
    const waiting = track(l.admit('10.0.0.1'));
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1249);
    expect(waiting.result).toBeNull();
    clock.now += 1250;
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.result).toMatchObject({ kind: 'go', waitedMs: 1250 });
  });

  it('caps the delay at 10 s however many failures there are, and still lets the attempt go', async () => {
    const { limiter: l } = slowed(5000);
    const waiting = track(l.admit('10.0.0.1'));

    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS - 1);
    expect(waiting.result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.result?.kind).toBe('go');
  });

  it('spends one token of the budget per check: 20 at hand, then one every 45 s, waiting up to 10 s for it', async () => {
    const { clock, limiter: l } = slowed(0);
    for (let i = 0; i < BUDGET_BURST; i++) {
      const a = finish()(await l.admit(`10.0.0.${i}`));
      expect(a).toMatchObject({ kind: 'go', waitedMs: 0 });
    }

    expect(await l.admit('10.0.1.1')).toEqual({ kind: 'busy', retryAfterSec: BUDGET_REFILL_MS / 1000, why: 'budget' });
    // No timer for the refusal; the one there is the log summary's.
    expect(vi.getTimerCount()).toBe(1);

    clock.now += BUDGET_REFILL_MS - SLOW_MAX_MS;
    const waiting = track(l.admit('10.0.1.1'));
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
    expect(waiting.result?.kind).toBe('go');
    // That token was 10 s off and is spent; the next comes 45 s after it.
    expect(await l.admit('10.0.1.2')).toEqual({ kind: 'busy', retryAfterSec: (SLOW_MAX_MS + BUDGET_REFILL_MS) / 1000, why: 'budget' });
  });

  it('lets a remembered device skip the budget and the delay, spending a device token instead', async () => {
    const { limiter: l } = slowed(5000);
    for (let i = 0; i < BUDGET_BURST; i++) void l.admit(`10.200.0.${i}`);
    expect((await l.admit('10.200.1.1')).kind).toBe('busy');

    const device = await l.admit('10.200.1.1', { device: 'device-a' });
    expect(device).toMatchObject({ kind: 'go', waitedMs: 0 });
    expect(l.stats().deviceBudget).toBe(DEVICE_BURST - 1);
    finish()(device);
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
  });

  it('gives remembered devices a budget of their own: 5 at hand, then one every 4 minutes', async () => {
    const { clock, limiter: l } = slowed(0);
    for (let i = 0; i < DEVICE_BURST; i++) expect(finish()(await l.admit('10.0.0.1', { device: `device-${i}` })).kind).toBe('go');

    expect(await l.admit('10.0.0.1', { device: 'device-9' })).toEqual({ kind: 'busy', retryAfterSec: DEVICE_REFILL_MS / 1000, why: 'budget' });
    clock.now += DEVICE_REFILL_MS;
    expect(finish()(await l.admit('10.0.0.1', { device: 'device-9' })).kind).toBe('go');
    // The ordinary budget is untouched.
    expect(l.stats().budget).toBe(BUDGET_BURST);
  });

  it('queues for a check slot instead of refusing, first come first served, with remembered devices ahead', async () => {
    const { limiter: l } = slowed(0);
    const [first, second] = await holdSlots(l);
    const a = track(l.admit('10.0.0.1'));
    const b = track(l.admit('10.0.0.2'));
    const device = track(l.admit('10.0.0.3', { device: 'device-a' }));
    await Promise.resolve();
    expect(l.stats()).toMatchObject({ waiting: 3, queued: 3, running: 2 });
    expect(vi.getTimerCount()).toBe(0);

    first!();
    await Promise.resolve();
    expect(device.result?.kind).toBe('go');
    expect(a.result).toBeNull();
    second!();
    await Promise.resolve();
    expect(a.result?.kind).toBe('go');
    expect(b.result).toBeNull();
    finish()(device.result!);
    await Promise.resolve();
    expect(b.result?.kind).toBe('go');
    expect(l.stats()).toMatchObject({ waiting: 0, queued: 0, running: 2 });
  });

  it('refuses past the waiting cap (5 of it kept for clean addresses and devices) and past 2 from one address (one IPv6 /64), at once and with no timer', async () => {
    const { limiter: l } = slowed(0, { maxDelayed: 8 });
    await holdSlots(l);
    for (let i = 0; i < MAX_DELAYED_PER_ADDRESS; i++) void l.admit('2001:db8:0:1::1');
    expect(await l.admit('2001:db8:0:1::2')).toEqual({ kind: 'busy', retryAfterSec: 1, why: 'places' });
    void l.admit('2001:db8:0:2::1');
    expect(l.stats()).toMatchObject({ waiting: 3, waitingAddresses: 2 });

    // An address that has failed may not take the 5 kept places: 3 are taken.
    l.fail('10.3.0.1');
    expect(await l.admit('10.3.0.1')).toEqual({ kind: 'busy', retryAfterSec: 1, why: 'places' });
    for (let i = 0; l.stats().waiting < 8; i++) void l.admit(`10.1.0.${i}`);
    expect(await l.admit('10.2.0.1')).toEqual({ kind: 'busy', retryAfterSec: 1, why: 'places' });
    expect(await l.admit('10.2.0.2', { device: 'device-a' })).toEqual({ kind: 'busy', retryAfterSec: 1, why: 'places' });
    // Only the log summary's.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('frees the place and clears the timer of an attempt whose client disconnects while it waits', async () => {
    const { limiter: l } = slowed(100);
    const gone = new AbortController();
    const leaving = track(l.admit('10.9.0.1', { signal: gone.signal }));
    expect(l.stats().waiting).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    gone.abort();
    await Promise.resolve();
    expect(leaving.result).toEqual({ kind: 'gone' });
    expect(l.stats()).toMatchObject({ waiting: 0, waitingAddresses: 0 });
    // Only the log summary's, which counts it as left before its check.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('takes an attempt that disconnects out of the queue for a slot', async () => {
    const { limiter: l } = slowed(0);
    const [first] = await holdSlots(l);
    const gone = new AbortController();
    const leaving = track(l.admit('10.0.0.1', { signal: gone.signal }));
    const next = track(l.admit('10.0.0.2'));
    await Promise.resolve();
    expect(l.stats().queued).toBe(2);

    gone.abort();
    await Promise.resolve();
    expect(leaving.result).toEqual({ kind: 'gone' });
    expect(l.stats()).toMatchObject({ waiting: 1, queued: 1 });
    first!();
    await Promise.resolve();
    expect(next.result?.kind).toBe('go');
  });

  it("doesn't wait at all, or charge anything, for a client that has already gone", async () => {
    const { limiter: l } = slowed(100);
    const gone = new AbortController();
    gone.abort();

    expect(await l.admit('192.168.9.9', { signal: gone.signal })).toEqual({ kind: 'gone' });
    expect(vi.getTimerCount()).toBe(0);
    expect(l.stats().waiting).toBe(0);
    expect(l.isClean('192.168.9.9')).toBe(true);
  });

  it('charges a failure to an address whose admitted attempt leaves or ends unchecked', async () => {
    const { limiter: l } = slowed(20);
    const before = l.globalFailures();
    for (let i = 0; i < 4; i++) {
      const gone = new AbortController();
      const leaving = l.admit('192.168.9.1', { signal: gone.signal });
      gone.abort();
      expect(await leaving).toEqual({ kind: 'gone' });
    }
    expect(l.isClean('192.168.9.1')).toBe(false);
    expect(l.check('192.168.9.1')).toEqual({ ok: true });
    const fifth = l.admit('192.168.9.1');
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
    finish('unchecked')(await fifth);

    expect(l.check('192.168.9.1').ok).toBe(false);
    expect(l.globalFailures()).toBe(before + 5);
    // No password file to check against isn't the client's doing.
    const unavailable = l.admit('192.168.9.2');
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
    finish('unavailable')(await unavailable);
    expect(l.isClean('192.168.9.2')).toBe(true);
  });

  it('locks a remembered device by its id after 5 wrong passwords, for a day, leaving its address alone', async () => {
    const { clock, limiter: l } = slowed(0);
    for (let i = 0; i < DEVICE_MAX_FAILURES; i++) {
      clock.now += DEVICE_REFILL_MS;
      finish('wrong')(await l.admit('10.0.0.1', { device: 'device-a' }));
    }

    expect(l.checkDevice('device-a').ok).toBe(false);
    expect(l.checkDevice('device-b')).toEqual({ ok: true });
    expect(l.check('10.0.0.1')).toEqual({ ok: true });
    expect(l.isClean('10.0.0.1')).toBe(true);
    clock.now += DEVICE_WINDOW_MS;
    expect(l.checkDevice('device-a')).toEqual({ ok: true });
  });

  it('clears a device id on a right password, and a locked address does not lock the device', async () => {
    const { clock, limiter: l } = slowed(0);
    for (let i = 0; i < DEVICE_MAX_FAILURES - 1; i++) finish('wrong')(await l.admit('10.0.0.1', { device: 'device-a' }));
    clock.now += DEVICE_REFILL_MS;
    finish('right')(await l.admit('10.0.0.1', { device: 'device-a' }));
    clock.now += DEVICE_REFILL_MS;
    finish('wrong')(await l.admit('10.0.0.1', { device: 'device-a' }));
    expect(l.checkDevice('device-a')).toEqual({ ok: true });

    for (let i = 0; i < MAX_FAILURES; i++) l.fail('10.0.0.1');
    expect(l.check('10.0.0.1').ok).toBe(false);
    expect(l.checkDevice('device-a')).toEqual({ ok: true });
  });
});

describe('Granted', () => {
  it('is good for one password check, not after it is released, and only the limiter makes one', async () => {
    const l = new LoginLimiter({ log: () => {} });
    const a = await l.admit('10.0.0.1');
    if (a.kind !== 'go') throw new Error('expected a check');

    expect(a.granted.spend()).toBe(true);
    expect(a.granted.spend()).toBe(false);
    a.granted.release('right');
    a.granted.release('wrong');
    expect(l.isClean('10.0.0.1')).toBe(true);
    expect(l.stats().running).toBe(0);

    const b = await l.admit('10.0.0.2');
    if (b.kind !== 'go') throw new Error('expected a check');
    b.granted.release('right');
    expect(b.granted.spend()).toBe(false);

    const Forge = Granted as unknown as new (issuer: symbol, settle: () => void) => Granted;
    expect(() => new Forge(Symbol('LoginLimiter'), () => {})).toThrow(/Only the sign-in limiter/);
  });
});

describe('LoginLimiter clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a lock when the system clock jumps, by default', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const l = new LoginLimiter({ log: () => {} });
    for (let i = 0; i < MAX_FAILURES; i++) l.fail('10.0.0.1');

    vi.setSystemTime(Date.now() + 2 * LOCK_MS);
    expect(l.check('10.0.0.1').ok).toBe(false);
    expect(monotonicNow()).toBeLessThan(Date.now());
  });
});

describe('LoginLimiter under an hour-long flood from many addresses', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at most 100 password checks in any hour, keeps every wait and map within its cap, and lets a remembered device in at once', async () => {
    const l = new LoginLimiter({ now: () => Date.now(), log: () => {} });
    const start = Date.now();
    const checks: number[] = [];
    let busy = 0;
    let next = 0;
    let maxWaiting = 0;
    let maxTimers = 0;
    let retryAfter = [Number.POSITIVE_INFINITY, 0];
    const attempt = (address: string) =>
      void l.admit(address).then((a) => {
        if (a.kind === 'busy') {
          busy += 1;
          retryAfter = [Math.min(retryAfter[0]!, a.retryAfterSec), Math.max(retryAfter[1]!, a.retryAfterSec)];
          return;
        }
        if (a.kind !== 'go') return;
        checks.push(Date.now());
        a.granted.release('wrong');
      });

    // Two hours of 10 new addresses a second, every one a wrong password.
    for (let second = 0; second < 2 * 3600; second++) {
      for (let i = 0; i < 10; i++) attempt(`10.${(next >> 16) & 255}.${(next >> 8) & 255}.${next++ & 255}`);
      maxWaiting = Math.max(maxWaiting, l.stats().waiting);
      // One timer may be the log summary's.
      maxTimers = Math.max(maxTimers, vi.getTimerCount() - 1);
      if (second === 5400) {
        // Mid-flood, a remembered device goes straight to a check.
        const device = finish()(await l.admit('192.168.1.50', { device: 'device-a' }));
        expect(device).toMatchObject({ kind: 'go', waitedMs: 0 });
      }
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);

    const worst = worstHour(checks);
    expect(worst).toBeLessThanOrEqual(100);
    expect(worst).toBeGreaterThanOrEqual(95);
    expect(checks.length).toBeLessThanOrEqual(100 + 80 + 1);
    expect(busy).toBe(72_000 - checks.length);
    // A token is at most 45 s past the 10 s an attempt may wait for one.
    expect(retryAfter[0]).toBeGreaterThanOrEqual(1);
    expect(retryAfter[1]).toBeLessThanOrEqual((BUDGET_REFILL_MS + SLOW_MAX_MS) / 1000);
    expect(maxWaiting).toBeLessThanOrEqual(MAX_DELAYED);
    expect(maxTimers).toBeLessThanOrEqual(MAX_DELAYED);
    expect(l.stats()).toMatchObject({ waiting: 0, queued: 0, running: 0 });
    expect(l.stats().tracked).toBeLessThanOrEqual(checks.length);
    expect(Date.now() - start).toBeGreaterThanOrEqual(2 * 3600 * 1000);
    // eslint-disable-next-line no-console
    console.log(`flood: ${checks.length} checks in 2 hours, at most ${worst} in any hour; ${busy} refused at once`);
  });

  it('runs at most 100 + 20 checks in any hour when device cookies are replayed too', async () => {
    const l = new LoginLimiter({ now: () => Date.now(), log: () => {} });
    const plain: number[] = [];
    const device: number[] = [];
    let next = 0;
    const attempt = (into: number[], address: string, deviceId?: string) =>
      void l.admit(address, deviceId ? { device: deviceId } : {}).then((a) => {
        if (a.kind !== 'go') return;
        into.push(Date.now());
        a.granted.release('wrong');
      });

    // Two hours: 10 new addresses a second, and 10 attempts a second with ever new (as if stolen) device cookies.
    for (let second = 0; second < 2 * 3600; second++) {
      for (let i = 0; i < 10; i++) {
        attempt(plain, `10.${(next >> 16) & 255}.${(next >> 8) & 255}.${next & 255}`);
        attempt(device, `172.16.${(next >> 8) & 255}.${next & 255}`, `stolen-${next}`);
        next += 1;
      }
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);

    expect(worstHour(plain)).toBeLessThanOrEqual(100);
    expect(worstHour(device)).toBeLessThanOrEqual(20);
    expect(worstHour([...plain, ...device])).toBeLessThanOrEqual(120);
    expect(l.stats().trackedDevices).toBeLessThanOrEqual(MAX_TRACKED);
    // eslint-disable-next-line no-console
    console.log(`with devices: at most ${worstHour(plain)} + ${worstHour(device)} = ${worstHour([...plain, ...device])} checks in any hour`);
  });
});

describe('LoginLimiter: the reserve for clean addresses', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls an address clean until it fails, its /64 included, for a day or until it signs in', () => {
    const { clock, limiter: l } = limiter();
    expect(l.isClean('10.0.0.1')).toBe(true);
    l.fail('10.0.0.1');
    expect(l.isClean('10.0.0.1')).toBe(false);
    expect(l.isClean('10.0.0.2')).toBe(true);
    l.fail('2001:db8:0:1::1');
    expect(l.isClean('2001:db8:0:1::99')).toBe(false);

    clock.now += CLEAN_WINDOW_MS - 1;
    expect(l.isClean('10.0.0.1')).toBe(false);
    clock.now += 1;
    expect(l.isClean('10.0.0.1')).toBe(true);

    l.fail('10.0.0.4');
    l.succeed('10.0.0.4');
    expect(l.isClean('10.0.0.4')).toBe(true);
  });

  it('remembers a bounded number of failed addresses for the reserve', () => {
    const { limiter: l } = limiter(2);
    l.fail('10.0.0.1');
    l.fail('10.0.0.2');
    l.fail('10.0.0.3');

    expect(l.isClean('10.0.0.1')).toBe(true);
    expect(l.isClean('10.0.0.3')).toBe(false);
  });

  it('keeps 5 of the 20 tokens from addresses that have failed, for a clean one', async () => {
    const { limiter: l } = limiter();
    for (let i = 0; i < 30; i++) l.fail(`10.7.0.${i}`);
    for (let i = 0; i < BUDGET_BURST - BUDGET_RESERVED; i++) void l.admit(`10.7.0.${i}`);
    expect(await l.admit('10.7.0.20')).toMatchObject({ kind: 'busy', why: 'budget' });
    expect(l.stats().budget).toBe(BUDGET_RESERVED);

    const clean = await settledYet(l.admit('192.168.1.50'));
    expect(clean === 'waiting' ? 'waiting' : clean.kind).not.toBe('busy');
    expect(l.stats().budget).toBe(BUDGET_RESERVED - 1);
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
  });

  it('can be spent by fresh addresses, at most 2 tokens each, which are then not clean for a day', async () => {
    const { limiter: l } = limiter();
    for (let i = 0; i < 30; i++) l.fail(`10.7.0.${i}`);
    for (let i = 0; i < BUDGET_BURST - BUDGET_RESERVED; i++) void l.admit(`10.7.0.${i}`);

    const grabbed: string[] = [];
    for (const fresh of ['203.0.113.1', '203.0.113.1', '203.0.113.1', '203.0.113.2', '203.0.113.2', '203.0.113.3']) {
      const a = await settledYet(l.admit(fresh));
      grabbed.push(a === 'waiting' ? a : a.kind);
    }
    // Each waits out the delay on a token; the third from .1 is over its 2 places; .3 takes the last token.
    expect(grabbed).toEqual(['waiting', 'waiting', 'busy', 'waiting', 'waiting', 'waiting']);
    expect(l.stats().budget).toBe(0);
    expect(await l.admit('192.168.1.50')).toMatchObject({ kind: 'busy', why: 'budget' });
    l.fail('203.0.113.1');
    expect(l.isClean('203.0.113.1')).toBe(false);
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
  });

  it('serves a clean address ahead of the rest in the queue for a check slot, after remembered devices', async () => {
    const { limiter: l } = limiter();
    const held = await holdSlots(l);
    l.fail('10.0.0.1');
    const order: string[] = [];
    const note = (name: string) => (a: Admission) => {
      order.push(name);
      finish()(a);
    };
    void l.admit('10.0.0.1').then(note('dirty'));
    void l.admit('10.0.0.2').then(note('clean'));
    void l.admit('10.0.0.3', { device: 'device-a' }).then(note('device'));
    await Promise.resolve();

    held[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['device', 'clean', 'dirty']);
  });
});

describe('LoginLimiter under an hour-long flood that tries to spend the reserve', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Every five minutes someone signs in correctly from a clean address of their own; how long each waited, or -1 when refused. */
  function cleanSignIns(l: LoginLimiter, second: number, waits: number[]): void {
    if (second % 300 !== 150) return;
    const started = Date.now();
    void l.admit(`192.168.${second % 256}.${Math.floor(second / 256)}`).then((a) => {
      if (a.kind !== 'go') {
        waits.push(-1);
        return;
      }
      waits.push(Date.now() - started);
      a.granted.release('right');
    });
  }

  it('admits a clean address every time within its 10 s wait while addresses that have failed flood, and runs at most 100 checks in any hour', async () => {
    const l = new LoginLimiter({ now: () => Date.now(), log: () => {} });
    // 4000 addresses that have each guessed wrong once (as many as 4 per address go before a lock).
    const pool = Array.from({ length: 4000 }, (_, i) => `10.${(i >> 8) & 255}.${i & 255}.1`);
    for (const address of pool) l.fail(address);
    const checks: number[] = [];
    const waits: number[] = [];
    let next = 0;
    const attacker = () => {
      const address = pool[next++ % pool.length]!;
      if (!l.check(address).ok) return;
      void l.admit(address).then((a) => {
        if (a.kind !== 'go') return;
        checks.push(Date.now());
        a.granted.release('wrong');
      });
    };

    for (let second = 0; second < 3600; second++) {
      for (let i = 0; i < 10; i++) attacker();
      cleanSignIns(l, second, waits);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);

    expect(waits).toHaveLength(12);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(SLOW_MAX_MS + 1000);
    expect(worstHour(checks)).toBeLessThanOrEqual(100);
    // eslint-disable-next-line no-console
    console.log(`dirty flood: ${checks.length} checks in the hour; clean sign-ins waited at most ${Math.max(...waits)} ms`);
  });

  it('keeps a clean address that leaves every attempt from keeping a second clean address out', async () => {
    const l = new LoginLimiter({ now: () => Date.now(), log: () => {} });
    // Enough failures elsewhere that every attempt waits, so it can walk away mid-wait.
    for (let i = 0; i < 20; i++) l.fail(spread(i));
    const waits: number[] = [];
    let polls = 0;

    for (let second = 0; second < 3600; second++) {
      // The poller: once a second, from one address, takes a place and leaves before its check.
      if (l.check('203.0.113.7').ok) {
        const gone = new AbortController();
        void l.admit('203.0.113.7', { signal: gone.signal }).then((a) => finish('wrong')(a));
        polls += 1;
        gone.abort();
      }
      cleanSignIns(l, second, waits);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);

    expect(waits).toHaveLength(12);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(SLOW_MAX_MS + 1000);
    // Five walk-aways lock it; it gets about 5 tries per lock, not one a second.
    expect(polls).toBeLessThanOrEqual(5 * Math.ceil(3600_000 / LOCK_MS) + 5);
    expect(l.isClean('203.0.113.7')).toBe(false);
  });
});

describe('LoginLimiter.note', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs each wrong password until the slow-down starts, then a count a minute', async () => {
    const { clock, log, limiter: l } = limiter();
    clock.now = 10 * GLOBAL_BUCKET_MS;
    l.note('wrong', '10.0.0.1');
    expect(log).toHaveBeenLastCalledWith('[otherbench-server] wrong password from 10.0.0.1');

    for (let i = 0; i < 20; i++) l.fail(spread(i));
    log.mockClear();
    for (let i = 0; i < 30; i++) l.note('wrong', `10.0.0.${i % 3}`);
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(GLOBAL_BUCKET_MS);
    expect(log.mock.calls).toEqual([['[otherbench-server] sign-in in the last minute: 30 wrong passwords, from 3 addresses']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('folds a flood of refusals into one line a minute, with a count per reason and a capped count of addresses', async () => {
    const { clock, log, limiter: l } = limiter();
    clock.now = 10 * GLOBAL_BUCKET_MS;
    const reasons: LogReason[] = ['budget', 'places', 'locked', 'abandoned', 'no-password-file'];
    for (let i = 0; i < 50_000; i++) l.note(reasons[i % reasons.length]!, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(GLOBAL_BUCKET_MS);
    expect(log.mock.calls).toEqual([
      [
        `[otherbench-server] sign-in in the last minute: 10000 told to wait (budget spent), 10000 told to wait (too many waiting), 10000 refused while locked, 10000 left before their check, 10000 refused (no password file), from at least ${MAX_SUMMARY_ADDRESSES} addresses`,
      ],
    ]);
  });

  it('writes the summary out a minute at a time across a long flood', async () => {
    const { clock, log, limiter: l } = limiter();
    for (let minute = 0; minute < 60; minute++) {
      for (let i = 0; i < 100; i++) l.note('budget', `10.0.0.${i}`);
      clock.now += GLOBAL_BUCKET_MS;
      await vi.advanceTimersByTimeAsync(GLOBAL_BUCKET_MS);
    }

    expect(log.mock.calls.length).toBeLessThanOrEqual(60);
  });
});

describe('tooManyMessage', () => {
  it('rounds up to whole minutes', () => {
    expect(tooManyMessage(900)).toBe('Too many tries. Try again in 15 minutes.');
    expect(tooManyMessage(841)).toBe('Too many tries. Try again in 15 minutes.');
    expect(tooManyMessage(61)).toBe('Too many tries. Try again in 2 minutes.');
    expect(tooManyMessage(60)).toBe('Too many tries. Try again in a minute.');
    expect(tooManyMessage(1)).toBe('Too many tries. Try again in a minute.');
  });
});
