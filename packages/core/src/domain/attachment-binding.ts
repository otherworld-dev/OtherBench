import type { CanonMessage, Part } from '../types/messages.js';

/**
 * What a user's `image` and `file` parts in the history may name. An
 * attachment id in a stored message is only a claim: a message that arrived by
 * sync, or was edited, can name any id, and an engine that reads blobs by id
 * would then send another chat's file to a model. So every such part is
 * checked against the attachment rows before an engine sees the history, and a
 * part that fails becomes a short note (the turn goes on).
 */

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
