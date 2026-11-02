import { useMemo, useRef } from 'react';
import { CHAT_NEED_WINDOW_MS, chatNeedsYou } from '@otherbench/core/domain/overview.js';
import { chatsInBackgroundElsewhere, chatsWaitingElsewhere, chatsWorkingElsewhere } from './peerActivity.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { PendingApprovalSummary } from '@otherbench/core/types/events.js';
import { useWindowFocused } from '../lib/useWindowFocused.js';
import type { PaneState } from './panes.js';
import { useOtherBenchStore } from './store.js';

/** A pending card, by what it asks of the user; `waiting` when it's on a paired machine, which doesn't say. */
export type CardStatus = 'approve' | 'answer' | 'plan' | 'generate' | 'browser' | 'waiting';

/**
 * What a chat wants or is doing, as the word on its row: a card waits on the user, a finished reply (`your-turn`,
 * or `failed`) hasn't been answered or ticked off, a reply is being written, or only background tasks are running.
 */
export type ChatStatus = CardStatus | 'failed' | 'your-turn' | 'working' | 'background';

/** The chats with a card pending (and what it asks), with a reply running, and with background tasks running. */
export interface ChatActivity {
  waiting: ReadonlyMap<string, CardStatus>;
  working: ReadonlySet<string>;
  background: ReadonlySet<string>;
}

/** The chats on screen: every pane's, or only the focused pane's with a pane maximised or in a narrow window. */
export function shownChatIds(state: PaneState, narrow: boolean): string[] {
  const ids = narrow || state.maximised ? [state.panes[state.focusedPane] ?? null] : state.panes;
  return ids.filter((id): id is string => id !== null);
}

/**
 * A chat's status. Having the chat open changes nothing: a finished reply stays the user's turn until they answer it
 * or tick it off, so the sidebar always says which chats are stopped on them (`chatNeedsYou`, the Overview's rule).
 * Background tasks only show when the chat doesn't want the user meanwhile.
 */
export function chatStatus(chat: Pick<Chat, 'id' | 'archivedAt' | 'dealtWithAt' | 'head'>, activity: ChatActivity, now: number): ChatStatus | null {
  const card = activity.waiting.get(chat.id);
  if (card) return card;
  if (activity.working.has(chat.id)) return 'working';
  const background = activity.background.has(chat.id);
  if (!chatNeedsYou(chat, chat.head ?? null, false, now - CHAT_NEED_WINDOW_MS, background)) return background ? 'background' : null;
  return chat.head?.status === 'error' ? 'failed' : 'your-turn';
}

/** Whether a status means the chat has stopped until the user acts. */
export function isNeedsYou(status: ChatStatus | null): boolean {
  return status !== null && status !== 'working' && status !== 'background';
}

/** A chat stopped on a card: only answering it clears it, so it has no tick (the reply it holds up would land after the tick). */
export function isOnCard(status: ChatStatus | null): boolean {
  return isNeedsYou(status) && status !== 'failed' && status !== 'your-turn';
}

/** The chats needing the user, oldest reply first: the order `queued` starts from. */
export function needsYouChats(chats: readonly Chat[], activity: ChatActivity, now: number): Chat[] {
  const at = (c: Chat): number => c.head?.createdAt ?? c.updatedAt;
  return chats
    .map((chat) => ({ chat, status: chatStatus(chat, activity, now) }))
    .filter(({ chat, status }) => chat.archivedAt === null && isNeedsYou(status))
    .sort((a, b) => at(a.chat) - at(b.chat))
    .map(({ chat }) => chat);
}

/** `chats` as a queue behind `previous` (ids, in queue order): those already in it keep their places, newcomers go last. */
export function queued(previous: readonly string[], chats: readonly Chat[]): Chat[] {
  const byId = new Map(chats.map((c) => [c.id, c]));
  const waiting = new Set(previous);
  return [...previous.flatMap((id) => byId.get(id) ?? []), ...chats.filter((c) => !waiting.has(c.id))];
}

/**
 * The Needs you list as a queue, so working down it reaches every chat: one that stops joins the bottom rather than
 * jumping ahead of those still waiting, and one that leaves (it was answered and is working) joins it again. Kept here,
 * not worked out from a time, because a message records when its reply started and a card records no time at all. A
 * reload starts again from `needsYouChats`' order.
 */
export function useNeedsYouQueue(chats: readonly Chat[], activity: ChatActivity, now: number): Chat[] {
  const queue = useRef<readonly string[]>([]);
  return useMemo(() => {
    const list = queued(queue.current, needsYouChats(chats, activity, now));
    queue.current = list.map((c) => c.id);
    return list;
  }, [chats, activity, now]);
}

/** What a group's chats are doing, for a collapsed heading: "2 replying · 1 in background". Empty with none. */
export function groupStatusSummary(statuses: readonly (ChatStatus | null)[]): string {
  const count = (s: ChatStatus): number => statuses.filter((x) => x === s).length;
  const parts: [number, string][] = [[count('working'), 'replying'], [count('background'), 'in background']];
  return parts.flatMap(([n, word]) => (n > 0 ? [`${n} ${word}`] : [])).join(' · ');
}

/**
 * What each chat's cards, replies and background tasks are doing, from the app-wide events. A paired machine's
 * activity counts too (state/machines.ts), so a chat replying or working in the background on the PC shows the same
 * on the laptop.
 */
export function useChatActivity(): ChatActivity {
  const pending = useOtherBenchStore((s) => s.appPendingApprovals);
  const running = useOtherBenchStore((s) => s.appRunningTurns);
  const machines = useOtherBenchStore((s) => s.machines);
  const backgroundChats = useOtherBenchStore((s) => s.appBackgroundChats);
  const waiting = useMemo(() => {
    const cards = new Map<string, CardStatus>();
    for (const id of chatsWaitingElsewhere(machines)) cards.set(id, 'waiting');
    for (const p of Object.values(pending)) if (!cards.has(p.chatId) || cards.get(p.chatId) === 'waiting') cards.set(p.chatId, CARD_STATUS[p.kind ?? 'tool']);
    return cards;
  }, [pending, machines]);
  const working = useMemo(() => new Set([...Object.values(running), ...chatsWorkingElsewhere(machines)]), [running, machines]);
  const background = useMemo(() => new Set([...Object.keys(backgroundChats), ...chatsInBackgroundElsewhere(machines)]), [backgroundChats, machines]);
  return useMemo(() => ({ waiting, working, background }), [waiting, working, background]);
}

const CARD_STATUS: Record<NonNullable<PendingApprovalSummary['kind']> | 'tool', CardStatus> = {
  tool: 'approve',
  question: 'answer',
  plan: 'plan',
  generation: 'generate',
  browser: 'browser',
};

/** The chats the user is reading: on screen while the window has focus. */
export function useReadingChatIds(narrow: boolean): ReadonlySet<string> {
  const paneState = useOtherBenchStore((s) => s.paneState);
  const focused = useWindowFocused();
  return useMemo(() => new Set(focused ? shownChatIds(paneState, narrow) : []), [paneState, narrow, focused]);
}
