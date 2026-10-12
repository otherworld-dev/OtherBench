import type { Chat } from '../ports/store.js';
import type { MessageStatus } from './messages.js';

/**
 * App-wide events (v2 plan, Task 34): what changed anywhere in the app, as
 * opposed to one chat's turn stream. `GET /api/events` sends them so every
 * window (and the tray) stays current without polling. `peer-status` and
 * `sync-applied` are declared for the sync milestones and not emitted yet.
 */
export type AppEvent =
  | { type: 'chat-created' | 'chat-updated'; chat: Chat }
  | { type: 'chat-deleted'; chatId: string }
  | { type: 'turn-started'; chatId: string; messageIds: string[] }
  | { type: 'turn-finished'; chatId: string; messageId: string; status: MessageStatus }
  | { type: 'approval-requested'; chatId: string; messageId: string; requestId: string; toolName: string }
  | { type: 'approval-resolved'; chatId: string; requestId: string }
  /** A machine was paired, renamed or removed: re-read the list. */
  | { type: 'peers-changed' }
  /** A paired machine became reachable or unreachable; `since` is when. */
  | { type: 'peer-status'; nodeId: string; status: 'reachable' | 'unreachable'; since: number }
  | { type: 'sync-applied'; nodeId: string; changed: number }
  /** A paired machine said which of its chats have a reply running: re-read the list (#790). */
  | { type: 'peer-activity'; nodeId: string }
  /** A chat started or stopped controlling this computer, or acted (computer use); `lastAction` is a one-line summary. */
  | { type: 'computer-session'; chatId: string; active: boolean; lastAction?: string };

/** A tool call waiting for the user's approval, as the app-wide stream reports it. */
export interface PendingApprovalSummary {
  chatId: string;
  messageId: string;
  requestId: string;
  toolName: string;
}

/** A reply still being written, as the app-wide stream reports it. */
export interface RunningTurnSummary {
  chatId: string;
  messageId: string;
}

/** A chat that is controlling this computer, as the app-wide stream reports it. */
export interface ComputerSessionSummary {
  chatId: string;
  lastAction?: string;
}

/** The `hello` that opens `GET /api/events`: the state a new subscriber can't rebuild from later events. */
export interface AppEventsHello {
  pendingApprovals: PendingApprovalSummary[];
  /** Replies started and not yet finished, so a window opened mid-reply knows which chats are working (#824). */
  runningTurns: RunningTurnSummary[];
  /** Chats controlling this computer right now (computer use), so a window opened mid-session shows the banner. */
  computerSessions?: ComputerSessionSummary[];
}
