import { useEffect, useEffectEvent, useRef } from 'react';
import type { TurnEvent } from '@otherbench/core/domain/turn.js';
import type { ApprovalRequest } from '@otherbench/core/ports/tool-provider.js';
import type { BackgroundHelper, BackgroundMark, ChatLevelEvent } from '@otherbench/core/types/background.js';
import type { NoteOutcome, ReplyNote } from '@otherbench/core/types/notes.js';
import { api } from './api.js';
import { followChat } from './messagePool.js';
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
  /** Messages waiting for the chat's replies to end, and what became of the ones already resolved. */
  notes?: ReplyNote[];
  noteOutcomes?: { noteId: string; outcome: NoteOutcome }[];
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
  // stream, so this is read through an effect event rather than restarting the effect.
  const reporting = useEffectEvent(() => reportStatus);
  const statusRef = useRef<StreamConnectionStatus>('idle');

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
    // Its messages stay in the pool while this follows it, wherever the thread is (a pane, quick chat).
    // Every open loads them afresh, so a chat the pool has forgotten shows again (messagePool.ts).
    const release = followChat(chatId);
    const loadMessages = useOtherBenchStore.getState().loadMessages;
    const applyHello = useOtherBenchStore.getState().applyHello;
    const applyTurnEvent = useOtherBenchStore.getState().applyTurnEvent;
    const setStreamStatus = useOtherBenchStore.getState().setStreamStatus;
    const report = (status: StreamConnectionStatus): void => {
      statusRef.current = status;
      if (reporting()) setStreamStatus(status);
    };

    const { applyChatEvent, setChatBackground, setChatNotes, settleUnsureNotes } = useOtherBenchStore.getState();
    // A hello before the messages have loaded can't yet tell a note Claude read from a lost one (setChatNotes).
    let messagesLoaded = false;
    api.chats
      .messages(chatId)
      .then(({ messages, headMessageId, usage }) => {
        if (cancelled) return;
        loadMessages(chatId, messages, headMessageId, usage);
      })
      .catch((err: unknown) => {
        console.error(`[otherbench-web] failed to load messages for chat ${chatId}:`, err);
      })
      .finally(() => {
        if (cancelled) return;
        messagesLoaded = true;
        settleUnsureNotes(chatId);
      });

    const client = new SseClient<ChatHello, (TurnEvent & Partial<BackgroundMark>) | ChatLevelEvent>({
      url: api.streamUrl(chatId),
      readHello: (payload) => payload as ChatHello,
      onHello: (hello) => {
        applyHello(hello.inFlight ?? []);
        setChatBackground(chatId, hello.helpers ?? [], hello.backgroundApprovals ?? []);
        setChatNotes(chatId, hello.notes ?? [], hello.noteOutcomes ?? [], messagesLoaded);
      },
      onEvent: (event) => applyChatEvent(chatId, event),
      onStatusChange: report,
    });
    client.connect();

    return () => {
      cancelled = true;
      release();
      client.close();
      report('idle');
    };
  }, [chatId, runsOn]);
}
