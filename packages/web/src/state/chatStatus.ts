import { useMemo } from 'react';
import { chatsWorkingElsewhere } from './peerActivity.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import { useWindowFocused } from '../lib/useWindowFocused.js';
import type { PaneState } from './panes.js';
import { useOtherBenchStore } from './store.js';

/**
 * What a chat's dot says: an approval, question or plan is waiting for the user, a reply is
 * being written, or a reply finished that the user hasn't had on screen since
 * (`Chat.unread`).
 */
export type ChatStatus = 'waiting' | 'working' | 'ready';

/** Most urgent first. */
const URGENCY: readonly ChatStatus[] = ['waiting', 'working', 'ready'];

/** The chats on screen: every pane's, or only the focused pane's with a pane maximised or in a narrow window. */
export function shownChatIds(state: PaneState, narrow: boolean): string[] {
  const ids = narrow || state.maximised ? [state.panes[state.focusedPane] ?? null] : state.panes;
  return ids.filter((id): id is string => id !== null);
}

/** `waiting` and `working` are the chat ids with an approval pending and with a reply running. */
export function chatStatus(chat: Pick<Chat, 'id' | 'unread'>, waiting: ReadonlySet<string>, working: ReadonlySet<string>): ChatStatus | null {
  return waiting.has(chat.id) ? 'waiting' : working.has(chat.id) ? 'working' : chat.unread ? 'ready' : null;
}

/** A group's status: the most urgent of its chats'. */
export function groupStatus(statuses: readonly (ChatStatus | null)[]): ChatStatus | null {
  return URGENCY.find((s) => statuses.includes(s)) ?? null;
}

/**
 * The chats with an approval pending, and with a reply running, from the
 * app-wide events. A reply a paired machine is writing counts as running too
 * (its activity, state/machines.ts), so a chat working on the PC shows as
 * working on the laptop.
 */
export function useChatActivity(): { waiting: ReadonlySet<string>; working: ReadonlySet<string> } {
  const pending = useOtherBenchStore((s) => s.appPendingApprovals);
  const running = useOtherBenchStore((s) => s.appRunningTurns);
  const machines = useOtherBenchStore((s) => s.machines);
  const waiting = useMemo(() => new Set(Object.values(pending).map((p) => p.chatId)), [pending]);
  const working = useMemo(() => new Set([...Object.values(running), ...chatsWorkingElsewhere(machines)]), [running, machines]);
  return { waiting, working };
}

/** The chats the user is reading: on screen while the window has focus. */
export function useReadingChatIds(narrow: boolean): ReadonlySet<string> {
  const paneState = useOtherBenchStore((s) => s.paneState);
  const focused = useWindowFocused();
  return useMemo(() => new Set(focused ? shownChatIds(paneState, narrow) : []), [paneState, narrow, focused]);
}
