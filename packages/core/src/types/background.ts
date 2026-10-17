/**
 * A background task an engine's agent has running for a chat (spec
 * 2026-10-17-claude-background-helpers-design): a Claude Code helper (Task or
 * Agent run in the background) or a background shell, monitor and the like.
 */
export interface BackgroundHelper {
  /** The engine's own id for it (Claude Code's task id), used to stop it. */
  taskId: string;
  /** The tool call that started it, when it has a card in a reply. */
  callId: string | null;
  /** What kind of task it is (Claude Code's `task_type`, e.g. `local_agent`, `local_bash`). */
  kind: string;
  label: string;
  startedAt: number;
  /** What it did last: its progress summary or the last tool it used. */
  lastActivity: string | null;
}

/** What a chat's live stream carries besides its replies' events: its background tasks, and that its stored messages changed. */
export type ChatLevelEvent = { type: 'helpers'; chatId: string; helpers: BackgroundHelper[] } | { type: 'messages-changed'; chatId: string };
