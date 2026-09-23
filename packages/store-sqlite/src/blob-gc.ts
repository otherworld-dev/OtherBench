import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '@grunt/core/ports/store.js';
import type { BlobStore } from './blob-store.js';

/** A well-formed blob filename: a lowercase 64-hex sha256 digest, nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A well-formed shard directory name: the first two hex chars of a sha256. */
const SHARD_HEX = /^[0-9a-f]{2}$/;
/** A blob's own temp file mid-`BlobStore.put()` -- `<sha256>.tmp-<random hex>`. */
const TMP_FILE_RE = /^[0-9a-f]{64}\.tmp-[0-9a-f]+$/;
/** How old a `.tmp-*` file must be before the sweep treats it as crash debris rather than a write in progress. Generous on purpose -- an upload's own put()/extractAttachmentText()/create() sequence is milliseconds, never remotely close to this. */
const STALE_TMP_AGE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pinning (Important #3, task 32 fix round 1): closes the race between
// "bytes exist on disk" and "an attachment row references them". Both GC
// paths below treat a pinned sha256 as untouchable, no matter what the
// table currently says -- an upload in progress hasn't created its row yet,
// so `isReferenced` would (correctly, at that instant) say "nothing
// references this", which is exactly the state a concurrent GC pass must
// NOT act on.
//
// A refcount, not a plain Set: two concurrent uploads of identical content
// hash to the SAME sha256 and each pins/unpins independently (BlobStore.put
// is itself idempotent for this exact reason -- see its own doc) -- the
// first upload finishing must not unpin a sha256 the second upload is still
// relying on.
// ---------------------------------------------------------------------------

const pinCounts = new Map<string, number>();

function pin(sha256: string): void {
  pinCounts.set(sha256, (pinCounts.get(sha256) ?? 0) + 1);
}

function unpin(sha256: string): void {
  const count = pinCounts.get(sha256) ?? 0;
  if (count <= 1) pinCounts.delete(sha256);
  else pinCounts.set(sha256, count - 1);
}

/** True while at least one `withPinnedSha` call for this sha256 is still in flight. */
export function isPinned(sha256: string): boolean {
  return pinCounts.has(sha256);
}

/**
 * Pins `sha256` against both GC paths for the duration of `fn`, unpinning
 * even if `fn` throws (a `finally`, not a `.then`). Wrap the WHOLE
 * put-then-create sequence for a new upload in this -- see
 * `routes/attachments.ts`'s upload handler, the only production caller.
 */
export async function withPinnedSha<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
  pin(sha256);
  try {
    return await fn();
  } finally {
    unpin(sha256);
  }
}

/**
 * True for errors Node's own fs layer raises for a genuine OS/filesystem
 * failure -- a POSIX errno-style code on `.code`: always `E` followed by
 * uppercase letters only (`ENOENT`, `EACCES`, `EPERM`, `EBUSY`, `EMFILE`,
 * `ENOSPC`, ...). These mean "the disk or filesystem itself misbehaved" and
 * are safe to log and swallow, per decision #2's "any other [filesystem]
 * error is logged and does not fail the request or startup".
 *
 * Deliberately narrower than "has any string `.code`": Node's own
 * PROGRAMMING-error codes (`ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`,
 * ...) are ALSO plain strings on `.code` -- e.g. calling `readdir(undefined)`
 * (exactly what `blobStore.root` returning `undefined` produces) rejects
 * with `{ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }`, confirmed
 * empirically. A naive "any `.code` string" check would swallow that right
 * back into a silent no-op -- precisely the Minor #8 bug this function
 * exists to close. The `ERR_` prefix always contains an underscore, which
 * `^E[A-Z]+$` excludes, so it never matches here; every real errno code
 * does match.
 */
function isFilesystemError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code);
}

/**
 * Attachment blob garbage collection (task 32 decision #2): a blob on disk
 * (`BlobStore`, `<root>/<sha[0:2]>/<sha>`) is garbage exactly when no
 * `attachment` row references its sha256 any more -- upload dedupes by
 * content hash, so several rows (even across different chats) can share
 * one blob, and it must survive until the LAST one referencing it is gone.
 *
 * A filesystem-level failure (a locked file, a permissions error, a plain
 * missing file) is logged to stderr and swallowed -- a blob-cleanup hiccup
 * must never turn a successful row delete, chat/profile/connection delete,
 * or server startup into a failed request or a failed boot. A NON-
 * filesystem failure (a programming/wiring error) is NOT swallowed -- see
 * `isFilesystemError`'s doc.
 */

/**
 * GCs exactly one blob, by sha256, if nothing references it any more and it
 * isn't currently pinned (an upload of the same content still in flight --
 * see `withPinnedSha`). Decision #2a: run this after deleting a single
 * unsent attachment, for that attachment's OWN sha256 only -- cheap, since
 * the caller already knows which hash to check and doesn't need a disk
 * walk.
 */
export async function gcBlobIfOrphaned(store: Store, blobStore: BlobStore, sha256: string): Promise<void> {
  if (isPinned(sha256)) return;
  if (store.attachments.isReferenced(sha256)) return;
  try {
    // The initial checks above happened before `BlobStore.remove` even
    // started its own `await lstat(...)` -- a same-content upload can pin,
    // write, and create its row entirely inside that window (Important #2,
    // task 32 fix round 2; reproduced deterministically). `shouldStillRemove`
    // re-checks both, synchronously, right before the actual unlink.
    await blobStore.remove(sha256, () => !isPinned(sha256) && !store.attachments.isReferenced(sha256));
  } catch (err) {
    if (!isFilesystemError(err)) throw err;
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
 * Walks every file physically present under `blobStore.root` (the per-
 * database WRITE root -- see `resolveAttachmentsRoots`; this never touches
 * a legacy shared root, which is read-only from that fix onward) and
 * removes exactly the ones that are BOTH a well-formed blob file AND
 * garbage:
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
 *   - Garbage: not in `store.attachments.referencedShas()` (the full
 *     referenced set, fetched ONCE per sweep -- see that method's doc; this
 *     used to call `isReferenced` per file, one synchronous SQLite query
 *     per blob on disk, on every chat/profile/connection delete) and not
 *     currently pinned (`isPinned` -- an upload still in flight). That
 *     snapshot is only a fast PRE-filter, though: immediately before each
 *     `unlink`, both `isPinned` and the now-indexed `isReferenced` are
 *     re-checked synchronously, with no `await` in between (Important #1,
 *     task 32 fix round 2). A sweep over thousands of blobs runs for as
 *     long as it takes to `readdir`/`lstat` every one of them -- reproduced
 *     deterministically with a ~180ms sweep and an upload landing 5-60ms
 *     in: the snapshot taken at the START of the sweep is stale by the time
 *     the loop reaches that blob's shard, so a pin-put-create-unpin cycle
 *     that completes entirely inside the sweep's own runtime is invisible
 *     to the snapshot but must still block the unlink.
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
 * Also reclaims stale `*.tmp-*` files (`BlobStore.put()`'s own temp-file-
 * then-rename debris from a crash mid-write) older than
 * `STALE_TMP_AGE_MS` -- anything younger is left alone since it may be a
 * write genuinely in progress. Does NOT remove emptied shard directories
 * (an earlier version did, but that raced `put()`'s own `mkdir` for a
 * brand-new shard and could 500 a concurrent upload; an empty shard
 * directory is harmless to leave behind, so this simply stops trying).
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

    const referenced = store.attachments.referencedShas();

    for (const shard of shardNames) {
      if (!SHARD_HEX.test(shard)) continue;
      const shardDir = join(root, shard);
      const shardStat = await lstat(shardDir).catch(() => null);
      if (!shardStat || !shardStat.isDirectory()) continue;

      const entries = await readdir(shardDir).catch(() => [] as string[]);
      for (const name of entries) {
        const full = join(shardDir, name);

        if (TMP_FILE_RE.test(name)) {
          const tmpStat = await lstat(full).catch(() => null);
          if (tmpStat && tmpStat.isFile() && Date.now() - tmpStat.mtimeMs > STALE_TMP_AGE_MS) {
            try {
              await unlink(full);
            } catch (err) {
              console.error(`[grunt] blob sweep: failed to remove stale temp file "${full}":`, err);
            }
          }
          continue;
        }

        if (!SHA256_HEX.test(name) || !name.startsWith(shard)) continue;
        const fileStat = await lstat(full).catch(() => null);
        if (!fileStat || !fileStat.isFile()) continue;
        if (isPinned(name)) continue; // an upload of this exact content is still in flight

        result.scanned++;
        if (referenced.has(name)) continue; // fast pre-filter from the sweep-start snapshot -- see this function's own doc for why that alone isn't enough
        // Re-checked synchronously, right here, with no `await` before the
        // unlink call below: the snapshot above (and the isPinned check a
        // few lines up) can both be stale by now -- this loop may have
        // spent an unbounded amount of real time on readdir/lstat calls for
        // every blob before this one.
        if (isPinned(name) || store.attachments.isReferenced(name)) continue;
        try {
          await unlink(full);
          result.removed++;
        } catch (err) {
          console.error(`[grunt] blob sweep: failed to remove orphaned blob "${full}":`, err);
        }
      }
    }
  } catch (err) {
    if (!isFilesystemError(err)) throw err;
    console.error('[grunt] blob sweep failed:', err);
  }
  return result;
}

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
