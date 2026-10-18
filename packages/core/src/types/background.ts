import type { NoteOutcome, ReplyNote } from './notes.js';

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
export type ChatLevelEvent =
  | { type: 'helpers'; chatId: string; helpers: BackgroundHelper[] }
  | { type: 'messages-changed'; chatId: string }
  /** The chat's waiting notes, the whole set. */
  | { type: 'notes'; chatId: string; notes: ReplyNote[] }
  /** A note left the waiting set; `note` is present for `returned`. */
  | { type: 'note-resolved'; chatId: string; noteId: string; outcome: NoteOutcome; clientId: string; note?: ReplyNote };

/**
 * On a chat's stream, a background helper's approval card and its answer
 * carry this mark: they belong to no reply that is streaming, so the web
 * shows them with the helpers rather than in a reply (it can't tell from
 * what it has loaded).
 */
export interface BackgroundMark {
  background: true;
}
