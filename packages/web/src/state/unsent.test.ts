import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasUnsentText, onUnsentChange, setUnsent } from './unsent.js';

afterEach(() => {
  setUnsent('a', false);
  setUnsent('b', false);
});

describe('unsent text', () => {
  it('is there while any composer holds text', () => {
    expect(hasUnsentText()).toBe(false);
    setUnsent('a', true);
    setUnsent('b', false);
    expect(hasUnsentText()).toBe(true);
    setUnsent('a', false);
    expect(hasUnsentText()).toBe(false);
  });

  it('forgets a composer that goes away', () => {
    setUnsent('a', true);
    setUnsent('a', false); // what an unmounting composer reports
    expect(hasUnsentText()).toBe(false);
  });

  it('says when the answer changes, and only then', () => {
    const seen = vi.fn();
    const off = onUnsentChange(seen);
    setUnsent('a', true);
    setUnsent('b', true);
    setUnsent('a', false);
    setUnsent('b', false);
    off();
    setUnsent('a', true);
    expect(seen.mock.calls).toEqual([[true], [false]]);
  });
});
