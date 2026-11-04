import { useMemo } from 'react';
import { api } from './api.js';
import { workingElsewhere } from './peerActivity.js';
import { useOtherBenchStore } from './store.js';

/**
 * A chat's running replies and how to stop them: the Stop button, and Escape in the chat (`escapeStopsReply`).
 * `streaming`: a reply of the chat is on screen being written. `canStop`: that, or a paired machine says it is
 * writing one there that isn't on screen yet. Stop asks the server to stop the chat, which stops every reply of
 * it wherever it runs, so a compare chat's sides all stop, and one on a paired machine is stopped there.
 * `chatId` null: nothing runs.
 */
export function useStopReply(chatId: string | null): { inFlightIds: string[]; streaming: boolean; canStop: boolean; stop(): Promise<void> } {
  const messages = useOtherBenchStore((s) => s.messages);
  const elsewhere = useOtherBenchStore((s) => chatId !== null && workingElsewhere(s.machines, chatId) !== null);
  const inFlightIds = useMemo(
    () =>
      chatId === null
        ? []
        : Object.values(messages)
            .filter((m) => m.chatId === chatId && m.status === 'streaming')
            .map((m) => m.id),
    [messages, chatId]
  );
  const streaming = inFlightIds.length > 0;
  return {
    inFlightIds,
    streaming,
    canStop: streaming || elsewhere,
    stop: async () => {
      if (chatId === null) return;
      await api.chats.stop(chatId).catch((err: unknown) => console.error(`[otherbench-web] failed to stop chat ${chatId}:`, err));
    },
  };
}
