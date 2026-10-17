import type { ChatEngine } from '@otherbench/core/ports/chat-engine.js';
import type { AppEventBus } from './stream/events.js';

/**
 * Has the engine end what it keeps running for chats that are gone (spec
 * 2026-10-17-claude-background-helpers-design): a Claude Code process and its
 * background helpers would otherwise carry on with nothing showing them. A
 * chat deleted through the store announces itself; changes applied from a
 * paired machine may have deleted any chat, so each is checked then.
 * Returns the unsubscribe.
 */
export function closeEngineChatsThatAreGone(events: AppEventBus, engine: Pick<ChatEngine, 'closeChats'>, chatExists: (chatId: string) => boolean): () => void {
  return events.subscribe((e) => {
    if (e.type === 'chat-deleted') engine.closeChats?.((chatId) => chatId === e.chatId);
    else if (e.type === 'sync-applied') engine.closeChats?.((chatId) => !chatExists(chatId));
  });
}
