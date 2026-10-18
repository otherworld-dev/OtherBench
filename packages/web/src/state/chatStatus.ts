import { useMemo } from 'react';
import { chatsInBackgroundElsewhere, chatsWorkingElsewhere } from './peerActivity.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import { useWindowFocused } from '../lib/useWindowFocused.js';
import type { PaneState } from './panes.js';
import { useOtherBenchStore } from './store.js';

/**
 * What a chat's dot says: an approval, question or plan is waiting for the user, a reply is
 * being written, a reply finished that the user hasn't had on screen since
 * (`Chat.unread`), or no reply is running but background tasks are.
 */
export type ChatStatus = 'waiting' | 'working' | 'ready' | 'background';

/** Most urgent first. A reply ready is news; background work carries on by itself. */
const URGENCY: readonly ChatStatus[] = ['waiting', 'working', 'ready', 'background'];

const NONE: ReadonlySet<string> = new Set();

/** The chats on screen: every pane's, or only the focused pane's with a pane maximised or in a narrow window. */
export function shownChatIds(state: PaneState, narrow: boolean): string[] {
  const ids = narrow || state.maximised ? [state.panes[state.focusedPane] ?? null] : state.panes;
  return ids.filter((id): id is string => id !== null);
}

/** `waiting`, `working` and `background` are the chat ids with an approval pending, a reply running and background tasks running. */
export function chatStatus(
  chat: Pick<Chat, 'id' | 'unread'>,
  waiting: ReadonlySet<string>,
  working: ReadonlySet<string>,
  background: ReadonlySet<string> = NONE
): ChatStatus | null {
  if (waiting.has(chat.id)) return 'waiting';
  if (working.has(chat.id)) return 'working';
  if (chat.unread) return 'ready';
  return background.has(chat.id) ? 'background' : null;
}

/** A group's status: the most urgent of its chats'. */
export function groupStatus(statuses: readonly (ChatStatus | null)[]): ChatStatus | null {
  return URGENCY.find((s) => statuses.includes(s)) ?? null;
}

/** A group's statuses counted, most urgent first: "1 waiting for you · 2 replies ready". Empty with none. */
export function groupStatusSummary(statuses: readonly (ChatStatus | null)[]): string {
  const words: Record<ChatStatus, [string, string]> = {
    waiting: ['waiting for you', 'waiting for you'],
    working: ['replying', 'replying'],
    ready: ['reply ready', 'replies ready'],
    background: ['working in the background', 'working in the background'],
  };
  return URGENCY.flatMap((s) => {
    const n = statuses.filter((x) => x === s).length;
    return n > 0 ? [`${n} ${words[s][n === 1 ? 0 : 1]}`] : [];
  }).join(' · ');
}

/**
 * The chats with an approval pending, with a reply running, and with
 * background tasks running, from the app-wide events. A paired machine's
 * activity counts too (state/machines.ts), so a chat replying or working in
 * the background on the PC shows the same on the laptop.
 */
export function useChatActivity(): { waiting: ReadonlySet<string>; working: ReadonlySet<string>; background: ReadonlySet<string> } {
  const pending = useOtherBenchStore((s) => s.appPendingApprovals);
  const running = useOtherBenchStore((s) => s.appRunningTurns);
  const machines = useOtherBenchStore((s) => s.machines);
  const backgroundChats = useOtherBenchStore((s) => s.appBackgroundChats);
  const waiting = useMemo(() => new Set(Object.values(pending).map((p) => p.chatId)), [pending]);
  const working = useMemo(() => new Set([...Object.values(running), ...chatsWorkingElsewhere(machines)]), [running, machines]);
  const background = useMemo(() => new Set([...Object.keys(backgroundChats), ...chatsInBackgroundElsewhere(machines)]), [backgroundChats, machines]);
  return { waiting, working, background };
}

/** The chats the user is reading: on screen while the window has focus. */
export function useReadingChatIds(narrow: boolean): ReadonlySet<string> {
  const paneState = useOtherBenchStore((s) => s.paneState);
  const focused = useWindowFocused();
  return useMemo(() => new Set(focused ? shownChatIds(paneState, narrow) : []), [paneState, narrow, focused]);
}
