import type { Chat } from '@otherbench/core/ports/store.js';
import type { AppEvent, ToolStateSection } from '@otherbench/core/types/events.js';
import { ApiError } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';

/**
 * The honest-state sections below (MCP health, grants, audit) are pushed,
 * not polled: the server says `mcp-changed`, `grants-changed` or
 * `audit-changed` on the app-wide `GET /api/events` stream whenever one may
 * have changed (an MCP status or tool list, a grant made, used up or revoked
 * by an approval resolved anywhere, a gated tool call), and `useLiveData`
 * re-reads just that section, debounced, over the stream `useAppEvents`
 * already holds rather than a connection of its own. Every hello (a
 * reconnect) re-reads all three, so a change missed while the stream was down
 * still shows. Settings > MCP servers reads its health list the same way.
 *
 * All three are each machine's own and never sync, so for a chat that runs on
 * a paired machine they're read from there (the server forwards the
 * chat-scoped routes), as the chat uses that machine's tools. That machine
 * says when they change (`peer-tool-state`), and coming back reachable
 * re-reads them too.
 */

/** Whether `event` says the tool state shown for `chat` changed on the paired machine it runs on. */
export function peerToolStateChanged(event: AppEvent, chat: Chat, section: ToolStateSection): boolean {
  if (event.type === 'peer-tool-state') return event.nodeId === chat.runsOn && event.section === section && (event.chatId === null || event.chatId === chat.id);
  // Back after being away: whatever changed there meanwhile.
  return event.type === 'peer-status' && event.nodeId === chat.runsOn && event.status === 'reachable';
}

/** Why a section couldn't load. For a chat on a paired machine, the server's own words: that machine isn't reachable, or needs an update. */
export function loadFailedText(error: unknown, fallback: string, remote: boolean): string {
  return remote && error instanceof ApiError ? error.message : fallback;
}

/** Whether the chat runs on a paired machine rather than this one. */
export function useRunsElsewhere(chat: Chat | null): boolean {
  const selfId = useOtherBenchStore((s) => s.machines?.self.id ?? null);
  return chat !== null && selfId !== null && chat.runsOn !== selfId;
}
