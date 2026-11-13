import type { ChatSendStatus } from '../../domain/chat-sends.js';

// --- chat sends (spec 2026-11-06-chat-to-chat-design) ---------------------

/**
 * One message a chat's model sent to another chat, and where it is. Local to
 * this machine (migration 044, no sync triggers): sends only reach chats that
 * run here. None of the ids is a foreign key: a chat can be deleted while a
 * send to or from it waits, and the service settles it then.
 */
export interface ChatSend {
  id: string;
  /** The first sending reply of the chain: everything that follows from one message the user sent. */
  chainId: string;
  /** 1 for the sends of the chat the user wrote in, 2 for the sends those chats make, and so on. */
  depth: number;
  fromChatId: string;
  /** The reply that called the tool. Its sends are one group: the sender resumes once all of them have settled. */
  fromMessageId: string;
  toChatId: string;
  /** The send made `toChatId` (a new chat in an app). */
  createdChat: boolean;
  text: string;
  status: ChatSendStatus;
  /** The reply in the target chat working on it, null until delivered. Moves to the target's resumed reply when it sends on and resumes. */
  toReplyId: string | null;
  replyText: string | null;
  /** Why it failed, stopped or was dropped. */
  reason: string | null;
  /** The sender's reply that took the group's replies, once it has; set on every row of the group. */
  resumedAs: string | null;
  createdAt: number;
  finishedAt: number | null;
  // --- across machines (spec 2026-11-13-chat-sends-across-machines-design, migration 049) ---
  /** Sender's side: the paired machine this send was handed to; null when the target runs here. */
  toNode: string | null;
  /** Target's side: the paired machine the send came from; null when it was sent here. */
  fromNode: string | null;
  /** The app a new chat is made in, for a send that makes one (the chat may not exist anywhere yet). */
  toAppId: string | null;
  /** Target's side: the sender chat's title as its machine gave it (that chat may not have synced here yet). */
  fromTitle: string | null;
  /** Sender's side: when the target's machine took it. */
  handedAt: number | null;
  /** Target's side: when the sender's machine took the outcome. */
  reportedAt: number | null;
  /** Sender's side: a stop the target's machine hasn't been told yet. */
  stopPending: string | null;
  /** Sender's side: why a handover is waiting (the machine is off or busy); null while it isn't. */
  heldReason: string | null;
  /** The user chose Wait for the held send: it no longer needs them. */
  heldSeen: boolean;
  /** Target's side: how many sends the chain had on the sender's machine at handover, for the chain limit. */
  chainBase: number;
}

/** The fields a new row may leave out: they default to null, false and 0. */
export type ChatSendRemoteFields = 'toNode' | 'fromNode' | 'toAppId' | 'fromTitle' | 'handedAt' | 'reportedAt' | 'stopPending' | 'heldReason' | 'heldSeen' | 'chainBase';

export type NewChatSend = Omit<ChatSend, 'createdAt' | 'finishedAt' | ChatSendRemoteFields> & Partial<Pick<ChatSend, ChatSendRemoteFields>> & { createdAt?: number };

export type ChatSendPatch = Partial<
  Pick<ChatSend, 'status' | 'toReplyId' | 'replyText' | 'reason' | 'resumedAs' | 'finishedAt' | 'toChatId' | 'toNode' | 'handedAt' | 'reportedAt' | 'stopPending' | 'heldReason' | 'heldSeen'>
>;

/** A send as the send card reads it: the row, the machine its target runs on, and whether it could run here. */
export type ChatSendView = ChatSend & {
  /** The paired machine's name, or null when the target runs here. */
  machine: string | null;
  /** A held send's target could run on this machine (no folder, or its folder is here). */
  canRunHere: boolean;
};

/** Every list is oldest first. */
export interface ChatSendRepo {
  create(s: NewChatSend): ChatSend;
  get(id: string): ChatSend | null;
  /** Throws for an unknown id. */
  update(id: string, patch: ChatSendPatch): ChatSend;
  byFromMessage(messageId: string): ChatSend[];
  byToReply(replyId: string): ChatSend[];
  byResumedAs(replyId: string): ChatSend[];
  byChain(chainId: string): ChatSend[];
  byFromChat(chatId: string): ChatSend[];
  byToChat(chatId: string): ChatSend[];
  /** The rows still queued or running. */
  unsettled(): ChatSend[];
  /** Settled rows whose group hasn't gone back to its sender (`resumedAs` null): what a restart must pick up. */
  unresumed(): ChatSend[];
  /**
   * Rows that still owe a paired machine something: handed-to rows still queued (not handed over yet), rows with a
   * stop not yet told, and mirror rows settled but not yet reported back.
   */
  remoteWork(): ChatSend[];
}
