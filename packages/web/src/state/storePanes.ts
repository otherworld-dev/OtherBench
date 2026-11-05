import type { Chat } from '@otherbench/core/ports/store.js';
import { toast } from '../lib/toasts.js';
import { parseViewTab } from '../viewer/items.js';
import { isAllAppsTab } from './allAppsTab.js';
import { parseAppTab } from './appTab.js';
import { modeOfChat, type Mode } from './mode.js';
import { CODE_PANE_STATE_STORAGE_KEY, forgetChat, PANE_STATE_STORAGE_KEY, type PaneState } from './panes.js';
import { parseProjectTab } from './projectTab.js';
import type { OtherBenchState } from './storeTypes.js';

/**
 * The pane state with the focused pane holding `activeChatId`, which is the
 * source of truth for the active chat (tests and callers may set it directly).
 */
export function synced(state: { paneState: PaneState; activeChatId: string | null }): PaneState {
  const { paneState, activeChatId } = state;
  if (paneState.panes[paneState.focusedPane] === activeChatId) return paneState;
  const panes = [...paneState.panes];
  panes[paneState.focusedPane] = activeChatId;
  return { ...paneState, panes };
}

/** A pane-state change, with `activeChatId` following the focused pane. */
export function withPanes(next: PaneState): { paneState: PaneState; activeChatId: string | null } {
  return { paneState: next, activeChatId: next.panes[next.focusedPane] ?? null };
}

/** After opening `chatId`: it isn't in any pane only when four pinned panes left it nowhere to go. */
export function toastIfNoRoom(panes: PaneState, chatId: string | null): void {
  if (chatId !== null && !panes.panes.includes(chatId)) toast({ text: 'Every pane is pinned. Unpin one to open this chat.', tone: 'ok' });
}

/*
 * Code is a whole-window mode (spec 2026-10-20-code-tab-design, "Decisions Adam
 * made"): Chat mode and Code mode each keep their own tabs and pane layout, and
 * switching swaps them. The store holds the showing mode's as `paneState`, so
 * every pane action and every component reading it works unchanged in either
 * mode, and the other mode's as `otherPaneState`, untouched until a switch
 * swaps the two. A chat lives in one mode only (`modeOfChat`), so a pane state
 * never keeps a chat of the other mode: one that moves into or out of an app
 * leaves the pane state of the mode it left, the way a deleted chat does.
 */

export const otherMode = (mode: Mode): Mode => (mode === 'chat' ? 'code' : 'chat');

/** Where a mode's pane state is saved: Chat mode keeps the key every layout was saved under before Code mode. */
export const paneStateKey = (mode: Mode): string => (mode === 'code' ? CODE_PANE_STATE_STORAGE_KEY : PANE_STATE_STORAGE_KEY);

export type ModeView = Pick<OtherBenchState, 'mode' | 'paneState' | 'otherPaneState' | 'activeChatId'>;

/**
 * The mode a tab or pane id belongs in: an app's home in Code mode, a project's
 * page in Chat mode, a chat (or a viewer tab, by its chat) in its chat's mode.
 * Null when this window can't tell (a chat it hasn't loaded yet) or for null.
 */
export function modeOfTab(id: string | null, chats: Chat[]): Mode | null {
  if (id === null) return null;
  if (parseAppTab(id) !== null || isAllAppsTab(id)) return 'code';
  if (parseProjectTab(id) !== null) return 'chat';
  const chatId = parseViewTab(id)?.chatId ?? id;
  const chat = chats.find((c) => c.id === chatId);
  return chat ? modeOfChat(chat) : null;
}

/**
 * The store's mode fields with `mode` showing. A switch puts the showing pane
 * state away exactly as it is (synced with the active chat) and brings the other
 * back with its own focused pane's chat active; the same mode changes nothing.
 */
export function inMode(state: ModeView, mode: Mode): ModeView {
  if (mode === state.mode) return { mode, paneState: state.paneState, otherPaneState: state.otherPaneState, activeChatId: state.activeChatId };
  const back = state.otherPaneState;
  return { mode, paneState: back, otherPaneState: synced(state), activeChatId: back.panes[back.focusedPane] ?? null };
}

/** `forget` applied to both modes' pane states, the active chat following the showing one. */
export function forgetInBoth(state: ModeView, forget: (panes: PaneState) => PaneState): Pick<OtherBenchState, 'paneState' | 'otherPaneState' | 'activeChatId'> {
  return { ...withPanes(forget(synced(state))), otherPaneState: forget(state.otherPaneState) };
}

/** `change` applied to `mode`'s pane state, whether it is showing or put away. */
export function inPanesOf(state: ModeView, mode: Mode, change: (panes: PaneState) => PaneState): Partial<OtherBenchState> {
  return mode === state.mode ? withPanes(change(synced(state))) : { otherPaneState: change(state.otherPaneState) };
}

/**
 * Each of `chats` dropped (with its viewer tabs, as `forgetChat`) from the pane
 * state of the mode it doesn't live in. Nothing when no pane state held one, so
 * an update that moved nothing leaves both pane states as they were.
 */
export function refiled(state: ModeView, chats: readonly Chat[]): Partial<OtherBenchState> {
  if (chats.length === 0) return {};
  const base = synced(state);
  let showing = base;
  let away = state.otherPaneState;
  for (const chat of chats) {
    if (modeOfChat(chat) === state.mode) away = forgetChat(away, chat.id);
    else showing = forgetChat(showing, chat.id);
  }
  if (showing === base && away === state.otherPaneState) return {};
  return { ...withPanes(showing), otherPaneState: away };
}

/** `after` when it moved into or out of an app since `before` (a chat this window already had), for `refiled`. */
export function movedModes(before: Chat | undefined, after: Chat): Chat[] {
  return before !== undefined && modeOfChat(before) !== modeOfChat(after) ? [after] : [];
}
