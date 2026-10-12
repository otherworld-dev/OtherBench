import type { CanonMessage, Part } from '../types/messages.js';

/**
 * What a user's `image` and `file` parts in the history may name. An
 * attachment id in a stored message is only a claim: a message that arrived by
 * sync, or was edited, can name any id, and an engine that reads blobs by id
 * would then send another chat's file to a model. So every such part is
 * checked against the attachment rows before an engine sees the history, and a
 * part that fails becomes a short note (the turn goes on).
 */

const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** An attachment id as Grunt makes one (a UUID, or a short test id): letters, digits, `-` and `_`, at most 64. Nothing path-like. */
export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_ID.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * THE rule for whether an attachment is bound: it was sent (it has a message)
 * and that message exists in the attachment's OWN chat. `messageChatId` is the
 * chat the message belongs to, or null when there is no such message. Every
 * caller in JS uses this (the runner's replay check, the store's own refusal,
 * sync's checks); the one SQL spelling of it lives in store-sqlite's sync.ts
 * (`BOUND_ATTACHMENT_SQL`) beside a test that proves the two agree. A chat that
 * does not exist cannot have a message, so it needs no term of its own.
 * It fails closed: anything that is not a non-empty string (null, undefined,
 * '', a number, an object, an array) in any of the three fields is "not bound".
 */
export function attachmentBound(attachment: { chatId: unknown; messageId: unknown }, messageChatId: unknown): boolean {
  return nonEmptyString(attachment.chatId) && nonEmptyString(attachment.messageId) && nonEmptyString(messageChatId) && messageChatId === attachment.chatId;
}

/** The size an attachment may have to be replayed (the upload route's own cap). */
export const MAX_HISTORY_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const ATTACHMENT_NOT_BOUND = "[attachment omitted: it doesn't belong to this chat]";

/**
 * `messages` with each `image` / `file` part replaced by a note unless
 * `allowed(attachmentId)` says its attachment belongs in this chat. `'pending'`
 * is for a file that is not here yet (sync can bring a message before its
 * files): the part stays but is marked `pending`, and it is not an attachment
 * anyone may load until a later check says `true`. A part whose id is not an
 * attachment id, or whose check throws, is a note. Messages without such a
 * part come back as the same objects.
 */
export function bindHistoryAttachments(messages: CanonMessage[], allowed: (attachmentId: string) => boolean | 'pending'): CanonMessage[] {
  return messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part): Part => {
      if (part.type !== 'image' && part.type !== 'file') return part;
      let verdict: boolean | 'pending' = false;
      if (isAttachmentId(part.attachmentId)) {
        try {
          verdict = allowed(part.attachmentId);
        } catch {
          verdict = false;
        }
      }
      if (verdict === true) {
        if (!('pending' in part)) return part;
        changed = true;
        const { pending: _pending, ...verified } = part as Part & { pending?: boolean };
        return verified as Part;
      }
      changed = true;
      if (verdict === 'pending') return { ...part, pending: true } as unknown as Part;
      return { type: 'text', text: ATTACHMENT_NOT_BOUND };
    });
    return changed ? { ...message, parts } : message;
  });
}
