import type { CanonMessage, Part } from '../types/messages.js';

/**
 * What a user's `image` and `file` parts in the history may name. An
 * attachment id in a stored message is only a claim: a message that arrived by
 * sync, or was edited, can name any id, and an engine that reads blobs by id
 * would then send another chat's file to a model. So every such part is
 * checked against the attachment rows before an engine sees the history, and a
 * part that fails becomes a short note (the turn goes on).
 */

/**
 * THE rule for whether an attachment is bound: it was sent (it has a message)
 * and that message exists in the attachment's OWN chat. `messageChatId` is the
 * chat the message belongs to, or null when there is no such message. Every
 * caller in JS uses this (the runner's replay check, the store's own refusal,
 * sync's checks); the one SQL spelling of it lives in store-sqlite's sync.ts
 * (`BOUND_ATTACHMENT_SQL`) beside a test that proves the two agree. A chat that
 * does not exist cannot have a message, so it needs no term of its own.
 */
export function attachmentBound(attachment: { chatId: string; messageId: string | null }, messageChatId: string | null): boolean {
  return attachment.messageId !== null && messageChatId !== null && messageChatId === attachment.chatId;
}

/** The size an attachment may have to be replayed (the upload route's own cap). */
export const MAX_HISTORY_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const ATTACHMENT_NOT_BOUND = "[attachment omitted: it doesn't belong to this chat]";

/**
 * `messages` with each `image` / `file` part replaced by a note unless
 * `allowed(attachmentId)` says its attachment belongs in this chat. Messages
 * without such a part come back as the same objects.
 */
export function bindHistoryAttachments(messages: CanonMessage[], allowed: (attachmentId: string) => boolean): CanonMessage[] {
  return messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part): Part => {
      if (part.type !== 'image' && part.type !== 'file') return part;
      let ok = false;
      try {
        ok = allowed(part.attachmentId);
      } catch {
        ok = false;
      }
      if (ok) return part;
      changed = true;
      return { type: 'text', text: ATTACHMENT_NOT_BOUND };
    });
    return changed ? { ...message, parts } : message;
  });
}
