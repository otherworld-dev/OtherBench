import { useEffect, useRef } from 'react';
import { onDesktopEvent } from '../../desktop/bridge.js';

/**
 * The tray menu's "New chat" does exactly what the button does. The ref
 * keeps the one subscription pointed at the latest `createChat`, which
 * closes over the current profiles.
 */
export function useTrayNewChat(createChat: () => Promise<void>): void {
  const createChatRef = useRef(createChat);
  createChatRef.current = createChat;
  useEffect(() => {
    let off: (() => void) | null = null;
    let disposed = false;
    void onDesktopEvent('tray-new-chat', () => void createChatRef.current()).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
}
