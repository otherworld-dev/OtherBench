import { useEffect, useEffectEvent } from 'react';
import { onDesktopEvent } from '../../desktop/bridge.js';

/**
 * The tray menu's "New chat" does exactly what the button does. The effect
 * event keeps the one subscription pointed at the latest `createChat`, which
 * closes over the current profiles.
 */
export function useTrayNewChat(createChat: () => Promise<void>): void {
  const newChat = useEffectEvent(() => void createChat());
  useEffect(() => {
    let off: (() => void) | null = null;
    let disposed = false;
    void onDesktopEvent('tray-new-chat', () => newChat()).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
}
