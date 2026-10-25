import { useMemo } from 'react';
import { api } from './api.js';
import { useOtherBenchStore } from './store.js';

/**
 * A chat's running replies and how to stop them: the Stop button, and Escape in the chat (`escapeStopsReply`). Every
 * streaming reply is cancelled, so a compare chat's sides all stop, as with Stop. `chatId` null: nothing runs.
 */
export function useStopReply(chatId: string | null): { inFlightIds: string[]; streaming: boolean; stop(): Promise<void> } {
  const messages = useOtherBenchStore((s) => s.messages);
  const inFlightIds = useMemo(
    () =>
      chatId === null
        ? []
        : Object.values(messages)
            .filter((m) => m.chatId === chatId && m.status === 'streaming')
            .map((m) => m.id),
    [messages, chatId]
  );
  return {
    inFlightIds,
    streaming: inFlightIds.length > 0,
    stop: async () => {
      await Promise.all(inFlightIds.map((id) => api.turns.cancel(id).catch((err: unknown) => console.error(`[otherbench-web] failed to cancel ${id}:`, err))));
    },
  };
}
