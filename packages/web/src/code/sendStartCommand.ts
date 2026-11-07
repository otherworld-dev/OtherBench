import type { Chat } from '@otherbench/core/ports/store.js';
import { toast } from '../lib/toasts.js';
import { startChat } from '../state/startChat.js';
import { useOtherBenchStore } from '../state/store.js';

/**
 * Sends a Chat button's start command (Settings, Features) as the first message of `chat`, which is already open.
 * A send that fails leaves the command in the chat's box with a toast saying so, to send again from there: the chat
 * is made and shown, so pressing the button again would make a second one.
 */
export async function sendStartCommand(chat: Chat, text: string): Promise<void> {
  try {
    await startChat({ chat, text });
  } catch (err) {
    console.error(`[otherbench-web] couldn't send the start command to chat ${chat.id}:`, err);
    useOtherBenchStore.getState().prefillComposer(chat.id, text);
    const why = err instanceof Error ? ` ${err.message}` : '';
    toast({ text: `Couldn't send "${text}". It's in the box to send again.${why}`, tone: 'error' });
  }
}
