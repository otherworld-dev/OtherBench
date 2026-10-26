import { useEffect } from 'react';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { api } from '../state/api.js';
import { onAppEvent } from '../state/appEventListeners.js';
import { useOtherBenchStore } from '../state/store.js';

/** Events after which the Overview may have changed; `peer-status` and `peers-changed` move its unreachable-machines list. */
const REFETCH_ON: ReadonlySet<AppEvent['type']> = new Set<AppEvent['type']>([
  'overview-changed', 'chat-created', 'chat-updated', 'chat-deleted', 'turn-finished',
  'approval-requested', 'approval-resolved', 'peer-activity', 'sync-applied', 'peer-status', 'peers-changed',
]);

const DEBOUNCE_MS = 500;
/** However steady the events, a refetch comes within this long of the first one waiting. */
const MAX_WAIT_MS = 2000;

/**
 * Keeps the store's Overview current (spec 2026-10-26-overview). Mounted once
 * in `App`: fetches on mount, then again, debounced, after any event that may
 * change it, and at most MAX_WAIT_MS after the first of a run of events, so a
 * steady stream doesn't put it off for good. A failed fetch keeps what was showing.
 */
export function useOverview(): void {
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** When the first event since the last refetch came. */
    let waitingSince: number | null = null;
    const fetchOverview = (): void => {
      api.overview
        .get()
        .then((overview) => {
          if (!disposed) useOtherBenchStore.getState().setOverview(overview);
        })
        .catch((err: unknown) => console.error('[otherbench-web] failed to load the overview:', err));
    };
    fetchOverview();
    const off = onAppEvent((event) => {
      if (!REFETCH_ON.has(event.type)) return;
      const now = Date.now();
      waitingSince ??= now;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = null;
          waitingSince = null;
          fetchOverview();
        },
        Math.max(0, Math.min(DEBOUNCE_MS, waitingSince + MAX_WAIT_MS - now)),
      );
    });
    return () => {
      disposed = true;
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
