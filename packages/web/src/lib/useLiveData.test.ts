import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { emitAppEvent, emitAppEventsHello } from '../state/appEventListeners.js';
import { LIVE_DEBOUNCE_MS, LIVE_MAX_WAIT_MS, useLiveData } from './useLiveData.js';

const grantsOf = (chatId: string) => (e: AppEvent) => e.type === 'grants-changed' && (e.chatId === null || e.chatId === chatId);

/** Lets the fetch promises settle. */
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

describe('useLiveData', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('fetches once on mount and not again on a timer', async () => {
    const fetcher = vi.fn().mockResolvedValue(['a']);
    const { result } = renderHook(() => useLiveData(fetcher, ['chat-1'], grantsOf('chat-1')));
    await settle();
    expect(result.current.data).toEqual(['a']);

    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches after a matching event, once for a burst, and ignores the rest', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(['a']).mockResolvedValue(['a', 'b']);
    const { result } = renderHook(() => useLiveData(fetcher, ['chat-1'], grantsOf('chat-1')));
    await settle();

    act(() => {
      emitAppEvent({ type: 'grants-changed', chatId: 'chat-2' });
      emitAppEvent({ type: 'audit-changed', chatId: 'chat-1' });
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS * 2)));
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => {
      emitAppEvent({ type: 'grants-changed', chatId: 'chat-1' });
      emitAppEvent({ type: 'grants-changed', chatId: null });
      emitAppEvent({ type: 'grants-changed', chatId: 'chat-1' });
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS)));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(['a', 'b']);
  });

  it('a steady stream of events still refetches within LIVE_MAX_WAIT_MS of the first', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    renderHook(() => useLiveData(fetcher, [], (e) => e.type === 'audit-changed'));
    await settle();
    for (let t = 0; t < LIVE_MAX_WAIT_MS; t += LIVE_DEBOUNCE_MS / 2) {
      act(() => emitAppEvent({ type: 'audit-changed', chatId: 'chat-1' }));
      await act(async () => void (await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS / 2)));
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refetches on a hello, as events may have been missed while disconnected', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    renderHook(() => useLiveData(fetcher, [], () => false));
    await settle();

    act(() => emitAppEventsHello());
    await act(async () => void (await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS)));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the data showing during a refetch, and only a deps change goes back to loading', async () => {
    const pending: ((v: string[]) => void)[] = [];
    const fetcher = vi.fn().mockResolvedValueOnce(['a']).mockImplementation(() => new Promise<string[]>((r) => pending.push(r)));
    const { result, rerender } = renderHook(({ chatId }) => useLiveData(fetcher, [chatId], grantsOf(chatId)), { initialProps: { chatId: 'chat-1' } });
    await settle();

    act(() => emitAppEvent({ type: 'grants-changed', chatId: 'chat-1' }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS)));
    expect(pending).toHaveLength(1);
    expect(result.current.data).toEqual(['a']);

    rerender({ chatId: 'chat-2' });
    expect(result.current.data).toBeNull();
    expect(pending).toHaveLength(2);
    // The answer to chat-1's refetch lands after the switch: dropped.
    await act(async () => {
      pending[0]!(['stale']);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data).toBeNull();
    await act(async () => {
      pending[1]!(['chat-2']);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data).toEqual(['chat-2']);
  });

  it('stops listening when unmounted', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const { unmount } = renderHook(() => useLiveData(fetcher, [], () => true));
    await settle();
    unmount();
    emitAppEvent({ type: 'mcp-changed', serverId: null });
    emitAppEventsHello();
    await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS * 2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetch() asks now, without waiting for an event', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(['a']).mockResolvedValue(['b']);
    const { result } = renderHook(() => useLiveData(fetcher, [], () => false));
    await settle();
    act(() => result.current.refetch());
    await settle();
    expect(result.current.data).toEqual(['b']);
  });
});
