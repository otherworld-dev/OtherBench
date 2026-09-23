import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface StoredBlob {
  sha256: string;
  /** Absolute path on disk this blob's bytes live at. */
  path: string;
  size: number;
}

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** True if node:fs/promises `stat` succeeded (the path exists), false for ENOENT specifically. Anything else (a permissions error, say) is a real failure and propagates. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isEnoentError(err)) return false;
    throw err;
  }
}

/**
 * Content-addressed blob storage for attachments (task 21 decision #1):
 * `<dataDir>/attachments/<sha256[0:2]>/<sha256>`, metadata (filename, mime,
 * chat/message association, extracted text) living entirely in
 * `AttachmentRepo` instead. The hash is always computed HERE, from the bytes
 * themselves -- `put()` takes no filename or path segment from the caller,
 * so nothing about the storage path can ever be influenced by a client-
 * supplied filename (the path-containment reminder in the task brief: the
 * original filename is metadata only, never joined into a filesystem path).
 *
 * The same bytes uploaded through five different chats/attachment rows
 * write to this ONE path exactly once -- `put()` is idempotent: a second
 * `put()` of identical content finds the path already populated and skips
 * the write entirely (see `put()`'s own doc for the concurrent-upload race
 * this also happens to make safe).
 */
export class BlobStore {
  constructor(private readonly dataDir: string) {}

  /**
   * The directory every blob lives somewhere under: `<dataDir>/attachments`.
   * The blob GC sweep (`blob-gc.ts`'s `sweepOrphanedBlobs`) walks this
   * directory directly to diff what's physically on disk against what the
   * `AttachmentRepo` table still references -- exposed as a getter (rather
   * than making the sweep reach into `dataDir` itself) so this class stays
   * the one place that knows the on-disk layout.
   */
  get root(): string {
    return join(this.dataDir, 'attachments');
  }

  /**
   * Where a blob with this sha256 hex digest would live, or does live.
   * Pure path arithmetic -- no I/O, so it's safe to call before `put()` (to
   * check `AttachmentRepo` for an existing row with the same hash and skip
   * re-uploading entirely) as well as after.
   */
  pathFor(sha256: string): string {
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  /**
   * Writes `data`, addressed by its own sha256 hash. Returns the hash, the
   * absolute path it was written to (or already existed at), and the byte
   * length.
   *
   * Written atomically: `data` is first written to a sibling temp file
   * (unique per call, via a random suffix) and then renamed over the final
   * path, so a crash mid-write can never leave a truncated/partial blob at
   * `pathFor(sha256)` -- any reader either sees the complete file or none at
   * all. This also makes two concurrent `put()`s of the SAME bytes safe: both
   * compute the same hash, both write to their own distinct temp file, and
   * whichever rename lands second simply replaces the first with byte-
   * identical content -- neither observes a torn write.
   */
  async put(data: Buffer): Promise<StoredBlob> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const path = this.pathFor(sha256);

    if (!(await pathExists(path))) {
      await mkdir(dirname(path), { recursive: true });
      const tmpPath = `${path}.tmp-${randomBytes(6).toString('hex')}`;
      await writeFile(tmpPath, data);
      await rename(tmpPath, path);
    }

    return { sha256, path, size: data.length };
  }

  /** Reads back the bytes for a previously-`put()` sha256 hash. Rejects (ENOENT) if nothing was ever stored under it. */
  async get(sha256: string): Promise<Buffer> {
    return readFile(this.pathFor(sha256));
  }

  /**
   * Unlinks the blob for `sha256`, if any. A missing file is treated as
   * already-clean (resolves normally, no error) -- the caller (attachment
   * GC, `blob-gc.ts`) only ever calls this once it has already decided the
   * blob is garbage, and "it's already gone" is success, not a failure.
   * Any other error (permissions, a locked file, ...) propagates so the
   * caller can log it -- this method itself makes no decision about whether
   * such a failure should be swallowed.
   */
  async remove(sha256: string): Promise<void> {
    try {
      await unlink(this.pathFor(sha256));
    } catch (err) {
      if (!isEnoentError(err)) throw err;
    }
  }
}

export function createBlobStore(dataDir: string): BlobStore {
  return new BlobStore(dataDir);
}
