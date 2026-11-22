import { useShallow } from 'zustand/react/shallow';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import type { MessageExtras } from './reducer.js';
import { useOtherBenchStore } from './store.js';

/*
 * The store's `messages` and `extras` are one pool for every chat, replaced whole on each stream event
 * (`applyTurnEvent`). A component that subscribes to either is drawn again for every chunk of every chat, so
 * with one chat streaming every open thread, header and message box redrew many times a second. These give a
 * component its own chat's share instead, and hand back the same value until something in that share changes:
 * an event for another chat then draws nothing here.
 */

const NO_MESSAGES: CanonMessage[] = [];
const NO_EXTRAS: Record<string, MessageExtras> = {};

let groupedFrom: Readonly<Record<string, CanonMessage>> | null = null;
let grouped = new Map<string, CanonMessage[]>();

/** The pool split by chat, in the pool's order. Worked out once per pool object, however many components ask. */
function byChat(messages: Readonly<Record<string, CanonMessage>>): ReadonlyMap<string, CanonMessage[]> {
  if (groupedFrom === messages) return grouped;
  const next = new Map<string, CanonMessage[]>();
  for (const m of Object.values(messages)) {
    const list = next.get(m.chatId);
    if (list) list.push(m);
    else next.set(m.chatId, [m]);
  }
  groupedFrom = messages;
  grouped = next;
  return next;
}

/** One chat's messages out of the pool (a fresh array per pool object: compare it shallowly, as the hooks here do). */
export function chatMessagesOf(messages: Readonly<Record<string, CanonMessage>>, chatId: string | null): CanonMessage[] {
  return chatId === null ? NO_MESSAGES : (byChat(messages).get(chatId) ?? NO_MESSAGES);
}

/** The chat's messages: the same array until one of them changes, comes or goes. */
export function useChatMessages(chatId: string | null): CanonMessage[] {
  return useOtherBenchStore(useShallow((s) => chatMessagesOf(s.messages, chatId)));
}

/** The extras of the chat's messages, by message id: the same object until one of them changes. */
export function useChatExtras(chatId: string | null): Record<string, MessageExtras> {
  return useOtherBenchStore(
    useShallow((s) => {
      const own = chatMessagesOf(s.messages, chatId);
      if (own.length === 0) return NO_EXTRAS;
      const extras: Record<string, MessageExtras> = {};
      for (const m of own) {
        const e = s.extras[m.id];
        if (e) extras[m.id] = e;
      }
      return extras;
    })
  );
}

/** The ids of the chat's replies being written: the same array until one starts or ends. */
export function useStreamingIds(chatId: string | null): string[] {
  return useOtherBenchStore(useShallow((s) => chatMessagesOf(s.messages, chatId).flatMap((m) => (m.status === 'streaming' ? [m.id] : []))));
}
