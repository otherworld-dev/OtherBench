import { useEffect, useRef } from 'react';
import { useOtherBenchStore } from '../state/store.js';

/**
 * When the Code tab's GitHub and git data should be fetched again (spec
 * 2026-10-20-code-tab-design, "Calls I made": when the window is focused,
 * after each completed turn in an app chat, and from a manual refresh, with
 * no file watcher). Calls `onRefresh` on the window's `focus`, and whenever
 * the app event stream says a turn finished in one of `appId`'s chats. The
 * events come through the one `/api/events` connection `useAppEvents` keeps
 * (as `lastTurnFinished` in the store), never a second one. The manual
 * refresh is the caller's own button. The latest `onRefresh` is always the
 * one called, so it needn't be memoised. Shared by the Issues tab and the
 * git bar.
 */
export function useCodeRefresh(appId: string, onRefresh: () => void): void {
  const latest = useRef(onRefresh);
  useEffect(() => {
    latest.current = onRefresh;
  });
  useEffect(() => {
    const onFocus = (): void => latest.current();
    window.addEventListener('focus', onFocus);
    const off = useOtherBenchStore.subscribe((state, prev) => {
      const finished = state.lastTurnFinished;
      if (finished === null || finished === prev.lastTurnFinished) return;
      // The chat's app as this window knows it: a chat it hasn't loaded can't be told apart, so it's left out.
      if (state.chats.find((c) => c.id === finished.chatId)?.appId === appId) latest.current();
    });
    return () => {
      window.removeEventListener('focus', onFocus);
      off();
    };
  }, [appId]);
}
