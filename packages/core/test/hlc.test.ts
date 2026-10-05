import { describe, expect, it } from 'vitest';
import { Hlc, compareHlc, encodeHlc, maxHlc, parseHlc } from '../src/domain/hlc.js';

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
});
