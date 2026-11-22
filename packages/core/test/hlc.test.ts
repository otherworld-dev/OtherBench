import { describe, expect, it } from 'vitest';
import { HLC_MAX_AHEAD_MS, Hlc, compareHlc, encodeHlc, hlcTooFarAhead, maxHlc, parseHlc } from '../src/domain/hlc.js';

function clock(start: number): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (v) => (t = v) };
}

describe('Hlc', () => {
  it('stamps sort as strings, by time, then counter, then node', () => {
    expect(encodeHlc(5, 3, 'pc')).toBe('0000000000005-0003-pc');
    expect(compareHlc(encodeHlc(5, 0, 'pc'), encodeHlc(6, 0, 'a'))).toBeLessThan(0);
    expect(compareHlc(encodeHlc(5, 2, 'pc'), encodeHlc(5, 10, 'a'))).toBeLessThan(0);
    expect(compareHlc(encodeHlc(5, 1, 'a'), encodeHlc(5, 1, 'b'))).toBeLessThan(0);
    expect(compareHlc('', encodeHlc(0, 0, 'a'))).toBeLessThan(0);
    expect(maxHlc('', encodeHlc(1, 0, 'a'))).toBe(encodeHlc(1, 0, 'a'));
    expect(parseHlc('0000000000005-0003-pc')).toEqual({ ms: 5, counter: 3 });
  });

  it('stays monotonic when the wall clock stands still or goes backwards', () => {
    const c = clock(1000);
    const hlc = new Hlc('pc', c.now);
    const stamps = [hlc.tick(), hlc.tick()];
    c.set(500);
    stamps.push(hlc.tick(), hlc.tick());
    c.set(2000);
    stamps.push(hlc.tick());
    for (let i = 1; i < stamps.length; i++) expect(compareHlc(stamps[i - 1]!, stamps[i]!)).toBeLessThan(0);
    expect(stamps[4]).toBe(encodeHlc(2000, 0, 'pc'));
  });

  it('observe moves past a remote stamp from a clock that runs ahead', () => {
    const c = clock(1000);
    const hlc = new Hlc('laptop', c.now);
    const remote = encodeHlc(5000, 7, 'pc');
    hlc.observe(remote);
    expect(compareHlc(hlc.tick(), remote)).toBeGreaterThan(0);
    // An older remote stamp changes nothing visible.
    const before = hlc.tick();
    hlc.observe(encodeHlc(10, 0, 'pc'));
    expect(compareHlc(hlc.tick(), before)).toBeGreaterThan(0);
  });

  it('moves a millisecond ahead rather than overflowing the counter', () => {
    const hlc = new Hlc('pc', () => 1000);
    let last = '';
    for (let i = 0; i < 10_005; i++) last = hlc.tick();
    expect(parseHlc(last).ms).toBe(1001);
  });

  it('started after a stamp, stays later than it though the wall clock is behind it', () => {
    const last = encodeHlc(9000, 4, 'pc');
    const hlc = new Hlc('pc', () => 1000, last);
    const first = hlc.tick();
    expect(compareHlc(first, last)).toBeGreaterThan(0);
    expect(compareHlc(hlc.tick(), first)).toBeGreaterThan(0);
    // With the wall clock past it, the wall clock is what stamps read.
    expect(new Hlc('pc', () => 20_000, last).tick()).toBe(encodeHlc(20_000, 0, 'pc'));
  });

  it('does not follow a remote stamp further ahead of the wall clock than the limit', () => {
    const wall = 1_000_000;
    const hlc = new Hlc('laptop', () => wall);
    const near = encodeHlc(wall + HLC_MAX_AHEAD_MS, 0, 'pc');
    const far = encodeHlc(wall + HLC_MAX_AHEAD_MS + 1, 0, 'pc');
    expect(hlcTooFarAhead(near, wall)).toBe(false);
    expect(hlcTooFarAhead(far, wall)).toBe(true);

    expect(hlc.observe(far)).toBe(false);
    expect(hlc.tick()).toBe(encodeHlc(wall, 0, 'laptop'));

    expect(hlc.observe(near)).toBe(true);
    expect(compareHlc(hlc.tick(), near)).toBeGreaterThan(0);
  });
});
