import type { CanonMessage, Part } from '../types/messages.js';

/**
 * What a user's `image` and `file` parts in the history may name. An
 * attachment id in a stored message is only a claim: a message that arrived by
 * sync, or was edited, can name any id, and an engine that reads blobs by id
 * would then send another chat's file to a model. So every such part is
 * checked against the attachment rows before an engine sees the history, and a
 * part that fails becomes a short note (the turn goes on).
 */

/** One or more words of letters, digits, `-` and `_` (each starting with a letter or digit), joined by single colons. */
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
export const MAX_ATTACHMENT_ID_LENGTH = 128;

/**
 * An attachment id as OtherBench makes one. The shapes it makes are: a UUID (an
 * upload, and a tool's image), `<transcript line uuid>:image:<n>` (an image a
 * Cowork import brought in, see cowork-import.ts), and the short ids tests
 * use. So: words of letters, digits, `-` and `_` joined by single colons, at
 * most 128 characters in all. Nothing path-like (`/`, `\`, `.`), no space or
 * control character, nothing empty, nothing that is not a string. An id is a
 * database key and a URL segment only; it never becomes part of a path on
 * disk (a blob is stored under its SHA-256).
 */
export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ATTACHMENT_ID_LENGTH && ATTACHMENT_ID.test(value);
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
        const { pending: _pending, ...verified } = part;
        return verified;
      }
      changed = true;
      if (verdict === 'pending') return { ...part, pending: true };
      return { type: 'text', text: ATTACHMENT_NOT_BOUND };
    });
    return changed ? { ...message, parts } : message;
  });
}
