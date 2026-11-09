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
}

export type ChatSendPatch = Partial<Pick<ChatSend, 'status' | 'toReplyId' | 'replyText' | 'reason' | 'resumedAs' | 'finishedAt'>>;

/** Every list is oldest first. */
export interface ChatSendRepo {
  create(s: Omit<ChatSend, 'createdAt' | 'finishedAt'> & { createdAt?: number }): ChatSend;
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
}
