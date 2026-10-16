import type { Chat } from '@otherbench/core/ports/store.js';
import { api } from './api.js';
import { useOtherBenchStore } from './store.js';

/** Pins or unpins a chat and stores the server's row. Rejects on failure; the caller says so. */
export async function setChatPinned(chatId: string, pinned: boolean): Promise<Chat> {
  const updated = await api.chats.patch(chatId, { pinned });
  useOtherBenchStore.getState().upsertChat(updated);
  return updated;
}
