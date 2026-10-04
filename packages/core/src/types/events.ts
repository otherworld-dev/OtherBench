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
  | { type: 'peer-status'; nodeId: string; status: 'reachable' | 'unreachable' | 'pairing' }
  | { type: 'sync-applied'; nodeId: string; changed: number };

/** A tool call waiting for the user's approval, as the app-wide stream reports it. */
export interface PendingApprovalSummary {
  chatId: string;
  messageId: string;
  requestId: string;
  toolName: string;
}

/** The `hello` that opens `GET /api/events`: the state a new subscriber can't rebuild from later events. */
export interface AppEventsHello {
  pendingApprovals: PendingApprovalSummary[];
}
