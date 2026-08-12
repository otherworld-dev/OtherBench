import { useEffect } from 'react';
import { api } from './api.js';
import { SseClient } from './sse.js';
import { useGruntStore } from './store.js';

/**
 * Keeps one chat's message tree and SSE stream in sync with the store:
 * bulk-hydrates the tree via `GET /chats/:id/messages`, then opens
 * `GET /chats/:id/stream` for live + replayed events. Tears the previous
 * chat's connection down and opens a fresh one whenever `chatId` changes,
 * and on unmount. A `null` id (nothing selected) does nothing.
 */
export function useChatSync(chatId: string | null): void {
  useEffect(() => {
    if (!chatId) return;

    let cancelled = false;
    const loadMessages = useGruntStore.getState().loadMessages;
    const applyHello = useGruntStore.getState().applyHello;
    const applyTurnEvent = useGruntStore.getState().applyTurnEvent;
    const setStreamStatus = useGruntStore.getState().setStreamStatus;

    api.chats
      .messages(chatId)
      .then(({ messages, headMessageId }) => {
        if (cancelled) return;
        loadMessages(chatId, messages, headMessageId);
      })
      .catch((err: unknown) => {
        console.error(`[grunt-web] failed to load messages for chat ${chatId}:`, err);
      });

    const client = new SseClient({
      url: api.streamUrl(chatId),
      onHello: applyHello,
      onEvent: applyTurnEvent,
      onStatusChange: setStreamStatus,
    });
    client.connect();

    return () => {
      cancelled = true;
      client.close();
      setStreamStatus('idle');
    };
  }, [chatId]);
}
