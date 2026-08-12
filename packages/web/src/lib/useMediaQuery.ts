import { useSyncExternalStore } from 'react';

/**
 * Reactive `window.matchMedia` subscription. Used to drive the "inspector
 * collapses below ~1100px" layout rule (App.tsx) directly off the viewport
 * rather than a resize-event polling loop.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}
