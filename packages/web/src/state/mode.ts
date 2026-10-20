import type { Chat } from '@otherbench/core/ports/store.js';

/**
 * Which half of the window is showing (spec 2026-10-20-code-tab-design, "Code
 * is a whole-window mode"). Chat mode shows projects and the chats outside
 * any app; Code mode shows apps and their chats. Each keeps its own tabs and
 * pane layout (the store's `paneState`/`otherPaneState`).
 */
export type Mode = 'chat' | 'code';

/** localStorage key: the mode showing. Per browser and never synced (the spec's "Which mode is showing" call). */
export const MODE_STORAGE_KEY = 'otherbench.mode';

/** The stored mode; anything missing, unreadable or unknown is Chat mode, where every existing user starts. */
export function loadMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === 'code' ? 'code' : 'chat';
  } catch {
    return 'chat';
  }
}

export function saveMode(mode: Mode): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // storage blocked or full -- the mode still applies for this session.
  }
}

/** The mode a chat lives in: an app chat only in Code mode, any other only in Chat mode (the spec's "Chats live in one mode only"). */
export function modeOfChat(chat: Chat): Mode {
  return chat.appId ? 'code' : 'chat';
}
