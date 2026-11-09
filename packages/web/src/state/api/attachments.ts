/** Attachment calls for `api.attachments`. */
import type { PublicAttachment } from '@otherbench/core/ports/store.js';
import { apiUrl } from '../transport.js';
import { request, post, del, uploadFile } from './http.js';

/** See `api.attachments.previewable`'s doc -- must stay identical to the server's `INLINE_SAFE_MIME_TYPES`. */
const INLINE_PREVIEWABLE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/avif',
]);

export const attachmentsApi = {
  upload: (chatId: string, file: File) => uploadFile<PublicAttachment>(`/chats/${chatId}/attachments`, file),
  list: (chatId: string) => request<PublicAttachment[]>(`/chats/${chatId}/attachments`),
  /** Attaches an image straight from a path on this machine (desktop `--send`). Images only, 25MB cap. */
  fromPath: (chatId: string, path: string) => post<PublicAttachment>(`/chats/${chatId}/attachments/from-path`, { path }),
  /**
   * Deletes an UNSENT attachment (server-enforced: 409 if it's already
   * part of a sent message -- see routes/attachments.ts decision #1).
   * Removes the row and, unless another attachment row still shares its
   * content hash, its on-disk blob too.
   */
  delete: (id: string) => del(`/attachments/${id}`),
  /** Not fetched via `request` -- rendered through `AuthedImage`, which adds the token when there is one. */
  contentUrl: (id: string) => apiUrl(`/attachments/${id}/content`),
  /**
   * An image a tool returned (a screenshot), by the chat and the reply that hold
   * it -- the server serves it only for that exact pair, and as a 404 otherwise.
   * Use this, not `contentUrl`, for the images in a tool result.
   */
  toolImageUrl: (chatId: string, messageId: string, attachmentId: string) =>
    apiUrl(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/tool-images/${encodeURIComponent(attachmentId)}`),
  /** The same scoped route serves a tool's video (it supports Range). */
  toolMediaUrl: (chatId: string, messageId: string, attachmentId: string) =>
    apiUrl(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/tool-images/${encodeURIComponent(attachmentId)}`),
  /**
   * True only for the narrow raster-image allowlist that
   * `GET /attachments/:id/content` (packages/server/src/routes/
   * attachments.ts's `INLINE_SAFE_MIME_TYPES`) will actually serve
   * `inline` with its real Content-Type -- kept in sync with that
   * allowlist deliberately. Everything else, including `image/svg+xml`
   * (SVG can carry script, so it's excluded there on purpose), now comes
   * back as an opaque `application/octet-stream` download regardless of
   * the mime string, so pointing an `<img src>` at it would only ever
   * show a broken-image icon -- callers should gate any inline preview
   * on this instead of a bare `mime.startsWith('image/')` check.
   */
  previewable: (mime: string): boolean => INLINE_PREVIEWABLE_MIME_TYPES.has((mime.split(';')[0] ?? '').trim().toLowerCase()),
};
