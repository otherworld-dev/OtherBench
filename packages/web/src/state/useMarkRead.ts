import { useLayoutEffect } from 'react';
import { api } from './api.js';
import { useReadingChatIds } from './chatStatus.js';
import { useOtherBenchStore } from './store.js';

/**
 * Marks read every unread chat the user is reading (on screen, window
 * focused): when it's opened, when a reply finishes while it's showing, and
 * when the window comes back to the front. Here first, before the browser
 * paints, so its sidebar dot doesn't flash; then on the server, which tells
 * the other windows. A failed PATCH is only logged: the server still has the
 * chat unread, and says so the next time the chat changes.
 */
export function useMarkRead(narrow: boolean): void {
  const chats = useOtherBenchStore((s) => s.chats);
  const reading = useReadingChatIds(narrow);
  useLayoutEffect(() => {
    for (const chat of chats) {
      if (!chat.unread || !reading.has(chat.id)) continue;
      useOtherBenchStore.getState().upsertChat({ ...chat, unread: false });
      api.chats.patch(chat.id, { unread: false }).catch((err: unknown) => console.error(`[otherbench-web] failed to mark chat ${chat.id} read:`, err));
    }
  }, [chats, reading]);
}
