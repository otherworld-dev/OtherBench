import { useEffect } from 'react';
import { selectPendingApprovalCount, useGruntStore } from '../state/store.js';
import { setTrayStatus } from './bridge.js';

/**
 * Keeps the desktop tray's tooltip showing how many tool calls are waiting
 * for approval anywhere in the app (from the app-wide event stream), so a
 * reply blocked on one is visible while the window is hidden. Nothing
 * happens in a browser.
 */
export function useTrayStatus(): void {
  const pending = useGruntStore(selectPendingApprovalCount);
  useEffect(() => {
    setTrayStatus(pending).catch((err: unknown) => console.error('[grunt-web] failed to update the tray status:', err));
  }, [pending]);
}
