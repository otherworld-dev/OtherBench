import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Admission,
  BUDGET_BURST,
  BUDGET_REFILL_MS,
  BUDGET_RESERVED,
  CLEAN_WINDOW_MS,
  FAILURE_WINDOW_MS,
  GLOBAL_BUCKET_MS,
  GLOBAL_WINDOW_MS,
  LOCK_MS,
  LoginLimiter,
  MAX_CONCURRENT_CHECKS,
  MAX_DELAYED,
  MAX_DELAYED_PER_ADDRESS,
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
      ].map(([n, s]) => `[grunt-server] SIGN-IN IS SLOWED DOWN FOR EVERYONE: ${n} wrong passwords in the last hour, so every attempt now waits ${s} s. Someone may be guessing.`)
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

describe('LoginLimiter.admit', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A limiter with `failures` wrong passwords in the window, none from one address more than 4 times. */
  function slowed(failures: number) {
    const fx = limiter();
    for (let i = 0; i < failures; i++) fx.limiter.fail(spread(i));
    return fx;
  }

  function track(p: Promise<Admission>): { result: Admission | null } {
    const box: { result: Admission | null } = { result: null };
    void p.then((r) => {
      box.result = r;
    });
    return box;
  }

  /** Takes both check slots and returns their releases. */
  async function holdSlots(l: LoginLimiter): Promise<Array<() => void>> {
    const held: Array<() => void> = [];
    for (let i = 0; i < MAX_CONCURRENT_CHECKS; i++) {
      const a = await l.admit(`192.0.2.${i}`, { device: true });
      if (a.kind !== 'go') throw new Error('expected a slot');
      held.push(a.release);
    }
    return held;
  }

  it('lets an attempt straight into a check slot with fewer than 20 failures', async () => {
    const { limiter: l } = slowed(19);
    const a = await l.admit('10.0.0.1');

    expect(a).toMatchObject({ kind: 'go', waitedMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(l.stats().running).toBe(1);
    if (a.kind === 'go') a.release();
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
    const { clock, limiter: l } = limiter();
    for (let i = 0; i < BUDGET_BURST; i++) {
      const a = await l.admit(`10.0.0.${i}`);
      expect(a).toMatchObject({ kind: 'go', waitedMs: 0 });
      if (a.kind === 'go') a.release();
    }

    expect(await l.admit('10.0.1.1')).toEqual({ kind: 'busy', retryAfterSec: BUDGET_REFILL_MS / 1000, why: 'budget' });
    expect(vi.getTimerCount()).toBe(0);

    clock.now += BUDGET_REFILL_MS - SLOW_MAX_MS;
    const waiting = track(l.admit('10.0.1.1'));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
    expect(waiting.result?.kind).toBe('go');
    // That token was 10 s off and is spent; the next comes 45 s after it.
    expect(await l.admit('10.0.1.2')).toEqual({ kind: 'busy', retryAfterSec: (SLOW_MAX_MS + BUDGET_REFILL_MS) / 1000, why: 'budget' });
  });

  it('lets a remembered device skip the budget and the delay', async () => {
    const { limiter: l } = slowed(5000);
    for (let i = 0; i < BUDGET_BURST; i++) void l.admit(`10.200.0.${i}`);
    expect((await l.admit('10.200.1.1')).kind).toBe('busy');
    expect(l.stats().waiting).toBe(BUDGET_BURST);

    const device = await l.admit('10.200.1.1', { device: true });
    expect(device).toMatchObject({ kind: 'go', waitedMs: 0 });
    if (device.kind === 'go') device.release();
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
  });

  it('queues for a check slot instead of refusing, first come first served, with remembered devices ahead', async () => {
    const { limiter: l } = limiter();
    const [first, second] = await holdSlots(l);
    const a = track(l.admit('10.0.0.1'));
    const b = track(l.admit('10.0.0.2'));
    const device = track(l.admit('10.0.0.3', { device: true }));
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
    if (device.result?.kind === 'go') device.result.release();
    await Promise.resolve();
    expect(b.result?.kind).toBe('go');
    expect(l.stats()).toMatchObject({ waiting: 0, queued: 0, running: 2 });
  });

  it('refuses past 50 waiting at once, and past 2 from one address (one IPv6 /64), at once and with no timer', async () => {
    const { limiter: l } = limiter();
    await holdSlots(l);
    for (let i = 0; i < MAX_DELAYED_PER_ADDRESS; i++) void l.admit('2001:db8:0:1::1', { device: true });
    expect(await l.admit('2001:db8:0:1::2', { device: true })).toEqual({ kind: 'busy', retryAfterSec: 1, why: 'places' });
    void l.admit('2001:db8:0:2::1', { device: true });
    expect(l.stats()).toMatchObject({ waiting: 3, waitingAddresses: 2 });

    for (let i = 0; l.stats().waiting < MAX_DELAYED; i++) void l.admit(`10.1.0.${i}`, { device: true });
    expect(l.stats().waiting).toBe(MAX_DELAYED);
    expect(await l.admit('10.2.0.1', { device: true })).toEqual({ kind: 'busy', retryAfterSec: 1, why: 'places' });
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
  });

  it('takes an attempt that disconnects out of the queue for a slot', async () => {
    const { limiter: l } = limiter();
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

  it("doesn't wait at all for a client that has already gone", async () => {
    const { limiter: l } = slowed(100);
    const gone = new AbortController();
    gone.abort();

    expect(await l.admit('10.0.0.1', { signal: gone.signal })).toEqual({ kind: 'gone' });
    expect(vi.getTimerCount()).toBe(0);
    expect(l.stats().waiting).toBe(0);
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
    const l = new LoginLimiter({ log: () => {} });
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
          retryAfter = [Math.min(retryAfter[0], a.retryAfterSec), Math.max(retryAfter[1], a.retryAfterSec)];
          return;
        }
        if (a.kind !== 'go') return;
        checks.push(Date.now());
        l.fail(address);
        a.release();
      });

    // Two hours of 10 new addresses a second, every one a wrong password.
    for (let second = 0; second < 2 * 3600; second++) {
      for (let i = 0; i < 10; i++) attempt(`10.${(next >> 16) & 255}.${(next >> 8) & 255}.${next++ & 255}`);
      maxWaiting = Math.max(maxWaiting, l.stats().waiting);
      maxTimers = Math.max(maxTimers, vi.getTimerCount());
      if (second === 5400) {
        // Mid-flood, a remembered device goes straight to a check.
        const device = await l.admit('192.168.1.50', { device: true });
        expect(device).toMatchObject({ kind: 'go', waitedMs: 0 });
        if (device.kind === 'go') device.release();
      }
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);

    let worst = 0;
    for (let i = 0, j = 0; j < checks.length; j++) {
      while (checks[j]! - checks[i]! >= GLOBAL_WINDOW_MS) i++;
      worst = Math.max(worst, j - i + 1);
    }
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
});

describe('LoginLimiter: the reserve for clean addresses', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls an address clean until it guesses wrong, its /64 included, for a day or until it signs in', () => {
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

  it('remembers a bounded number of wrong-password addresses for the reserve', () => {
    const { limiter: l } = limiter(2);
    l.fail('10.0.0.1');
    l.fail('10.0.0.2');
    l.fail('10.0.0.3');

    expect(l.isClean('10.0.0.1')).toBe(true);
    expect(l.isClean('10.0.0.3')).toBe(false);
  });

  it('keeps 5 of the 20 tokens from addresses that have guessed wrong, for a clean one', async () => {
    const { limiter: l } = limiter();
    for (let i = 0; i < 30; i++) l.fail(`10.7.0.${i}`);
    for (let i = 0; i < BUDGET_BURST - BUDGET_RESERVED; i++) void l.admit(`10.7.0.${i}`);
    expect(await l.admit('10.7.0.20')).toMatchObject({ kind: 'busy', why: 'budget' });
    expect(l.stats().budget).toBe(BUDGET_RESERVED);

    const clean = await Promise.race([l.admit('192.168.1.50'), new Promise<null>((r) => setImmediate(() => r(null)))]);
    expect(clean?.kind ?? 'waiting').not.toBe('busy');
    expect(l.stats().budget).toBe(BUDGET_RESERVED - 1);
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
  });

  it('can be spent by fresh addresses, at most 2 tokens each, which are then not clean for a day', async () => {
    const { limiter: l } = limiter();
    for (let i = 0; i < 30; i++) l.fail(`10.7.0.${i}`);
    for (let i = 0; i < BUDGET_BURST - BUDGET_RESERVED; i++) void l.admit(`10.7.0.${i}`);

    const grabbed: string[] = [];
    for (const fresh of ['203.0.113.1', '203.0.113.1', '203.0.113.1', '203.0.113.2', '203.0.113.2', '203.0.113.3']) {
      grabbed.push(await Promise.race([l.admit(fresh).then((a) => a.kind), new Promise<string>((r) => setImmediate(() => r('waiting')))]));
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
    const held: Array<() => void> = [];
    for (let i = 0; i < MAX_CONCURRENT_CHECKS; i++) {
      const a = await l.admit(`192.0.2.${i}`, { device: true });
      if (a.kind === 'go') held.push(a.release);
    }
    l.fail('10.0.0.1');
    const order: string[] = [];
    const note = (name: string) => (a: Admission) => {
      order.push(name);
      if (a.kind === 'go') a.release();
    };
    void l.admit('10.0.0.1').then(note('dirty'));
    void l.admit('10.0.0.2').then(note('clean'));
    void l.admit('10.0.0.3', { device: true }).then(note('device'));
    await Promise.resolve();

    held[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['device', 'clean', 'dirty']);
  });
});

describe('LoginLimiter under an hour-long flood from addresses that keep guessing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits a clean address every time within its 10 s wait, and still runs at most 100 checks in any hour', async () => {
    const l = new LoginLimiter({ log: () => {} });
    // 4000 addresses that have each guessed wrong once (as many as 4 per address go before a lock).
    const pool = Array.from({ length: 4000 }, (_, i) => `10.${(i >> 8) & 255}.${i & 255}.1`);
    for (const address of pool) l.fail(address);
    const checks: number[] = [];
    const cleanWaits: number[] = [];
    let next = 0;
    let refusedClean = 0;
    const attacker = () => {
      const address = pool[next++ % pool.length]!;
      if (!l.check(address).ok) return;
      void l.admit(address).then((a) => {
        if (a.kind !== 'go') return;
        checks.push(Date.now());
        l.fail(address);
        a.release();
      });
    };

    for (let second = 0; second < 3600; second++) {
      for (let i = 0; i < 10; i++) attacker();
      if (second % 300 === 150) {
        // Every five minutes, someone signs in correctly from a clean address of their own.
        const started = Date.now();
        void l.admit(`192.168.${second % 256}.${Math.floor(second / 256)}`).then((a) => {
          if (a.kind !== 'go') {
            refusedClean += 1;
            return;
          }
          checks.push(Date.now());
          cleanWaits.push(Date.now() - started);
          a.release();
        });
      }
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);

    expect(refusedClean).toBe(0);
    expect(cleanWaits).toHaveLength(12);
    expect(Math.max(...cleanWaits)).toBeLessThanOrEqual(SLOW_MAX_MS + 1000);
    let worst = 0;
    for (let i = 0, j = 0; j < checks.length; j++) {
      while (checks[j]! - checks[i]! >= GLOBAL_WINDOW_MS) i++;
      worst = Math.max(worst, j - i + 1);
    }
    expect(worst).toBeLessThanOrEqual(100);
    // eslint-disable-next-line no-console
    console.log(`dirty flood: ${checks.length} checks in the hour, at most ${worst} in any hour; clean sign-ins waited at most ${Math.max(...cleanWaits)} ms`);
  });
});

describe('LoginLimiter.noteWrong', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs each wrong password until the slow-down starts, then a count a minute', async () => {
    const { clock, log, limiter: l } = limiter();
    clock.now = 10 * GLOBAL_BUCKET_MS;
    l.noteWrong('10.0.0.1');
    expect(log).toHaveBeenLastCalledWith('[grunt-server] wrong password from 10.0.0.1');

    for (let i = 0; i < 20; i++) l.fail(spread(i));
    log.mockClear();
    for (let i = 0; i < 30; i++) l.noteWrong(`10.0.0.${i % 3}`);
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(GLOBAL_BUCKET_MS);
    expect(log.mock.calls).toEqual([['[grunt-server] 30 wrong passwords in the last minute from 3 addresses']]);
    expect(vi.getTimerCount()).toBe(0);
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
