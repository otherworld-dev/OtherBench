import { useSyncExternalStore } from 'react';

/** Whether this window has focus, kept current from its focus and blur events. */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('focus', onChange);
      window.addEventListener('blur', onChange);
      return () => {
        window.removeEventListener('focus', onChange);
        window.removeEventListener('blur', onChange);
      };
    },
    () => document.hasFocus(),
    () => false
  );
}
