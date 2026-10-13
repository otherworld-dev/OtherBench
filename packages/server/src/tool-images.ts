import { randomUUID } from 'node:crypto';
import { MAX_TOOL_IMAGE_BYTES, sniffToolImageMime, type SaveToolImage } from '@grunt/core/domain/tool-images.js';
import type { Store } from '@grunt/core/ports/store.js';
import { gcBlobIfOrphaned, withPinnedSha } from '@grunt/store-sqlite/blob-gc.js';
import { sha256Of, type BlobStore } from '@grunt/store-sqlite/blob-store.js';

/** The file name a stored tool image gets, by its type: fixed, and never made from anything a tool or a model said. */
const TOOL_IMAGE_FILENAMES: ReadonlyMap<string, string> = new Map([
  ['image/png', 'tool-image.png'],
  ['image/jpeg', 'tool-image.jpg'],
  ['image/gif', 'tool-image.gif'],
  ['image/webp', 'tool-image.webp'],
]);

/**
 * Where `TurnRunner` keeps an image a tool returned (spec
 * 2026-10-12-computer-use-design section 6): the bytes in the blob store,
 * plus an attachment row on the reply (`messageId` set), so blob GC keeps
 * them while the reply exists and the chat-and-reply scoped route
 * (`GET /api/chats/:chatId/messages/:messageId/tool-images/:attachmentId`,
 * routes/attachments.ts) serves them.
 *
 * The row is made through the store's attachment repo with the chat and the
 * reply exactly as the runner passes them. The repo refuses a reply that is
 * missing or belongs to another chat, so this only works once the reply's
 * row exists (it does: the runner creates it before the engine streams).
 * Every call gets a new id, the same bytes included: a reference names one
 * image of one reply.
 *
 * `keepToolImages` (core) hands over bytes it has already checked, with the
 * type it read from them. This checks the same again and refuses anything
 * else, so nothing that is not a png, jpeg, gif or webp of at most
 * `MAX_TOOL_IMAGE_BYTES` is ever stored as a tool image, whoever calls. A
 * refusal throws; the runner shows `[image not kept]` in its place.
 *
 * Nothing is left behind by a failure. The blob is written first and the row
 * second, so a blob that can't be written leaves no row. When the row is
 * refused, the blob is removed straight away unless another row still uses
 * the same content (`gcBlobIfOrphaned`). What that can't remove (a locked
 * file, a half-written temp file) goes with the next `sweepOrphanedBlobs`,
 * which runs at startup and after a chat, profile or connection is deleted.
 * As for an upload (routes/attachments.ts), the content is pinned from
 * before the write until the row exists, so a GC pass in between can't take it.
 */
export function toolImageSaver(store: Store, blobStore: BlobStore): SaveToolImage {
  return async (chatId, messageId, bytes, mime) => {
    const filename = typeof mime === 'string' ? TOOL_IMAGE_FILENAMES.get(mime) : undefined;
    if (filename === undefined) throw new Error('Not a kind of image a tool result may hold.');
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_TOOL_IMAGE_BYTES) throw new Error('A tool image must be between 1 byte and 5 MB.');
    if (sniffToolImageMime(bytes) !== mime) throw new Error('The bytes are not the kind of image they were said to be.');

    const sha256 = sha256Of(bytes);
    try {
      return await withPinnedSha(sha256, async () => {
        const blob = await blobStore.put(bytes);
        return store.attachments.create({
          id: randomUUID(),
          chatId,
          messageId,
          filename,
          mime,
          size: bytes.length,
          sha256: blob.sha256,
          storagePath: blob.path,
          extractedText: null,
        }).id;
      });
    } catch (err) {
      // The pin is gone by now, so the blob can be collected if nothing else refers to it.
      await gcBlobIfOrphaned(store, blobStore, sha256).catch((gcErr: unknown) => {
        console.error(`[grunt-server] couldn't clear the blob of a tool image that was not kept (${sha256}):`, gcErr);
      });
      throw err;
    }
  };
}
