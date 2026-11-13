import { useMemo } from 'react';
import { CHAT_NEED_WINDOW_MS, chatNeedsYou, needsYouSince } from '@otherbench/core/domain/overview.js';
import { chatsInBackgroundElsewhere, chatsWaitingElsewhere, chatsWorkingElsewhere, waitingSinceElsewhere } from './peerActivity.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { PendingApprovalSummary } from '@otherbench/core/types/events.js';
import { useWindowFocused } from '../lib/useWindowFocused.js';
import type { PaneState } from './panes.js';
import { useOtherBenchStore } from './store.js';

/** A pending card, by what it asks of the user; `waiting` when it's on a paired machine, which doesn't say. */
export type CardStatus = 'approve' | 'answer' | 'plan' | 'generate' | 'browser' | 'waiting';

/**
 * What a chat wants or is doing, as the word on its row: a card waits on the user, a finished reply (`your-turn`,
 * or `failed`) hasn't been answered or ticked off, a reply is being written, it sent work to other chats and waits
 * for their replies (`waiting-chats`), or only background tasks are running.
 */
export type ChatStatus = CardStatus | 'held' | 'failed' | 'your-turn' | 'working' | 'waiting-chats' | 'background';

/** The chats with a card pending (and what it asks), with a reply running, and with background tasks running. */
export interface ChatActivity {
  waiting: ReadonlyMap<string, CardStatus>;
  working: ReadonlySet<string>;
  background: ReadonlySet<string>;
  /** The chats waiting on work they sent to other chats (spec 2026-11-06-chat-to-chat-design). */
  waitingChats?: ReadonlySet<string>;
  /** The chats with a send held for a machine that is off (spec 2026-11-13-chat-sends-across-machines-design). */
  held?: ReadonlySet<string>;
  /** Since when each chat in `waiting` has waited on its first card, where known: the Needs you order. */
  since?: ReadonlyMap<string, number>;
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
  // Held until the user says Run here, Wait or Cancel on its send card.
  if (activity.held?.has(chat.id)) return 'held';
  if (activity.working.has(chat.id)) return 'working';
  // Its replies come back by themselves, so it isn't the user's turn yet.
  if (activity.waitingChats?.has(chat.id)) return 'waiting-chats';
  const background = activity.background.has(chat.id);
  if (!chatNeedsYou(chat, chat.head ?? null, false, now - CHAT_NEED_WINDOW_MS, background)) return background ? 'background' : null;
  return chat.head?.status === 'error' ? 'failed' : 'your-turn';
}

/** Whether a status means the chat has stopped until the user acts. */
export function isNeedsYou(status: ChatStatus | null): boolean {
  return status !== null && status !== 'working' && status !== 'background' && status !== 'waiting-chats';
}

/** A chat stopped on a card: only answering it clears it, so it has no tick (the reply it holds up would land after the tick). */
export function isOnCard(status: ChatStatus | null): boolean {
  return isNeedsYou(status) && status !== 'failed' && status !== 'your-turn';
}

/** Why an app counts as live: a chat stopped on a card, or one still running (working, or on a paired machine). */
export type LiveReason = 'card' | 'running';

/** What keeps a closed app in the Code sidebar: its chat is on a card, or running; null for a chat that is idle or just needs a look. */
export function isLive(status: ChatStatus | null): LiveReason | null {
  if (isOnCard(status)) return 'card';
  return status === 'working' || status === 'background' ? 'running' : null;
}

/**
 * The Needs you list: the chats needing the user, as a queue, so working down it reaches every chat. Oldest first by
 * when each came to need them (`needsYouSince`): when its reply stopped or its card started waiting, so one that stops
 * joins the bottom rather than jumping ahead of those still waiting, and one that leaves (answered, working) joins it
 * again at the bottom. Those times are recorded by the server (the message's `finishedAt`, the card's `at`), so the
 * order is worked out afresh each time and is the same after a reload, a restart, or in another window. A card on a
 * paired machine that doesn't say when it started goes by its chat's last message.
 */
export function needsYouChats(chats: readonly Chat[], activity: ChatActivity, now: number): Chat[] {
  const at = (c: Chat): number => needsYouSince(c.head ?? null, activity.since?.get(c.id) ?? null) ?? c.updatedAt;
  return chats
    .map((chat) => ({ chat, status: chatStatus(chat, activity, now) }))
    .filter(({ chat, status }) => chat.archivedAt === null && isNeedsYou(status))
    .map(({ chat }) => ({ chat, at: at(chat) }))
    .sort((a, b) => a.at - b.at || (a.chat.id < b.chat.id ? -1 : a.chat.id > b.chat.id ? 1 : 0))
    .map(({ chat }) => chat);
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
  const waitingOnChats = useOtherBenchStore((s) => s.waitingOnChats);
  const waitingChats = useMemo(() => new Set(waitingOnChats), [waitingOnChats]);
  const heldChats = useOtherBenchStore((s) => s.heldChats);
  const held = useMemo(() => new Set(heldChats), [heldChats]);
  const waiting = useMemo(() => {
    const cards = new Map<string, CardStatus>();
    for (const id of chatsWaitingElsewhere(machines)) cards.set(id, 'waiting');
    for (const p of Object.values(pending)) if (!cards.has(p.chatId) || cards.get(p.chatId) === 'waiting') cards.set(p.chatId, CARD_STATUS[p.kind ?? 'tool']);
    return cards;
  }, [pending, machines]);
  const working = useMemo(() => new Set([...Object.values(running), ...chatsWorkingElsewhere(machines)]), [running, machines]);
  const background = useMemo(() => new Set([...Object.keys(backgroundChats), ...chatsInBackgroundElsewhere(machines)]), [backgroundChats, machines]);
  const since = useMemo(() => {
    const first = new Map(waitingSinceElsewhere(machines));
    for (const p of Object.values(pending)) if (p.at !== undefined) first.set(p.chatId, Math.min(first.get(p.chatId) ?? p.at, p.at));
    return first;
  }, [pending, machines]);
  return useMemo(() => ({ waiting, working, background, waitingChats, held, since }), [waiting, working, background, waitingChats, held, since]);
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
