import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Overview } from '@otherbench/core/types/overview.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, overview: { get: vi.fn(), refresh: vi.fn(), tickIssue: vi.fn(), tickOlder: vi.fn() } } };
});

import { api } from '../state/api.js';
import { emitAppEvent } from '../state/appEventListeners.js';
import { useOtherBenchStore } from '../state/store.js';
import { useOverview } from './useOverview.js';

const overview = (total: number): Overview => ({ checkedAt: 1, checking: false, githubLogin: null, loginMismatches: [], unreachableMachines: [], total, tiles: [] });

describe('useOverview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    vi.mocked(api.overview.get).mockReset().mockResolvedValue(overview(3));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('fetches on mount into the store', async () => {
    renderHook(() => useOverview());
    await act(async () => {});
    expect(api.overview.get).toHaveBeenCalledTimes(1);
    expect(useOtherBenchStore.getState().overview?.total).toBe(3);
  });

  it('refetches once after two events within 500 ms', async () => {
    renderHook(() => useOverview());
    await act(async () => {});
    vi.mocked(api.overview.get).mockClear();
    act(() => {
      emitAppEvent({ type: 'overview-changed' });
      vi.advanceTimersByTime(300);
      emitAppEvent({ type: 'turn-finished', chatId: 'c', messageId: 'm', status: 'complete' });
    });
    expect(api.overview.get).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(499);
    });
    expect(api.overview.get).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(api.overview.get).toHaveBeenCalledTimes(1);
  });

  it('a steady stream of events still refetches within 2 s of the first', async () => {
    renderHook(() => useOverview());
    await act(async () => {});
    vi.mocked(api.overview.get).mockClear();
    // An event every 300 ms, at 0 to 1500 ms: the 500 ms debounce on its own would never fire.
    for (let t = 0; t < 1800; t += 300) {
      act(() => emitAppEvent({ type: 'overview-changed' }));
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
    }
    act(() => emitAppEvent({ type: 'overview-changed' }));
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(api.overview.get).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(api.overview.get).toHaveBeenCalledTimes(1);
  });

  it.each([['peer-status'], ['peers-changed']] as const)('refetches on %s', async (type) => {
    renderHook(() => useOverview());
    await act(async () => {});
    vi.mocked(api.overview.get).mockClear();
    act(() => {
      emitAppEvent(type === 'peers-changed' ? { type } : { type, nodeId: 'n', status: 'unreachable', since: 1 });
    });
    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    expect(api.overview.get).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated events and stops listening on unmount', async () => {
    const { unmount } = renderHook(() => useOverview());
    await act(async () => {});
    vi.mocked(api.overview.get).mockClear();
    act(() => emitAppEvent({ type: 'schedules-changed' }));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(api.overview.get).not.toHaveBeenCalled();
    unmount();
    act(() => emitAppEvent({ type: 'overview-changed' }));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(api.overview.get).not.toHaveBeenCalled();
  });
});
