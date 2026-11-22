import { toast } from '../lib/toasts.js';
import { api } from './api.js';
import { useStreamingIds } from './chatMessages.js';
import { workingElsewhere } from './peerActivity.js';
import { useOtherBenchStore } from './store.js';

/**
 * A chat's running replies and how to stop them: the Stop button, and Escape in the chat (`escapeStopsReply`).
 * `streaming`: a reply of the chat is on screen being written. `canStop`: that, or a paired machine says it is
 * writing one there that isn't on screen yet. Stop asks the server to stop the chat, which stops every reply of
 * it wherever it runs, so a compare chat's sides all stop, and one on a paired machine is stopped there.
 * `chatId` null: nothing runs. A Stop the server didn't take is said, not only logged: the reply is still
 * running. In a toast, or through `onFailed` where a window has no toasts (quick chat).
 */
export function useStopReply(
  chatId: string | null,
  onFailed: (message: string) => void = (text) => void toast({ text, tone: 'error', ...(chatId !== null ? { chatId } : {}) })
): { inFlightIds: string[]; streaming: boolean; canStop: boolean; stop(): Promise<void> } {
  // This chat's only (state/chatMessages.ts): another chat's stream doesn't draw whatever holds the Stop button.
  const inFlightIds = useStreamingIds(chatId);
  const elsewhere = useOtherBenchStore((s) => chatId !== null && workingElsewhere(s.machines, chatId) !== null);
  const streaming = inFlightIds.length > 0;
  return {
    inFlightIds,
    streaming,
    canStop: streaming || elsewhere,
    stop: async () => {
      if (chatId === null) return;
      await api.chats.stop(chatId).catch((err: unknown) => {
        console.error(`[otherbench-web] failed to stop chat ${chatId}:`, err);
        onFailed("Couldn't stop the reply. Please try again.");
      });
    },
  };
}
