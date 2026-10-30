import { useEffect } from 'react';
import { hasUnsentText, onUnsentChange } from '../state/unsent.js';
import { isDesktop, reportActivity } from './bridge.js';

/** Input is reported at most this often: the updater only needs to know Adam was here in the last 10 minutes. */
export const ACTIVITY_EVERY_MS = 30_000;

function report(unsent: boolean): void {
  reportActivity(unsent).catch((err: unknown) => console.error('[otherbench-web] failed to report activity to the updater:', err));
}

/**
 * Tells the desktop updater (desktop/src-tauri/src/update.rs) when Adam uses
 * this window, and at once when unsent text appears or goes, so an update
 * never restarts the app under him or loses a half-typed message. Every app
 * window runs it; nothing happens in a browser.
 */
export function useUpdateActivity(): void {
  useEffect(() => {
    if (!isDesktop()) return;
    let last = Date.now();
    report(hasUnsentText());
    const onInput = (): void => {
      if (Date.now() - last < ACTIVITY_EVERY_MS) return;
      last = Date.now();
      report(hasUnsentText());
    };
    const options = { capture: true, passive: true } as const;
    window.addEventListener('keydown', onInput, options);
    window.addEventListener('pointerdown', onInput, options);
    window.addEventListener('wheel', onInput, options);
    const off = onUnsentChange((has) => {
      last = Date.now();
      report(has);
    });
    return () => {
      window.removeEventListener('keydown', onInput, options);
      window.removeEventListener('pointerdown', onInput, options);
      window.removeEventListener('wheel', onInput, options);
      off();
    };
  }, []);
}
