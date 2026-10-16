import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PANE_STATE } from './panes.js';
import { useOtherBenchStore } from './store.js';
import { usePaneShortcuts } from './usePaneShortcuts.js';

const press = (init: KeyboardEventInit): boolean => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

let unmount: () => void = () => {};

beforeEach(() => {
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ paneState: DEFAULT_PANE_STATE, activeChatId: null });
  for (const id of ['a', 'b', 'c']) useOtherBenchStore.getState().openTab(id);
});

afterEach(() => unmount());

describe('usePaneShortcuts (#824)', () => {
  it('Ctrl+Tab and Ctrl+Shift+Tab cycle through the tabs, wrapping round', () => {
    ({ unmount } = renderHook(() => usePaneShortcuts(false)));
    useOtherBenchStore.getState().setActiveChatId('c');
    press({ key: 'Tab', ctrlKey: true });
    expect(useOtherBenchStore.getState().activeChatId).toBe('a');
    press({ key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(useOtherBenchStore.getState().activeChatId).toBe('c');
  });

  it('Ctrl+2 or Alt+2 focuses pane 2; Ctrl+Shift+Enter maximises and restores', () => {
    ({ unmount } = renderHook(() => usePaneShortcuts(false)));
    useOtherBenchStore.getState().setLayout('columns-3');
    expect(press({ key: '2', code: 'Digit2', ctrlKey: true })).toBe(false);
    expect(useOtherBenchStore.getState().paneState.focusedPane).toBe(1);
    press({ key: '3', code: 'Digit3', altKey: true });
    expect(useOtherBenchStore.getState().paneState.focusedPane).toBe(2);
    press({ key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(useOtherBenchStore.getState().paneState.maximised).toBe(true);
    press({ key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(useOtherBenchStore.getState().paneState.maximised).toBe(false);
  });

  it('leaves the keys alone with one pane, a pane that does not exist, or a narrow window', () => {
    ({ unmount } = renderHook(() => usePaneShortcuts(false)));
    expect(press({ key: '2', code: 'Digit2', ctrlKey: true })).toBe(true);
    useOtherBenchStore.getState().setLayout('columns-2');
    expect(press({ key: '4', code: 'Digit4', ctrlKey: true })).toBe(true);
    unmount();
    ({ unmount } = renderHook(() => usePaneShortcuts(true)));
    expect(press({ key: '2', code: 'Digit2', ctrlKey: true })).toBe(true);
    expect(press({ key: 'Enter', ctrlKey: true, shiftKey: true })).toBe(true);
  });
});
