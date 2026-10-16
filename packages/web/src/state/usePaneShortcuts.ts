import { useEffect } from 'react';
import { useOtherBenchStore } from './store.js';

/**
 * Keyboard for tabs and panes (#824):
 *  - Ctrl+1..4 (or Alt+1..4, which a browser leaves alone) focuses that pane.
 *  - Ctrl+Tab / Ctrl+Shift+Tab moves to the next / previous tab. A browser
 *    keeps Ctrl+Tab for its own tabs; the desktop app gets it.
 *  - Ctrl+Shift+Enter maximises the focused pane, or puts it back.
 * Pane shortcuts do nothing in a narrow window, which shows one pane.
 */
export function usePaneShortcuts(narrow: boolean): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const { paneState, activeChatId, focusPane, setActiveChatId, toggleMaximised } = useOtherBenchStore.getState();
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key === 'Tab') {
        const tabs = paneState.tabs;
        if (tabs.length === 0) return;
        e.preventDefault();
        const at = activeChatId ? tabs.indexOf(activeChatId) : -1;
        const step = e.shiftKey ? -1 : 1;
        const next = at === -1 ? (e.shiftKey ? tabs.length - 1 : 0) : (at + step + tabs.length) % tabs.length;
        setActiveChatId(tabs[next]!);
        return;
      }

      if (narrow) return;

      if (ctrl && e.shiftKey && !e.altKey && e.key === 'Enter') {
        if (paneState.panes.length < 2) return;
        e.preventDefault();
        toggleMaximised();
        return;
      }

      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (digit && !e.shiftKey && (ctrl !== e.altKey)) {
        const index = Number(digit) - 1;
        if (index >= paneState.panes.length || paneState.panes.length < 2) return;
        e.preventDefault();
        focusPane(index);
      }
    }
    // Capture, so the message box's own Enter handling never sees Ctrl+Shift+Enter.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [narrow]);
}
