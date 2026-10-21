import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOtherBenchStore } from '../../state/store.js';
import { useTerminalShortcuts } from './useTerminalShortcuts.js';

const press = (init: KeyboardEventInit): boolean => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
let unmount: () => void = () => {};

beforeEach(() => {
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
});
afterEach(() => unmount());

describe('useTerminalShortcuts', () => {
  it('Ctrl+backquote opens the terminal tab in Code mode, expanded, and asks for focus', () => {
    useOtherBenchStore.setState({ mode: 'code', codePanelTab: 'issues', inspectorCollapsed: true });
    ({ unmount } = renderHook(() => useTerminalShortcuts()));
    expect(press({ key: '`', code: 'Backquote', ctrlKey: true })).toBe(false);
    const s = useOtherBenchStore.getState();
    expect(s.codePanelTab).toBe('terminal');
    expect(s.inspectorCollapsed).toBe(false);
    expect(s.terminalRequest).toMatchObject({ kind: 'focus' });
  });

  it('Ctrl+Shift+backquote asks for a new terminal', () => {
    useOtherBenchStore.setState({ mode: 'code' });
    ({ unmount } = renderHook(() => useTerminalShortcuts()));
    press({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true });
    expect(useOtherBenchStore.getState().terminalRequest).toMatchObject({ kind: 'new' });
  });

  it('does nothing in Chat mode', () => {
    useOtherBenchStore.setState({ mode: 'chat', codePanelTab: 'issues' });
    ({ unmount } = renderHook(() => useTerminalShortcuts()));
    expect(press({ key: '`', code: 'Backquote', ctrlKey: true })).toBe(true);
    expect(useOtherBenchStore.getState().codePanelTab).toBe('issues');
    expect(useOtherBenchStore.getState().terminalRequest).toBeNull();
  });
});
