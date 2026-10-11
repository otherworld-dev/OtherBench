import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMediaQuery } from './useMediaQuery.js';

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

describe('useMediaQuery', () => {
  it('is false when the engine has no matchMedia', () => {
    // @ts-expect-error -- simulating an engine without it
    window.matchMedia = undefined;
    expect(renderHook(() => useMediaQuery('(max-width: 10px)')).result.current).toBe(false);
  });
});
