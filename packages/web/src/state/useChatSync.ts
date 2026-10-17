import { useEffect, useRef } from 'react';
import type { TurnEvent } from '@otherbench/core/domain/turn.js';
import type { ApprovalRequest } from '@otherbench/core/ports/tool-provider.js';
import type { BackgroundHelper, BackgroundMark, ChatLevelEvent } from '@otherbench/core/types/background.js';
import { api } from './api.js';
import { SseClient } from './sse.js';
import { useOtherBenchStore, type HelloBuffer, type StreamConnectionStatus } from './store.js';

/**
 * Keeps one chat's message tree and SSE stream in sync with the store:
 * bulk-hydrates the tree via `GET /chats/:id/messages`, then opens
 * `GET /chats/:id/stream` for live + replayed events. Tears the previous
 * chat's connection down and opens a fresh one whenever `chatId` changes,
 * and on unmount. A `null` id (nothing selected) does nothing.
 */
/** The chat stream's hello: its replies in flight, and its background tasks with their open approval cards. */
interface ChatHello {
  inFlight?: HelloBuffer[];
  helpers?: BackgroundHelper[];
  backgroundApprovals?: ApprovalRequest[];
}

export function useChatSync(chatId: string | null, reportStatus = true): void {
  // Another machine's changes may have added to this chat, or a turn this
  // window didn't start ran in it: reload its messages (the stream stays as it is).
  const syncRevision = useOtherBenchStore((s) => s.syncRevision);
  const chatReload = useOtherBenchStore((s) => (chatId ? (s.chatReloads[chatId] ?? 0) : 0));
  // The server picks the machine a stream comes from when it opens (this one,
  // or relayed from the one the chat runs on), so a change reopens it.
  const runsOn = useOtherBenchStore((s) => (chatId ? s.chats.find((c) => c.id === chatId)?.runsOn : undefined));
  // With several panes open, only the focused one drives the header's
  // connection status. Focus moving between panes must not reconnect a
  // stream, so this is read through refs rather than restarting the effect.
  const reportRef = useRef(reportStatus);
  const statusRef = useRef<StreamConnectionStatus>('idle');
  reportRef.current = reportStatus;

  useEffect(() => {
    if (reportStatus) useOtherBenchStore.getState().setStreamStatus(statusRef.current);
  }, [reportStatus]);

  useEffect(() => {
    if (!chatId || syncRevision + chatReload === 0) return;
    let cancelled = false;
    api.chats
      .messages(chatId)
      .then(({ messages, headMessageId, usage }) => {
        if (!cancelled) useOtherBenchStore.getState().loadMessages(chatId, messages, headMessageId, usage);
      })
      .catch((err: unknown) => console.error(`[otherbench-web] failed to reload messages for chat ${chatId}:`, err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a sync or another's turn, not a chat switch (the effect below loads on that).
  }, [syncRevision, chatReload]);

  useEffect(() => {
    if (!chatId) return;

    let cancelled = false;
    const loadMessages = useOtherBenchStore.getState().loadMessages;
    const applyHello = useOtherBenchStore.getState().applyHello;
    const applyTurnEvent = useOtherBenchStore.getState().applyTurnEvent;
    const setStreamStatus = useOtherBenchStore.getState().setStreamStatus;
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
        console.error(`[otherbench-web] failed to load messages for chat ${chatId}:`, err);
      });

    const { applyChatEvent, setChatBackground } = useOtherBenchStore.getState();
    const client = new SseClient<ChatHello, (TurnEvent & Partial<BackgroundMark>) | ChatLevelEvent>({
      url: api.streamUrl(chatId),
      readHello: (payload) => payload as ChatHello,
      onHello: (hello) => {
        applyHello(hello.inFlight ?? []);
        setChatBackground(chatId, hello.helpers ?? [], hello.backgroundApprovals ?? []);
      },
      onEvent: (event) => applyChatEvent(chatId, event),
      onStatusChange: report,
    });
    client.connect();

    return () => {
      cancelled = true;
      client.close();
      report('idle');
    };
  }, [chatId, runsOn]);
}
