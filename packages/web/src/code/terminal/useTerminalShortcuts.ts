import { useEffect } from 'react';
import { useOtherBenchStore } from '../../state/store.js';

/**
 * VS Code's terminal keys, in Code mode only (spec 2026-10-21-code-terminal-design, "Keys"): Ctrl+` opens the Code
 * panel on the Terminal tab and focuses the terminal (the tab starts one if the app has none); Ctrl+Shift+` opens a
 * new one. Matched on the physical key, so a keyboard layout with another character there still works.
 */
export function useTerminalShortcuts(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.code !== 'Backquote' || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const { mode, setCodePanelTab, setInspectorCollapsed, requestTerminal } = useOtherBenchStore.getState();
      if (mode !== 'code') return;
      e.preventDefault();
      setCodePanelTab('terminal');
      setInspectorCollapsed(false);
      requestTerminal(e.shiftKey ? 'new' : 'focus');
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
