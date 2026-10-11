import type { Chat } from '@grunt/core/ports/store.js';
import { api } from './api.js';
import { useGruntStore } from './store.js';

/** Pins or unpins a chat and stores the server's row. Rejects on failure; the caller says so. */
export async function setChatPinned(chatId: string, pinned: boolean): Promise<Chat> {
  const updated = await api.chats.patch(chatId, { pinned });
  useGruntStore.getState().upsertChat(updated);
  return updated;
}
