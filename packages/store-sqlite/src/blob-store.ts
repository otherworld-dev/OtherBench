import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface StoredBlob {
  sha256: string;
  /** Absolute path on disk this blob's bytes live at. */
  path: string;
  size: number;
}

/**
 * A blob's hash becomes a path, and a hash can arrive from another machine
 * (sync), so anything but a SHA-256 hex digest is refused before it gets
 * near one: `../..` must never escape the store.
 */
function assertSha256(sha256: string): void {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Not a blob hash: ${JSON.stringify(sha256.slice(0, 80))}`);
}

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The sha256 hex digest of `data`. Exposed so a caller can pin a sha256 against GC (`blob-gc.ts`'s `withPinnedSha`) BEFORE calling `put()`, closing the window between "bytes exist on disk" and "a row references them" that `put()` alone can't close. */
export function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface AttachmentsRoots {
  /**
   * Where THIS database's blobs are written, and the only directory the GC
   * sweep (`blob-gc.ts`) ever deletes from. Unique per database -- see
   * `resolveAttachmentsRoots`'s doc for why that matters.
   */
  writeRoot: string;
  /**
   * The pre-fix shared root every database used to write to
   * (`<dirname(secretsPath)>/attachments`). Read-only from here on: `get()`
   * falls back to it so blobs uploaded before per-database roots existed
   * stay servable, but nothing ever writes to it or sweeps it again.
   */
  legacyRoot: string;
  /** True when `writeRoot` is an ephemeral per-process temp directory (a `:memory:` database has no stable path to derive a root from). */
  isTemporary: boolean;
}

/**
 * Derives where a database's attachment blobs live, from the DATABASE path
 * itself -- never from `secretsPath`, and never shared with any other
 * database. Fixes a real incident (task 32 fix round 1, Critical 2): the
 * old scheme derived one directory (`dirname(secretsPath)/attachments`)
 * shared by every database that happened to sit next to the same
 * `secrets.json` -- so opening a SECOND database in that same directory
 * (or the default `:memory:` config, which resolves its secrets path to
 * `~/.grunt/secrets.json` same as the default file database) made the
 * startup/cascade-delete sweep see the FIRST database's still-in-use blobs
 * as "nothing in MY table references this" and delete them.
 *
 * - A file database at `<dir>/<full-basename>` gets
 *   `<dir>/<full-basename>.attachments/` -- unique to that one file,
 *   derived from its ENTIRE basename, extension included. (Fix round 2,
 *   Critical 1: an earlier version stripped the extension first, so
 *   `main.db` and `main.bak`, or `grunt` and `grunt.db`, collided on the
 *   exact same `<stem>.attachments/` -- reproduced live: two such
 *   databases opened side by side, each one's sweep deleted the other's
 *   blobs. The full basename can never collide between two distinct
 *   filenames in the same directory, because the filenames themselves
 *   don't. This also fixes fix round 2's Minor #5: a database literally
 *   named `foo.attachments` now gets `foo.attachments.attachments` --
 *   still distinct from its own path -- instead of colliding with itself.)
 * - `:memory:` has no stable on-disk path to derive anything from, so it
 *   gets a fresh, unique temp directory every time (`isTemporary: true`);
 *   nothing else can ever collide with it, and there's nothing to preserve
 *   across restarts since the database itself doesn't persist either.
 *
 * `legacyRoot` is always `<dirname(secretsPath)>/attachments` -- exactly
 * where the OLD shared scheme put every database's blobs, `:memory:`
 * included, since `secretsPath` was the only stable anchor available before
 * this fix. Never written to, never swept -- see `BlobStore.get`'s
 * fallback and `blob-gc.ts`, which only ever touches `writeRoot`.
 */
export function resolveAttachmentsRoots(dbPath: string, secretsPath: string): AttachmentsRoots {
  const legacyRoot = join(dirname(secretsPath), 'attachments');

  if (dbPath === ':memory:') {
    const writeRoot = mkdtempSync(join(tmpdir(), 'grunt-attachments-'));
    return { writeRoot, legacyRoot, isTemporary: true };
  }

  const dir = dirname(dbPath);
  const fullBasename = basename(dbPath);
  const writeRoot = join(dir, `${fullBasename}.attachments`);
  return { writeRoot, legacyRoot, isTemporary: false };
}

/**
 * Content-addressed blob storage for attachments (task 21 decision #1):
 * `<root>/<sha256[0:2]>/<sha256>`, metadata (filename, mime, chat/message
 * association, extracted text) living entirely in `AttachmentRepo` instead.
 * The hash is always computed HERE, from the bytes themselves -- `put()`
 * takes no filename or path segment from the caller, so nothing about the
 * storage path can ever be influenced by a client-supplied filename (the
 * path-containment reminder in the task brief: the original filename is
 * metadata only, never joined into a filesystem path).
 *
 * The same bytes uploaded through five different chats/attachment rows
 * write to this ONE path exactly once -- `put()` is idempotent: a second
 * `put()` of identical content finds the path already populated and skips
 * the write entirely (see `put()`'s own doc for the concurrent-upload race
 * this also happens to make safe).
 *
 * `root` is per-database (see `resolveAttachmentsRoots`) -- this class
 * itself doesn't know or care whether it was given a real database's own
 * root or a `:memory:` database's temp directory, only that it is the ONE
 * place it reads from, writes to, and (via the GC sweep) deletes from. An
 * optional `legacyRoot` is read-only fallback territory: `get()` tries it
 * ONLY after `root` misses, and nothing else in this class -- `put()`,
 * `remove()`, `pathFor()`, the `root` getter itself -- ever references it.
 */
export class BlobStore {
  constructor(
    private readonly rootDir: string,
    private readonly legacyRoot?: string
  ) {}

  /**
   * The directory every blob this store WRITES lives somewhere under. The
   * blob GC sweep (`blob-gc.ts`'s `sweepOrphanedBlobs`) walks this
   * directory directly to diff what's physically on disk against what the
   * `AttachmentRepo` table still references -- exposed as a getter (rather
   * than making the sweep reach into a raw path itself) so this class stays
   * the one place that knows the on-disk layout. Never the legacy root.
   */
  get root(): string {
    return this.rootDir;
  }

  /**
   * Where a blob with this sha256 hex digest would live, or does live, under
   * the WRITE root. Pure path arithmetic -- no I/O, so it's safe to call
   * before `put()` (to check `AttachmentRepo` for an existing row with the
   * same hash and skip re-uploading entirely) as well as after.
   */
  pathFor(sha256: string): string {
    assertSha256(sha256);
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  private legacyPathFor(sha256: string): string | null {
    assertSha256(sha256);
    return this.legacyRoot ? join(this.legacyRoot, sha256.slice(0, 2), sha256) : null;
  }

  /**
   * Writes `data`, addressed by its own sha256 hash, into the WRITE root
   * (never the legacy one). Returns the hash, the absolute path it was
   * written to, and the byte length.
   *
   * Written atomically, and UNCONDITIONALLY: `data` is always written to a
   * sibling temp file (unique per call, via a random suffix) and then
   * renamed over the final path, regardless of whether a file already sits
   * there. A crash mid-write can never leave a truncated/partial blob at
   * `pathFor(sha256)` -- any reader either sees the complete file or none at
   * all. This also makes two concurrent `put()`s of the SAME bytes safe: both
   * compute the same hash, both write to their own distinct temp file, and
   * whichever rename lands second simply replaces the first with byte-
   * identical content -- neither observes a torn write.
   *
   * An earlier version checked "does this path already exist?" first and
   * skipped the write entirely when it did, as a re-upload-of-identical-
   * content optimisation. Removed in task 32 fix round 2 (Important #2):
   * that check-then-trust was itself a race -- a concurrent GC pass could
   * unlink the file in the gap between the existence check reporting
   * "yes" and this function returning having done nothing, leaving a
   * brand-new attachment row pointing at nothing. Always renaming into
   * place removes the assumption entirely: even if a concurrent delete
   * removes the file a moment before this call's own `rename()`, that
   * `rename()` simply (re)creates the destination, so the blob exists once
   * `put()` returns no matter what any concurrent GC pass did. The cost is
   * a redundant write+rename on the (comparatively rare) exact-content-
   * reupload path; correctness under concurrent GC was judged worth it.
   * `withPinnedSha` (`blob-gc.ts`) still matters and is still required --
   * this only protects the WRITE from a concurrent unlink, not the
   * still-unpinned window before an attachment row exists at all, which is
   * what pinning closes.
   */
  async put(data: Buffer): Promise<StoredBlob> {
    const sha256 = sha256Of(data);
    const path = this.pathFor(sha256);

    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp-${randomBytes(6).toString('hex')}`;
    await writeFile(tmpPath, data);
    await rename(tmpPath, path);

    return { sha256, path, size: data.length };
  }

  /**
   * Reads back the bytes for a previously-`put()` sha256 hash. Tries the
   * WRITE root first; if the blob isn't there, falls back to the legacy
   * root (if one was configured) before giving up -- blobs uploaded before
   * per-database roots existed stay servable this way. Rejects with the
   * WRITE root's own error (not the legacy root's) if neither has it, so a
   * missing blob's error always describes the location that actually
   * matters going forward.
   */
  async get(sha256: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(sha256));
    } catch (err) {
      const legacyPath = this.legacyPathFor(sha256);
      if (legacyPath && isEnoentError(err)) {
        try {
          return await readFile(legacyPath);
        } catch {
          // Fall through to throw the ORIGINAL (write-root) error below --
          // it names the location new uploads actually land in, which is
          // more useful to a reader than the legacy path.
        }
      }
      throw err;
    }
  }

  /**
   * Unlinks the blob for `sha256` from the WRITE root ONLY -- the legacy
   * root is read-only from here on and this never touches it. A missing
   * file is treated as already-clean (resolves normally, no error) -- the
   * caller (attachment GC, `blob-gc.ts`) only ever calls this once it has
   * already decided the blob is garbage, and "it's already gone" is
   * success, not a failure. Any other error (permissions, a locked file,
   * ...) propagates so the caller can log it -- this method itself makes
   * no decision about whether such a failure should be swallowed.
   *
   * Refuses to unlink through a symlink/junction standing in for the shard
   * directory: `lstat`s the shard dir first (reports the link itself,
   * never follows it) and does nothing if it isn't a real directory --
   * same rule `sweepOrphanedBlobs` walks the whole tree by (Minor #6).
   *
   * `shouldStillRemove`, if given, is called synchronously immediately
   * after that `lstat` resolves and immediately BEFORE the actual
   * `unlink()` call -- no `await` in between -- and aborts (no unlink,
   * resolves normally) if it returns false. Closes Important #2 (task 32
   * fix round 2): `gcBlobIfOrphaned` decides a blob is orphaned, then this
   * method's own `lstat` await gives a same-content upload a window to pin
   * the hash, write it (or find it already written), and create its
   * attachment row -- all before the decision above ever reaches an actual
   * `unlink`. `gcBlobIfOrphaned` passes a callback that re-checks
   * `isPinned`/`isReferenced` right at that point, catching exactly that
   * window. `BlobStore` itself has no notion of "referenced" or "pinned"
   * (that's `blob-gc.ts`'s domain over `@grunt/core`'s `Store`), so this
   * takes the check as an opaque predicate instead of depending on either.
   */
  async remove(sha256: string, shouldStillRemove?: () => boolean): Promise<void> {
    const path = this.pathFor(sha256);
    try {
      const shardStat = await lstat(dirname(path)).catch(() => null);
      if (!shardStat || !shardStat.isDirectory()) return;
      if (shouldStillRemove && !shouldStillRemove()) return;
      await unlink(path);
    } catch (err) {
      if (!isEnoentError(err)) throw err;
    }
  }
}

export function createBlobStore(root: string, legacyRoot?: string): BlobStore {
  return new BlobStore(root, legacyRoot);
}
