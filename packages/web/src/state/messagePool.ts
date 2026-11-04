import { isViewTab, parseViewTab } from '../viewer/items.js';
import { isChatTab } from './projectTab.js';
import type { OtherBenchState } from './store.js';

/*
 * The store's `messages` is one pool for every chat this window has loaded or
 * streamed into. Left alone it only grows, so on a chat switch or pane change
 * the store forgets the messages of chats nobody is looking at (`prunePool`),
 * keeping those in use and the KEPT_RECENT_CHATS viewed most recently besides.
 * A forgotten chat loads again when it next shows: `useChatSync` fetches a
 * chat's messages every time it opens it, so there is no "loaded" mark to clear.
 */

/** How many chats keep their messages besides those in use: the ones viewed most recently. */
export const KEPT_RECENT_CHATS = 8;

/** Chats a mounted `useChatSync` is following, with how many follow each. Not store state: nothing renders from it. */
const followed = new Map<string, number>();

/** Marks the chat as followed (its thread is showing somewhere in this window) until the returned release is called. */
export function followChat(chatId: string): () => void {
  followed.set(chatId, (followed.get(chatId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (followed.get(chatId) ?? 1) - 1;
    if (left > 0) followed.set(chatId, left);
    else followed.delete(chatId);
  };
}

export function followedChats(): ReadonlySet<string> {
  return new Set(followed.keys());
}

export type PoolState = Pick<
  OtherBenchState,
  | 'messages'
  | 'extras'
  | 'recordedUsage'
  | 'chatHelpers'
  | 'backgroundApprovals'
  | 'chatNotes'
  | 'sentNotes'
  | 'appRunningTurns'
  | 'appPendingApprovals'
  | 'paneState'
  | 'otherPaneState'
  | 'activeChatId'
  | 'viewedChats'
>;

/** The chat a pane shows, a viewer tab's included; null for an empty pane, a project page or an app's home. */
function chatOfPane(id: string | null): string | null {
  if (isViewTab(id)) return parseViewTab(id)?.chatId ?? null;
  return isChatTab(id) ? id : null;
}

/** The chats on screen in the mode showing, the active one first. */
function shownChats(state: PoolState): string[] {
  return [state.activeChatId, ...state.paneState.panes].map(chatOfPane).filter((id): id is string => id !== null);
}

/**
 * The chats whose messages are never forgotten: in a pane of either mode (pinned or not) or followed by a thread,
 * replying, with a card open (a reply's or a background helper's), or with messages queued for their replies.
 * Whether a chat is replying or has a card open is taken from the app-wide events, not from its loaded messages:
 * a chat no thread follows has no stream, so its messages stay as they were when it was left, a reply still marked
 * as streaming included.
 */
export function chatsInUse(state: PoolState, followedIds: ReadonlySet<string>): Set<string> {
  const ids = new Set(followedIds);
  for (const id of [state.activeChatId, ...state.paneState.panes, ...state.otherPaneState.panes]) {
    const chatId = chatOfPane(id);
    if (chatId !== null) ids.add(chatId);
  }
  for (const chatId of Object.values(state.appRunningTurns)) ids.add(chatId);
  for (const p of Object.values(state.appPendingApprovals)) ids.add(p.chatId);
  for (const [chatId, list] of Object.entries(state.backgroundApprovals)) if (list.length > 0) ids.add(chatId);
  for (const [chatId, notes] of Object.entries(state.chatNotes)) if (notes.length > 0) ids.add(chatId);
  for (const note of Object.values(state.sentNotes)) ids.add(note.chatId);
  return ids;
}

function without<T>(record: Record<string, T>, drop: (key: string) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop(key)));
}

/**
 * The store update that forgets the chats past the kept ones, or null when there is nothing to change. Recency is
 * `viewedChats` with the chats on screen now moved to the front; a chat loaded but never shown here (a reply
 * registered before its chat opened) counts as the oldest. With a chat's messages go what hangs off them: their
 * extras and recorded usage, and the chat's background tasks, cards and queued notes from its stream (its next
 * stream's hello sends them again). Events waiting for a message not yet known stay: `loadMessages` replays them.
 */
export function prunePool(state: PoolState, followedIds: ReadonlySet<string> = followedChats()): Partial<PoolState> | null {
  const inUse = chatsInUse(state, followedIds);
  const viewed = [...new Set([...shownChats(state), ...state.viewedChats])];
  const order = [...new Set([...viewed, ...Object.values(state.messages).map((m) => m.chatId)])];
  const keep = new Set(inUse);
  let spare = KEPT_RECENT_CHATS;
  for (const chatId of order) {
    if (spare === 0) break;
    if (keep.has(chatId)) continue;
    keep.add(chatId);
    spare -= 1;
  }

  const viewedChats = viewed.filter((id) => keep.has(id));
  const sameViewed = viewedChats.length === state.viewedChats.length && viewedChats.every((id, i) => id === state.viewedChats[i]);
  const gone = new Set(Object.values(state.messages).filter((m) => !keep.has(m.chatId)).map((m) => m.id));
  const dropChat = (chatId: string): boolean => !keep.has(chatId);
  const staleChat = [state.chatHelpers, state.backgroundApprovals, state.chatNotes].some((r) => Object.keys(r).some(dropChat));
  if (gone.size === 0 && !staleChat) return sameViewed ? null : { viewedChats };

  const dropMessage = (id: string): boolean => gone.has(id);
  return {
    viewedChats,
    messages: without(state.messages, dropMessage),
    extras: without(state.extras, dropMessage),
    recordedUsage: without(state.recordedUsage, dropMessage),
    chatHelpers: without(state.chatHelpers, dropChat),
    backgroundApprovals: without(state.backgroundApprovals, dropChat),
    chatNotes: without(state.chatNotes, dropChat),
  };
}
