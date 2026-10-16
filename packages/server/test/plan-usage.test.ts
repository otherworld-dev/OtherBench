import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import { PLAN_USAGE_MAX_AGE_MS, PLAN_USAGE_MIN_REFRESH_MS, PlanUsageCache } from '../src/plan-usage.js';

const reading = (percent: number, fetchedAt = 0): PlanUsage => ({ fetchedAt, windows: [{ id: 'five_hour', label: '5-hour', percent, resetsAt: null }] });

describe('PlanUsageCache', () => {
  let now = 1_000_000;
  const clock = () => now;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('serves a reading for 5 minutes, then reads again', async () => {
    const read = vi.fn<() => Promise<PlanUsage | null>>().mockResolvedValueOnce(reading(7)).mockResolvedValueOnce(reading(9));
    const cache = new PlanUsageCache(read, clock);
    expect(await cache.get()).toEqual(reading(7));
    now += PLAN_USAGE_MAX_AGE_MS - 1;
    expect(await cache.get()).toEqual(reading(7));
    now += 1;
    expect(await cache.get()).toEqual(reading(9));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads again on a refresh once the reading is 30 s old, not before', async () => {
    const read = vi.fn<() => Promise<PlanUsage | null>>().mockResolvedValueOnce(reading(7)).mockResolvedValueOnce(reading(8));
    const cache = new PlanUsageCache(read, clock);
    await cache.get();
    now += PLAN_USAGE_MIN_REFRESH_MS - 1;
    expect(await cache.get(true)).toEqual(reading(7));
    now += 1;
    expect(await cache.get(true)).toEqual(reading(8));
  });

  it('shares one read between requests that arrive together', async () => {
    let finish!: (u: PlanUsage) => void;
    const read = vi.fn(() => new Promise<PlanUsage | null>((r) => (finish = r)));
    const cache = new PlanUsageCache(read, clock);
    const a = cache.get();
    const b = cache.get(true);
    finish(reading(5));
    expect(await Promise.all([a, b])).toEqual([reading(5), reading(5)]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous reading when a read fails, and waits until the next is due before trying again', async () => {
    const read = vi.fn<() => Promise<PlanUsage | null>>().mockResolvedValueOnce(reading(7)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(reading(10));
    const cache = new PlanUsageCache(read, clock);
    await cache.get();
    now += PLAN_USAGE_MAX_AGE_MS;
    expect(await cache.get()).toEqual(reading(7));
    expect(await cache.get()).toEqual(reading(7));
    expect(read).toHaveBeenCalledTimes(2);
    now += PLAN_USAGE_MAX_AGE_MS;
    expect(await cache.get()).toEqual(reading(10));
  });

  it('is null with no reading yet, when the first read fails or the login has no plan', async () => {
    expect(await new PlanUsageCache(() => Promise.reject(new Error('no claude')), clock).get()).toBeNull();
    expect(await new PlanUsageCache(async () => null, clock).get()).toBeNull();
  });
});
