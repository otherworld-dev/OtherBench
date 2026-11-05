import { useEffect } from 'react';
import { onPushOpenChat, reportPresence, takeChatFromUrl } from '../lib/push.js';
import { useOtherBenchStore } from './store.js';

/** Opens `chatId` if this window has it. */
function openChat(chatId: string): void {
  const { chats, setActiveChatId } = useOtherBenchStore.getState();
  if (chats.some((c) => c.id === chatId)) setActiveChatId(chatId);
}

/**
 * Web Push in the main window (lib/push.ts): a tapped notification opens its
 * chat, whether it opened this window (`?chat=`, read once the chats have
 * loaded) or the service worker passed it to a window already open. Signed in
 * through remote access, the page also tells the server while it is showing,
 * so this device isn't pushed what it can already see.
 */
export function usePush(loaded: boolean, signedInRemotely: boolean): void {
  useEffect(() => {
    if (!loaded) return;
    const fromUrl = takeChatFromUrl();
    if (fromUrl) openChat(fromUrl);
    return onPushOpenChat(openChat);
  }, [loaded]);

  useEffect(() => (signedInRemotely ? reportPresence() : undefined), [signedInRemotely]);
}
