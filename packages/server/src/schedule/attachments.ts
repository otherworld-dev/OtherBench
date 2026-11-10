import type { Part } from '@otherbench/core/types/messages.js';
import type { PublicScheduleAttachment, Schedule, ScheduleAttachment, Store } from '@otherbench/core/ports/store.js';
import { gcBlobIfOrphaned } from '@otherbench/store-sqlite/blob-gc.js';
import type { BlobStore } from '@otherbench/store-sqlite/blob-store.js';

/**
 * A schedule's files (`ScheduleAttachment`, migration 047): what the API
 * shows of them, what a run sends, and freeing their blobs when schedules go.
 */

/** Strips the server path and the extracted text, as `toPublicAttachment` does for a chat's. */
export function toPublicScheduleAttachment(a: ScheduleAttachment): PublicScheduleAttachment {
  const { storagePath, extractedText, ...rest } = a;
  return rest;
}

/**
 * Copies the schedule's files into the run's chat as ordinary unsent
 * attachments, on the same blobs (nothing is written to disk), and gives the
 * parts that send them: an image as an image, anything else as a file, as the
 * composer does. The turn binds each to the message it sends. Synchronous,
 * so no GC pass can fall between reading a file and its copy referencing the
 * blob, which the schedule's own row holds until then anyway.
 */
export function runAttachmentParts(store: Store, scheduleId: string, chatId: string, newId: () => string): Part[] {
  return store.schedules.attachments(scheduleId).map((a) => {
    const copy = store.attachments.create({
      id: newId(),
      chatId,
      messageId: null,
      filename: a.filename,
      mime: a.mime,
      size: a.size,
      sha256: a.sha256,
      storagePath: a.storagePath,
      extractedText: a.extractedText,
    });
    return copy.mime.startsWith('image/')
      ? { type: 'image', attachmentId: copy.id, mime: copy.mime }
      : { type: 'file', attachmentId: copy.id, mime: copy.mime, filename: copy.filename };
  });
}

/** The blobs these schedules' files hold, read before the schedules are deleted so they can be freed after. */
export function scheduleBlobShas(store: Store, schedules: Pick<Schedule, 'id'>[]): Set<string> {
  return new Set(schedules.flatMap((s) => store.schedules.attachments(s.id).map((a) => a.sha256)));
}

/** Frees each blob nothing references any more (`gcBlobIfOrphaned`: a chat attachment or another schedule's file keeps it). */
export async function releaseBlobs(store: Store, blobStore: BlobStore, shas: Iterable<string>): Promise<void> {
  for (const sha256 of shas) await gcBlobIfOrphaned(store, blobStore, sha256);
}
