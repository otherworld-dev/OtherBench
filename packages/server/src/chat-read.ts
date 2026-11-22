import { extendToTip } from '@otherbench/core/domain/tree.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';

/**
 * Reading a chat's messages, for the routes and for the services that start turns in a chat (schedules, chat-to-chat
 * sends, jobs) or read what was said in it (memory).
 */

/**
 * The chat's whole message tree (every variant of every turn, not just the active branch), breadth first from its
 * roots, each message's children oldest first (by time, then id). One read of the chat (`MessageRepo.chatTree`),
 * arranged here: it used to ask for each message's children in turn, one query per message.
 *
 * Only messages that hang from one of the chat's roots are given, as before: a row whose parent chain doesn't reach
 * one is left out.
 */
export function collectMessageTree(store: Store, chatId: string): CanonMessage[] {
  // The list comes oldest first, so each parent's children are in that order too.
  const childrenOf = new Map<string | null, CanonMessage[]>();
  for (const message of store.messages.chatTree(chatId)) {
    const siblings = childrenOf.get(message.parentId);
    if (siblings) siblings.push(message);
    else childrenOf.set(message.parentId, [message]);
  }
  const result = [...(childrenOf.get(null) ?? [])];
  for (let i = 0; i < result.length; i++) result.push(...(childrenOf.get(result[i]!.id) ?? []));
  return result;
}

/**
 * The end of a chat's active branch (`extendToTip` from its head), which a new turn continues from: a finished reply,
 * or null for an empty chat. Throws, saying what to do, when the chat ends anywhere a turn can't follow on from.
 * Scheduled runs, chat-to-chat sends and job turns all start here, so it reads only the head and what hangs below it
 * (usually the one reply), never the whole chat with every message's parts.
 */
export function chatTip(store: Store, chatId: string, headId: string | null): string | null {
  if (store.messages.latestId(chatId) === null) return null;
  if (headId === null) throw new Error('This chat has messages but no current one to continue from. Open it and pick a reply.');
  const head = store.messages.get(headId);
  if (!head || head.chatId !== chatId) throw new Error("This chat's current message is missing. Open it and pick a reply.");
  // The head and everything below it, in the order the whole tree would list them: all `extendToTip` looks at.
  const below = [head];
  const seen = new Set([head.id]);
  for (let i = 0; i < below.length; i++) {
    for (const child of store.messages.children(below[i]!.id)) {
      // A row can't be its own ancestor, but a loop here would never end if one were.
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      below.push(child);
    }
  }
  const tip = extendToTip(below, headId).at(-1) ?? head;
  if (tip.role !== 'assistant') {
    throw new Error('This chat ends in a message with no reply kept (an unpicked compare, or a message with no answer). Pick a reply in the chat first.');
  }
  if (tip.status === 'streaming') throw new Error('A reply is still being written in this chat.');
  return tip.id;
}
