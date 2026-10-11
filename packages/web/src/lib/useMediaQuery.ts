import { useSyncExternalStore } from 'react';

/** Below this width the inspector can no longer sit as a third docked column -- it collapses (task 19 brief). */
export const NARROW_BREAKPOINT = '(max-width: 1099.98px)';

/**
 * Reactive `window.matchMedia` subscription. Used to drive the "inspector
 * collapses below ~1100px" layout rule (App.tsx, and each pane's header)
 * directly off the viewport rather than a resize-event polling loop. An
 * engine without matchMedia (jsdom, very old webviews) never matches.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false
  );
}
