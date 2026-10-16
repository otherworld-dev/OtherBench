import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, (payload: unknown) => void>();
vi.mock('./bridge.js', () => ({
  isDesktop: () => true,
  setHotkey: vi.fn(),
  onDesktopEvent: vi.fn(async (name: string, cb: (payload: unknown) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

import { useOtherBenchStore } from '../state/store.js';
import { setHotkey } from './bridge.js';
import { HOTKEY_STORAGE_KEY } from './hotkey.js';
import { useDesktopShell } from './useDesktopShell.js';

const mockedSetHotkey = vi.mocked(setHotkey);

describe('useDesktopShell', () => {
  beforeEach(() => {
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    window.localStorage.clear();
    listeners.clear();
    mockedSetHotkey.mockReset();
  });

  it('registers the saved hotkey (default Ctrl+Alt+G) at startup and records that it worked', async () => {
    mockedSetHotkey.mockResolvedValue(undefined);
    renderHook(() => useDesktopShell());
    expect(mockedSetHotkey).toHaveBeenCalledWith('Ctrl+Alt+G');
    await waitFor(() => expect(useOtherBenchStore.getState().hotkeyStatus).toEqual({ accelerator: 'Ctrl+Alt+G', error: null }));
  });

  it('records why a saved hotkey could not be registered, for Settings to show', async () => {
    window.localStorage.setItem(HOTKEY_STORAGE_KEY, 'Ctrl+Shift+Q');
    mockedSetHotkey.mockRejectedValue('HotKey already registered');
    renderHook(() => useDesktopShell());
    await waitFor(() => expect(useOtherBenchStore.getState().hotkeyStatus).toEqual({ accelerator: 'Ctrl+Shift+Q', error: 'HotKey already registered' }));
  });

  it('opens a chat the quick window hands over', async () => {
    mockedSetHotkey.mockResolvedValue(undefined);
    renderHook(() => useDesktopShell());
    await waitFor(() => expect(listeners.has('open-chat')).toBe(true));
    listeners.get('open-chat')!('c9');
    expect(useOtherBenchStore.getState().activeChatId).toBe('c9');
  });
});
