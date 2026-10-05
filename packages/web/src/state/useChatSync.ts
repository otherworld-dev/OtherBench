import { useEffect, useRef } from 'react';
import { api } from './api.js';
import { SseClient } from './sse.js';
import { useGruntStore, type StreamConnectionStatus } from './store.js';

/**
 * Keeps one chat's message tree and SSE stream in sync with the store:
 * bulk-hydrates the tree via `GET /chats/:id/messages`, then opens
 * `GET /chats/:id/stream` for live + replayed events. Tears the previous
 * chat's connection down and opens a fresh one whenever `chatId` changes,
 * and on unmount. A `null` id (nothing selected) does nothing.
 */
export function useChatSync(chatId: string | null, reportStatus = true): void {
  // With several panes open, only the focused one drives the header's
  // connection status. Focus moving between panes must not reconnect a
  // stream, so this is read through refs rather than restarting the effect.
  const reportRef = useRef(reportStatus);
  const statusRef = useRef<StreamConnectionStatus>('idle');
  reportRef.current = reportStatus;

  useEffect(() => {
    if (reportStatus) useGruntStore.getState().setStreamStatus(statusRef.current);
  }, [reportStatus]);

  useEffect(() => {
    if (!chatId) return;

    let cancelled = false;
    const loadMessages = useGruntStore.getState().loadMessages;
    const applyHello = useGruntStore.getState().applyHello;
    const applyTurnEvent = useGruntStore.getState().applyTurnEvent;
    const setStreamStatus = useGruntStore.getState().setStreamStatus;
    const report = (status: StreamConnectionStatus): void => {
      statusRef.current = status;
      if (reportRef.current) setStreamStatus(status);
    };

    api.chats
      .messages(chatId)
      .then(({ messages, headMessageId, usage }) => {
        if (cancelled) return;
        loadMessages(chatId, messages, headMessageId, usage);
      })
      .catch((err: unknown) => {
        console.error(`[grunt-web] failed to load messages for chat ${chatId}:`, err);
      });

    const client = new SseClient({
      url: api.streamUrl(chatId),
      onHello: applyHello,
      onEvent: applyTurnEvent,
      onStatusChange: report,
    });
    client.connect();

    return () => {
      cancelled = true;
      client.close();
      report('idle');
    };
  }, [chatId]);
}
