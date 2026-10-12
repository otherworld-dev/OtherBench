import { describe, expect, it } from 'vitest';
import { LiveCallCache, LiveCallLimiter, shapeLiveResult } from '../src/live-calls.js';

describe('LiveCallCache', () => {
  it('keeps a result for 30 seconds from when it was stored, then forgets it', () => {
    let t = 1000;
    const cache = new LiveCallCache(() => t);
    cache.set('k', { text: 'x', at: 1000 });
    t += 29_999;
    expect(cache.get('k')).toEqual({ text: 'x', at: 1000 });
    t += 1;
    expect(cache.get('k')).toBeNull();
  });

  it('a later set replaces the entry and restarts its 30 seconds', () => {
    let t = 0;
    const cache = new LiveCallCache(() => t);
    cache.set('k', { text: 'old', at: 0 });
    t = 20_000;
    cache.set('k', { text: 'new', at: 20_000 });
    t = 45_000;
    expect(cache.get('k')).toEqual({ text: 'new', at: 20_000 });
  });

  it('keeps at most 100 entries, dropping the oldest', () => {
    const cache = new LiveCallCache(() => 0);
    for (let i = 0; i < 101; i++) cache.set(`k${i}`, { text: String(i), at: 0 });
    expect(cache.get('k0')).toBeNull();
    expect(cache.get('k1')).toEqual({ text: '1', at: 0 });
    expect(cache.get('k100')).toEqual({ text: '100', at: 0 });
  });
});

describe('LiveCallLimiter', () => {
  it('lets 4 calls run at once per artifact, and another once one finishes', () => {
    const limiter = new LiveCallLimiter(() => 0);
    for (let i = 0; i < 4; i++) expect(limiter.tryStart('art')).toBe(true);
    expect(limiter.tryStart('art')).toBe(false);
    expect(limiter.tryStart('other')).toBe(true);
    limiter.finish('art');
    expect(limiter.tryStart('art')).toBe(true);
  });

  it('allows 30 starts in a rolling minute per artifact', () => {
    let t = 0;
    const limiter = new LiveCallLimiter(() => t);
    for (let i = 0; i < 30; i++) {
      expect(limiter.tryStart('art')).toBe(true);
      limiter.finish('art');
      t += 1000;
    }
    expect(limiter.tryStart('art')).toBe(false);
    t = 60_000; // the first start (t=0) is now a minute old
    expect(limiter.tryStart('art')).toBe(true);
  });
});

describe('shapeLiveResult', () => {
  it('joins text blocks, sets json only when the whole text parses, passes structured through and drops other content', () => {
    expect(shapeLiveResult([{ type: 'text', text: '{"a":1}' }], undefined)).toEqual({ ok: true, text: '{"a":1}', json: { a: 1 } });
    expect(shapeLiveResult([{ type: 'text', text: 'one' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'two' }], { n: 1 })).toEqual({ ok: true, text: 'one\ntwo', structured: { n: 1 } });
    expect(shapeLiveResult([{ type: 'text', text: '{"a":1} trailing' }], undefined)).toEqual({ ok: true, text: '{"a":1} trailing' });
    expect(shapeLiveResult([], undefined)).toEqual({ ok: true, text: '' });
    expect(shapeLiveResult('not a list', undefined)).toEqual({ ok: true, text: '' });
  });

  it('refuses over 1 MB of text and structured JSON together', () => {
    const half = 'x'.repeat(600 * 1024);
    expect(shapeLiveResult([{ type: 'text', text: half }], { blob: half })).toMatchObject({ ok: false, code: 'too_large' });
    expect(shapeLiveResult([{ type: 'text', text: half }], undefined)).toMatchObject({ ok: true });
  });
});
