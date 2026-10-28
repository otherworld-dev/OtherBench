import { useEffect } from 'react';
import { useOtherBenchStore, WINDOW_ROLE } from '../state/store.js';
import { isDesktop, onDesktopEvent, setHotkey } from './bridge.js';
import { loadHotkey } from './hotkey.js';

/**
 * The main window's side of the desktop shell's quick chat (v2 plan, Task
 * 37): registers the saved hotkey at startup, recording the outcome for
 * Settings → Desktop (a taken key shows there rather than failing
 * silently), and opens a chat the quick window hands over with Expand. The
 * hotkey is the main window's alone; an undocked Code window still opens the
 * chats its notifications are clicked for.
 */
export function useDesktopShell(): void {
  useEffect(() => {
    if (!isDesktop()) return;
    if (WINDOW_ROLE === 'main') {
      const accelerator = loadHotkey();
      setHotkey(accelerator)
        .then(() => useOtherBenchStore.getState().setHotkeyStatus({ accelerator, error: null }))
        .catch((err: unknown) => useOtherBenchStore.getState().setHotkeyStatus({ accelerator, error: String(err) }));
    }

    let off: (() => void) | null = null;
    let disposed = false;
    void onDesktopEvent<string>('open-chat', (chatId) => useOtherBenchStore.getState().setActiveChatId(chatId)).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
}
