import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAILURE_WINDOW_MS,
  GLOBAL_BUCKET_MS,
  GLOBAL_WINDOW_MS,
  LOCK_MS,
  LoginLimiter,
  MAX_DELAYED,
  SLOW_BASE_MS,
  SLOW_MAX_MS,
  slowDownMs,
  type SlowDown,
  tooManyMessage,
} from '../../src/remote/limiter.js';

function limiter(maxTracked?: number) {
  const clock = { now: 1_000_000_000 };
  const log = vi.fn();
  return { clock, log, limiter: new LoginLimiter({ now: () => clock.now, log, ...(maxTracked !== undefined ? { maxTracked } : {}) }) };
}

describe('LoginLimiter', () => {
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

  it('never refuses because of the global count, even far past the old 100-an-hour lockout', () => {
    const { limiter: l } = limiter();
    for (let i = 0; i < 1000; i++) l.fail(`10.${Math.floor(i / 1000)}.${Math.floor(i / 4) % 250}.${i % 4}`);

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
    for (let i = 0; i < 200; i++) l.fail(`10.0.${Math.floor(i / 4)}.${i % 4}`);

    expect(log.mock.calls.map((call) => call[0])).toEqual(
      [[20, 0.625], [40, 1.25], [60, 2.5], [80, 5], [100, 10]].map(
        ([n, s]) => `[grunt-server] SIGN-IN IS SLOWED DOWN FOR EVERYONE: ${n} wrong passwords in the last hour, so every attempt now waits ${s} s. Someone may be guessing.`
      )
    );
  });

  it('runs at most two checks at once', () => {
    const { limiter: l } = limiter();
    const a = l.acquire();
    const b = l.acquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(l.acquire()).toBeNull();

    a!();
    a!();
    const c = l.acquire();
    expect(c).not.toBeNull();
    expect(l.acquire()).toBeNull();
  });

  it('tracks a bounded number of addresses, dropping the oldest', () => {
    const { limiter: l } = limiter(2);
    for (let i = 0; i < 5; i++) l.fail('10.0.0.1');
    l.fail('10.0.0.2');
    l.fail('10.0.0.3');

    expect(l.check('10.0.0.1')).toEqual({ ok: true });
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

describe('LoginLimiter.slowDown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A limiter with `failures` wrong passwords in the window, none from one address more than 4 times. */
  function slowed(failures: number) {
    const fx = limiter();
    for (let i = 0; i < failures; i++) fx.limiter.fail(`10.${Math.floor(i / 1000)}.${Math.floor(i / 4) % 250}.${i % 4}`);
    return fx;
  }

  function track(p: Promise<SlowDown>): { result: SlowDown | null } {
    const box: { result: SlowDown | null } = { result: null };
    void p.then((r) => {
      box.result = r;
    });
    return box;
  }

  it('lets an attempt straight through with fewer than 20 failures', async () => {
    const { limiter: l } = slowed(19);

    expect(await l.slowDown()).toEqual({ kind: 'go', delayedMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds an attempt for the delay on a timer, then lets it go', async () => {
    const { limiter: l } = slowed(40);
    const waiting = track(l.slowDown());

    await vi.advanceTimersByTimeAsync(1249);
    expect(waiting.result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.result).toEqual({ kind: 'go', delayedMs: 1250 });
  });

  it('caps the delay at 10 s however many failures there are, and still lets the attempt go', async () => {
    const { limiter: l } = slowed(5000);
    const waiting = track(l.slowDown());

    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS - 1);
    expect(waiting.result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.result).toEqual({ kind: 'go', delayedMs: SLOW_MAX_MS });
  });

  it('refuses attempts past 50 waiting at once with a Retry-After of the delay, until one finishes', async () => {
    const { limiter: l } = slowed(100);
    const waiting = Array.from({ length: MAX_DELAYED }, () => track(l.slowDown()));

    expect(await l.slowDown()).toEqual({ kind: 'busy', retryAfterSec: 10 });

    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
    expect(waiting.every((w) => w.result?.kind === 'go')).toBe(true);
    const next = track(l.slowDown());
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
    expect(next.result).toEqual({ kind: 'go', delayedMs: SLOW_MAX_MS });
  });

  it('rounds a short delay up to a 1 s Retry-After', async () => {
    const { limiter: l } = slowed(20);
    for (let i = 0; i < MAX_DELAYED; i++) void l.slowDown();

    expect(await l.slowDown()).toEqual({ kind: 'busy', retryAfterSec: 1 });
    await vi.advanceTimersByTimeAsync(SLOW_BASE_MS);
  });

  it('frees the place of an attempt whose client disconnects, at once', async () => {
    const { limiter: l } = slowed(100);
    const gone = new AbortController();
    const leaving = track(l.slowDown(gone.signal));
    for (let i = 1; i < MAX_DELAYED; i++) void l.slowDown();
    expect((await l.slowDown()).kind).toBe('busy');

    gone.abort();
    await Promise.resolve();
    expect(leaving.result).toEqual({ kind: 'gone' });
    const instead = track(l.slowDown());
    expect((await l.slowDown()).kind).toBe('busy');

    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
    expect(instead.result).toEqual({ kind: 'go', delayedMs: SLOW_MAX_MS });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("doesn't wait at all for a client that has already gone", async () => {
    const { limiter: l } = slowed(100);
    const gone = new AbortController();
    gone.abort();

    expect(await l.slowDown(gone.signal)).toEqual({ kind: 'gone' });
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
