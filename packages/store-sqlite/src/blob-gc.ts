import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '@grunt/core/ports/store.js';
import type { BlobStore } from './blob-store.js';

/** A well-formed blob filename: a lowercase 64-hex sha256 digest, nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A well-formed shard directory name: the first two hex chars of a sha256. */
const SHARD_HEX = /^[0-9a-f]{2}$/;

/**
 * Attachment blob garbage collection (task 32 decision #2): a blob on disk
 * (`BlobStore`, `<dataDir>/attachments/<sha[0:2]>/<sha>`) is garbage exactly
 * when no `attachment` row references its sha256 any more -- upload dedupes
 * by content hash, so several rows (even across different chats) can share
 * one blob, and it must survive until the LAST one referencing it is gone.
 *
 * Both functions below are deliberately total: neither ever rejects. A
 * missing file is fine (already clean). Any other failure -- a locked file,
 * a permissions error, even a nonsensical `store`/`blobStore` -- is logged
 * to stderr and swallowed, so a blob-cleanup hiccup can never turn a
 * successful row delete, chat/profile/connection delete, or server startup
 * into a failed request or a failed boot.
 */

/**
 * GCs exactly one blob, by sha256, if nothing references it any more.
 * Decision #2a: run this after deleting a single unsent attachment, for
 * that attachment's OWN sha256 only -- cheap, since the caller already knows
 * which hash to check and doesn't need a disk walk.
 */
export async function gcBlobIfOrphaned(store: Store, blobStore: BlobStore, sha256: string): Promise<void> {
  try {
    if (store.attachments.isReferenced(sha256)) return;
    await blobStore.remove(sha256);
  } catch (err) {
    console.error(`[grunt] failed to garbage-collect attachment blob "${sha256}":`, err);
  }
}

export interface BlobSweepResult {
  /** Well-formed blob files found on disk, referenced or not. */
  scanned: number;
  /** Of those, how many were unreferenced and removed. */
  removed: number;
}

/**
 * Walks every file physically present under `blobStore.root` and removes
 * exactly the ones that are BOTH a well-formed blob file AND garbage:
 *
 *   - Well-formed: a lowercase 64-hex sha256 name, which is itself a plain
 *     FILE (never a symlink/junction -- checked with `lstat`, which reports
 *     the link itself rather than following it, so a symlink is skipped
 *     outright and never deleted OR traversed), sitting directly inside the
 *     one shard directory its own hash prefix names (also `lstat`-checked to
 *     be a real directory, not a symlink standing in for one), which is
 *     itself a direct child of `blobStore.root`. Nothing else on disk --
 *     a stray non-blob file, a misnamed shard dir, anything outside
 *     `blobStore.root` -- is ever inspected as a delete candidate, let alone
 *     deleted.
 *   - Garbage: `store.attachments.isReferenced` says no attachment row has
 *     this sha256 any more.
 *
 * Enumerates disk and diffs it against the table (never the other way
 * round), so it also reclaims blobs orphaned before this GC existed, or left
 * behind by a crash between a row delete and its blob cleanup. Used both as
 * the startup sweep (decision #2c) and, exactly as-is, after a chat/profile/
 * connection delete (decision #2b): those cascade attachment rows away in
 * bulk (possibly across several FK hops -- connection -> profile -> chat ->
 * attachment), and re-walking disk is simpler and just as correct as trying
 * to track precisely which shas a multi-level cascade touched.
 *
 * Best-effort tidy-up: a shard directory left empty after its blobs are
 * removed is also removed, but failing to do so is not an error.
 */
export async function sweepOrphanedBlobs(store: Store, blobStore: BlobStore): Promise<BlobSweepResult> {
  const result: BlobSweepResult = { scanned: 0, removed: 0 };
  try {
    const root = blobStore.root;
    const shardNames = await readdir(root).catch((err: unknown) => {
      if (isEnoentError(err)) return null; // nothing has ever been uploaded
      throw err;
    });
    if (shardNames === null) return result;

    for (const shard of shardNames) {
      if (!SHARD_HEX.test(shard)) continue;
      const shardDir = join(root, shard);
      const shardStat = await lstat(shardDir).catch(() => null);
      if (!shardStat || !shardStat.isDirectory()) continue;

      const entries = await readdir(shardDir).catch(() => [] as string[]);
      for (const name of entries) {
        if (!SHA256_HEX.test(name) || !name.startsWith(shard)) continue;
        const full = join(shardDir, name);
        const fileStat = await lstat(full).catch(() => null);
        if (!fileStat || !fileStat.isFile()) continue;

        result.scanned++;
        if (store.attachments.isReferenced(name)) continue;
        try {
          await unlink(full);
          result.removed++;
        } catch (err) {
          console.error(`[grunt] blob sweep: failed to remove orphaned blob "${full}":`, err);
        }
      }

      try {
        const remaining = await readdir(shardDir);
        if (remaining.length === 0) await rmdir(shardDir);
      } catch {
        // Cosmetic only -- an emptied shard dir that can't be removed (or a
        // race that repopulated it) is not a failure.
      }
    }
  } catch (err) {
    console.error('[grunt] blob sweep failed:', err);
  }
  return result;
}

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
