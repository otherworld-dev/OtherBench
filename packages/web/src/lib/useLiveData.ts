import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { onAppEvent, onAppEventsHello } from '../state/appEventListeners.js';
import { useChanged } from './useChanged.js';

/** How long a refetch waits after an event for the rest of a burst (a reconnect, a turn's tool calls). */
export const LIVE_DEBOUNCE_MS = 200;
/** However steady the events (a reply making tool call after tool call), a refetch comes within this long of the first. */
export const LIVE_MAX_WAIT_MS = 1000;

/**
 * Fetches `fetcher` now, and again whenever `deps` changes (switching chats),
 * then refetches when the server says the data changed: an app event for
 * which `refetchOn` is true, on the one `GET /api/events` connection
 * `useAppEvents` holds (no connection of its own), or a hello from it, as
 * events may have been missed while it was down. Refetches wait
 * LIVE_DEBOUNCE_MS so a burst of events reads once, but never more than
 * LIVE_MAX_WAIT_MS after the first of them. A refetch updates the data
 * in place; only a `deps` change goes back to loading (`data` null). An
 * answer older than the latest request is dropped. `refetch` asks for one now,
 * for an action the caller has just taken.
 *
 * Backs the Inspector's MCP servers, Tool grants and Audit trail sections and
 * Settings > MCP servers, which polled every 4 s before these events existed.
 */
export function useLiveData<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  refetchOn: (event: AppEvent) => boolean
): { data: T | null; failed: boolean; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  // The caller's latest fetcher and filter, without either restarting the effect.
  const fetchNow = useEffectEvent(() => fetcher());
  const wanted = useEffectEvent((event: AppEvent) => refetchOn(event));
  const refetchRef = useRef<() => void>(() => {});

  // New deps go back to loading in the same render, so the old chat's data is never drawn under the new one.
  if (useChanged(deps)) {
    setData(null);
    setFailed(false);
  }

  useEffect(() => {
    let disposed = false;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** When the first event since the last read came. */
    let waitingSince: number | null = null;

    function load(): void {
      const request = ++latest;
      fetchNow()
        .then((result) => {
          if (disposed || request !== latest) return;
          setData(result);
          setFailed(false);
        })
        .catch((err: unknown) => {
          console.error('[otherbench-web] useLiveData fetch failed:', err);
          if (!disposed && request === latest) setFailed(true);
        });
    }

    function later(): void {
      const now = Date.now();
      waitingSince ??= now;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = null;
          waitingSince = null;
          load();
        },
        Math.max(0, Math.min(LIVE_DEBOUNCE_MS, waitingSince + LIVE_MAX_WAIT_MS - now))
      );
    }

    load();
    refetchRef.current = load;
    const offEvent = onAppEvent((event) => {
      if (wanted(event)) later();
    });
    const offHello = onAppEventsHello(later);
    return () => {
      disposed = true;
      offEvent();
      offHello();
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is the caller's own explicit restart list, not derivable from `fetcher`'s identity.
  }, deps);

  return { data, failed, refetch: () => refetchRef.current() };
}
