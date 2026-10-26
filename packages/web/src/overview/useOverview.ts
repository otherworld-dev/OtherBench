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

/**
 * Keeps the store's Overview current (spec 2026-10-26-overview). Mounted once
 * in `App`: fetches on mount, then again, debounced, after any event that may
 * change it. A failed fetch keeps what was showing.
 */
export function useOverview(): void {
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
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
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fetchOverview();
      }, DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
