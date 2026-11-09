// --- attachments ----------------------------------------------------------------

export interface Attachment {
  id: string;
  chatId: string;
  messageId: string | null;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  storagePath: string;
  extractedText: string | null;
}

export interface AttachmentRepo {
  create(a: Attachment): Attachment;
  get(id: string): Attachment | null;
  list(chatId: string): Attachment[];
  update(id: string, patch: Partial<Omit<Attachment, 'id'>>): Attachment;
  delete(id: string): void;
  /**
   * True if at least one attachment row (in any chat -- upload dedupes by
   * content hash, so the same blob can be referenced from several chats,
   * see `BlobStore`) still has this sha256. Used by the blob GC sweep
   * (`@otherbench/store-sqlite/blob-gc.js`) to decide whether a blob on disk is
   * garbage: a blob is only ever removed once nothing references it.
   */
  isReferenced(sha256: string): boolean;
  /**
   * Every distinct sha256 referenced by at least one attachment row, across
   * every chat. Used by the startup blob sweep, which walks what is
   * physically on disk and needs the full referenced set to diff against --
   * see `@otherbench/store-sqlite/blob-gc.js`'s `sweepOrphanedBlobs`.
   */
  referencedShas(): Set<string>;
  /**
   * Unsent attachments (`messageId === null`) last written by THIS machine
   * before `writtenBefore` (ms since the epoch): the candidates for the
   * abandoned-attachment sweep (`@otherbench/store-sqlite/blob-gc.js`'s
   * `sweepAbandonedAttachments`). Age is the row's last write, not its
   * upload, so any change to it starts the clock again. A row last written
   * by another machine is never listed.
   */
  abandoned(writtenBefore: number): Attachment[];
}

/**
 * The subset of `Attachment` ever serialised to a client (task 32 decision
 * #3): `storagePath` is a raw SERVER filesystem path -- the client has no
 * use for it (attachment bytes are always fetched via
 * `GET /attachments/:id/content`, never a filesystem path) and it should
 * never leave the server. `storagePath` stays on the full `Attachment` type
 * (and in the database) because the server itself needs it (`BlobStore.get`/
 * `remove`); every route response strips it down to this shape instead --
 * see `routes/attachments.ts`'s `toPublicAttachment`. The web client's own
 * `Attachment`-shaped state should be typed as this, not the full row, since
 * this is all it will ever actually receive.
 */
export type PublicAttachment = Omit<Attachment, 'storagePath'>;
