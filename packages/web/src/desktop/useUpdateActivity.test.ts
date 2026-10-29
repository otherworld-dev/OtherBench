import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let desktop = true;
vi.mock('./bridge.js', () => ({ isDesktop: () => desktop, reportActivity: vi.fn(async () => {}) }));

import { setUnsent } from '../state/unsent.js';
import { reportActivity } from './bridge.js';
import { ACTIVITY_EVERY_MS, useUpdateActivity } from './useUpdateActivity.js';

const reported = vi.mocked(reportActivity);
const key = (): boolean => window.dispatchEvent(new KeyboardEvent('keydown'));

beforeEach(() => {
  desktop = true;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  setUnsent('composer-1', false);
  reported.mockClear();
  vi.useRealTimers();
});

describe('useUpdateActivity', () => {
  it('reports input at most once every 30 seconds', () => {
    expect(ACTIVITY_EVERY_MS).toBe(30_000);
    renderHook(() => useUpdateActivity());
    expect(reported).toHaveBeenCalledTimes(1);
    key();
    key();
    expect(reported).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    key();
    expect(reported).toHaveBeenCalledTimes(2);
    expect(reported).toHaveBeenLastCalledWith(false);
  });

  it('reports a change in unsent text straight away', () => {
    renderHook(() => useUpdateActivity());
    setUnsent('composer-1', true);
    expect(reported).toHaveBeenLastCalledWith(true);
    setUnsent('composer-1', false);
    expect(reported).toHaveBeenLastCalledWith(false);
  });

  it('does nothing outside the desktop app', () => {
    desktop = false;
    renderHook(() => useUpdateActivity());
    key();
    setUnsent('composer-1', true);
    expect(reported).not.toHaveBeenCalled();
  });
});
