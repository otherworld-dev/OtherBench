import { useOtherBenchStore } from './store.js';

/**
 * Opens a chat from a click on it and puts the cursor in its message box, so
 * typing can start at once. Enter or Space on the same control (a click with
 * `detail` 0) opens the chat and leaves focus where it is, so a list can still
 * be walked with the keyboard.
 */
export function openChatFromClick(chatId: string, click: { detail: number }): void {
  const { setActiveChatId, focusComposer } = useOtherBenchStore.getState();
  setActiveChatId(chatId);
  if (click.detail > 0) focusComposer(chatId);
}
