import { describe, expect, it, vi } from 'vitest';
import { FAILURE_WINDOW_MS, GLOBAL_WINDOW_MS, LOCK_MS, LoginLimiter, tooManyMessage } from '../../src/remote/limiter.js';

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

  it('closes sign-in for everyone for the rest of the hour after 100 failures, and says so loudly once', () => {
    const { clock, log, limiter: l } = limiter();
    for (let i = 0; i < 100; i++) l.fail(`10.0.${Math.floor(i / 4)}.${i % 4}`);

    const check = l.check('192.168.1.50');
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.retryAfterSec).toBe(GLOBAL_WINDOW_MS / 1000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/sign-in is closed for everyone/i);

    clock.now += GLOBAL_WINDOW_MS;
    expect(l.check('192.168.1.50')).toEqual({ ok: true });
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

describe('tooManyMessage', () => {
  it('rounds up to whole minutes', () => {
    expect(tooManyMessage(900)).toBe('Too many tries. Try again in 15 minutes.');
    expect(tooManyMessage(841)).toBe('Too many tries. Try again in 15 minutes.');
    expect(tooManyMessage(61)).toBe('Too many tries. Try again in 2 minutes.');
    expect(tooManyMessage(60)).toBe('Too many tries. Try again in a minute.');
    expect(tooManyMessage(1)).toBe('Too many tries. Try again in a minute.');
  });
});
