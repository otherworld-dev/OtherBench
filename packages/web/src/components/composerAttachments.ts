import type { PublicAttachment } from '@otherbench/core/ports/store.js';
import type { Part } from '@otherbench/core/types/messages.js';

/** An attachment chip in the box: an upload, or one a returned note brought back (whose size isn't known). */
export type ChipAttachment = Pick<PublicAttachment, 'id' | 'filename' | 'mime'> & { size?: number };

/**
 * The `Part` an uploaded attachment becomes on the outgoing message (task
 * 21): `image` for anything with an `image/*` MIME type -- the only shape
 * `toModelMessages`/`TurnRunner`'s capability fallback knows how to embed as
 * real visual content or degrade -- `file` for everything else (PDFs, text,
 * CSVs, ...), which `toModelMessages` sends as file content unconditionally.
 */
export function attachmentToPart(attachment: ChipAttachment): Part {
  return attachment.mime.startsWith('image/')
    ? { type: 'image', attachmentId: attachment.id, mime: attachment.mime }
    : { type: 'file', attachmentId: attachment.id, mime: attachment.mime, filename: attachment.filename };
}

/**
 * Per-file upload cap. Mirrors the server's `MAX_ATTACHMENT_BYTES`
 * (packages/server/src/routes/attachments.ts); keep the two in step. Checked
 * here so a far-oversized file is refused before any bytes are sent: the server
 * rejects an over-limit body without draining it, and for a very large one the
 * socket resets before the client can read the 413 message.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const UPLOAD_TOO_LARGE_MESSAGE = 'That upload is too large. Attachments are limited to 25MB per file.';

/**
 * Reads dropped/pasted files off a `DataTransfer`. Prefers `.files` (what a
 * `drop` event, and a browser pasting an image, both populate) and falls
 * back to walking `.items` (`DataTransferItemList`) for anything that only
 * populated that -- some browsers only fill `.items` on `paste`, not `.files`.
 */
export function filesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  if (data.files && data.files.length > 0) return Array.from(data.files);
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
}
