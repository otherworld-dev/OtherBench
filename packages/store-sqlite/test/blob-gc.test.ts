import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@grunt/core/ports/store.js';
import { gcBlobIfOrphaned, isPinned, sweepOrphanedBlobs, withPinnedSha } from '../src/blob-gc.js';
import { createBlobStore, type BlobStore } from '../src/blob-store.js';

/**
 * A minimal `Store` stand-in exposing only what blob-gc.ts actually calls
 * (`isReferenced`/`referencedShas`), backed by a plain `Set` the test
 * controls directly -- avoids seeding a full connection/model/profile/chat/
 * attachment referential chain just to answer "does anything reference this
 * sha256?". Counts calls to each so a test can assert the sweep uses
 * `referencedShas()` ONCE per sweep rather than `isReferenced` per file
 * (Minor #5, task 32 fix round 1).
 */
function fakeStore(referenced: Iterable<string>): Store & { calls: { isReferenced: number; referencedShas: number } } {
  const shas = new Set(referenced);
  const calls = { isReferenced: 0, referencedShas: 0 };
  return {
    calls,
    attachments: {
      isReferenced: (sha256: string) => {
        calls.isReferenced++;
        return shas.has(sha256);
      },
      referencedShas: () => {
        calls.referencedShas++;
        return new Set(shas);
      },
    },
  } as unknown as Store & { calls: { isReferenced: number; referencedShas: number } };
}

let dir: string;
let root: string;
let blobStore: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-blob-gc-test-'));
  root = join(dir, 'attachments');
  blobStore = createBlobStore(root);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gcBlobIfOrphaned', () => {
  it('removes the blob when no attachment row references its sha256', async () => {
    const { sha256, path } = await blobStore.put(Buffer.from('orphaned'));

    await gcBlobIfOrphaned(fakeStore([]), blobStore, sha256);

    await expect(stat(path)).rejects.toThrow();
  });

  it('keeps the blob when an attachment row still references its sha256', async () => {
    const { sha256, path } = await blobStore.put(Buffer.from('still referenced'));

    await gcBlobIfOrphaned(fakeStore([sha256]), blobStore, sha256);

    await expect(stat(path)).resolves.toBeTruthy();
  });

  // Minor #8 (task 32 fix round 1): this used to swallow EVERY error,
  // including a bare TypeError/Error from a mis-wired store or blobStore --
  // which is exactly what let a route test's `blobStore: {}` silently turn
  // GC into a permanent no-op instead of failing anything. Only a real
  // filesystem error (an errno `.code`) is safe to log and swallow now.
  it('propagates (does NOT swallow) a non-filesystem error from a mis-wired store', async () => {
    const brokenStore = {
      attachments: {
        isReferenced: () => {
          throw new Error('boom -- not a filesystem error');
        },
      },
    } as unknown as Store;

    await expect(gcBlobIfOrphaned(brokenStore, blobStore, 'deadbeef')).rejects.toThrow('boom');
  });

  it('still logs and swallows a genuine filesystem error from blobStore.remove', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const eaccesError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const brokenBlobStore = {
      remove: () => {
        throw eaccesError;
      },
    } as unknown as BlobStore;

    await expect(gcBlobIfOrphaned(fakeStore([]), brokenBlobStore, 'deadbeef')).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('skips a pinned sha256 even though nothing references it', async () => {
    const { sha256, path } = await blobStore.put(Buffer.from('pinned, upload still in flight'));

    let gcRanWhilePinned = false;
    await withPinnedSha(sha256, async () => {
      await gcBlobIfOrphaned(fakeStore([]), blobStore, sha256);
      gcRanWhilePinned = true;
      await expect(stat(path)).resolves.toBeTruthy();
    });

    expect(gcRanWhilePinned).toBe(true);
    // Once unpinned (and still unreferenced), a later GC pass removes it.
    await gcBlobIfOrphaned(fakeStore([]), blobStore, sha256);
    await expect(stat(path)).rejects.toThrow();
  });
});

describe('sweepOrphanedBlobs', () => {
  it('resolves with zero scanned/removed when the attachments directory does not exist yet', async () => {
    const result = await sweepOrphanedBlobs(fakeStore([]), blobStore);
    expect(result).toEqual({ scanned: 0, removed: 0 });
  });

  it('removes a pre-existing orphan blob and leaves a referenced one alone', async () => {
    const orphan = await blobStore.put(Buffer.from('nobody references me'));
    const referenced = await blobStore.put(Buffer.from('someone references me'));

    const result = await sweepOrphanedBlobs(fakeStore([referenced.sha256]), blobStore);

    expect(result).toEqual({ scanned: 2, removed: 1 });
    await expect(stat(orphan.path)).rejects.toThrow();
    await expect(stat(referenced.path)).resolves.toBeTruthy();
  });

  // Minor #5: one `referencedShas()` call for the whole sweep, never
  // `isReferenced` per file -- the old per-file query was a full table scan
  // (no index existed on `attachment.sha256`) run once per blob on disk, on
  // every chat/profile/connection delete.
  it('calls referencedShas() exactly once per sweep, and never calls isReferenced at all', async () => {
    await blobStore.put(Buffer.from('one'));
    await blobStore.put(Buffer.from('two'));
    await blobStore.put(Buffer.from('three'));
    const store = fakeStore([]);

    await sweepOrphanedBlobs(store, blobStore);

    expect(store.calls.referencedShas).toBe(1);
    expect(store.calls.isReferenced).toBe(0);
  });

  it('propagates (does NOT swallow) a non-filesystem error, e.g. from a mis-wired blobStore.root getter', async () => {
    const brokenBlobStore = {
      get root(): string {
        throw new TypeError('Cannot read properties of undefined');
      },
    } as unknown as BlobStore;

    await expect(sweepOrphanedBlobs(fakeStore([]), brokenBlobStore)).rejects.toThrow(TypeError);
  });

  // The EXACT real-world shape this bug took: a mis-wired container passing
  // `blobStore: {}` makes `blobStore.root` evaluate to `undefined` (a plain
  // property read off an empty object throws nothing), and
  // `readdir(undefined)` rejects with `{ name: 'TypeError', code:
  // 'ERR_INVALID_ARG_TYPE' }` -- confirmed empirically, not assumed. This
  // error DOES have a string `.code`, so a naive "any `.code` means
  // filesystem error" check swallows it right back into a silent no-op.
  it('propagates a readdir(undefined)-shaped ERR_INVALID_ARG_TYPE, not just a bare TypeError with no code', async () => {
    const brokenBlobStore = {} as unknown as BlobStore;

    await expect(sweepOrphanedBlobs(fakeStore([]), brokenBlobStore)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARG_TYPE',
    });
  });

  it('leaves a stray non-blob file inside a shard directory completely alone', async () => {
    const orphan = await blobStore.put(Buffer.from('garbage blob'));
    const shardDir = join(root, orphan.sha256.slice(0, 2));
    const strayPath = join(shardDir, 'not-a-blob.txt');
    await writeFile(strayPath, 'this is not a content-addressed blob');

    const result = await sweepOrphanedBlobs(fakeStore([]), blobStore);

    expect(result.removed).toBe(1); // only the real orphan blob
    await expect(stat(orphan.path)).rejects.toThrow();
    await expect(stat(strayPath)).resolves.toBeTruthy();
  });

  it('leaves a stray file sitting directly under the attachments root (not inside any shard dir) alone', async () => {
    await blobStore.put(Buffer.from('anything, just to create the attachments root'));
    const strayPath = join(root, 'README.txt');
    await writeFile(strayPath, 'not a shard directory');

    await sweepOrphanedBlobs(fakeStore([]), blobStore);

    await expect(stat(strayPath)).resolves.toBeTruthy();
  });

  it('never touches a well-formed-looking name sitting in the WRONG shard directory', async () => {
    // A syntactically valid 64-hex name, but filed under a shard dir that
    // doesn't match its own first two characters.
    const fakeSha = 'ab'.padEnd(64, '0');
    const wrongShardDir = join(root, 'ff');
    await mkdir(wrongShardDir, { recursive: true });
    const misplaced = join(wrongShardDir, fakeSha);
    await writeFile(misplaced, 'misplaced');

    const result = await sweepOrphanedBlobs(fakeStore([]), blobStore);

    expect(result.scanned).toBe(0);
    await expect(stat(misplaced)).resolves.toBeTruthy();
  });

  it('ignores a shard-looking directory name that is not two hex characters, and any file under it', async () => {
    const notAShard = join(root, 'not-hex');
    await mkdir(notAShard, { recursive: true });
    const fakeSha = '0'.repeat(64);
    await writeFile(join(notAShard, fakeSha), 'x');

    const result = await sweepOrphanedBlobs(fakeStore([]), blobStore);

    expect(result.scanned).toBe(0);
    await expect(stat(join(notAShard, fakeSha))).resolves.toBeTruthy();
  });

  // Minor #7 (task 32 fix round 1): removing an emptied shard directory used
  // to race BlobStore.put()'s own mkdir for a brand-new shard (the sweep
  // could rmdir a shard dir the instant after put() created it but before
  // its rename() landed, 500-ing the upload). Simplest fix: stop trying --
  // an empty shard dir is harmless to leave behind.
  it('leaves an emptied shard directory in place rather than removing it', async () => {
    const orphan = await blobStore.put(Buffer.from('lone orphan in its shard'));
    const shardDir = join(root, orphan.sha256.slice(0, 2));

    await sweepOrphanedBlobs(fakeStore([]), blobStore);

    await expect(stat(orphan.path)).rejects.toThrow(); // the blob itself is gone
    const entries = await readdir(shardDir); // but the directory survives, empty
    expect(entries).toEqual([]);
  });

  it('keeps a shard directory that still has a referenced blob in it after sweeping', async () => {
    const referenced = await blobStore.put(Buffer.from('keep my shard dir'));
    const shardDir = join(root, referenced.sha256.slice(0, 2));

    await sweepOrphanedBlobs(fakeStore([referenced.sha256]), blobStore);

    const entries = await readdir(shardDir);
    expect(entries).toEqual([referenced.sha256]);
  });

  it('scans and removes across several shards independently', async () => {
    const blobs = await Promise.all(
      ['alpha', 'bravo', 'charlie', 'delta'].map((s) => blobStore.put(Buffer.from(s)))
    );
    // Keep only the first referenced; the rest become orphans.
    const result = await sweepOrphanedBlobs(fakeStore([blobs[0]!.sha256]), blobStore);

    expect(result).toEqual({ scanned: 4, removed: 3 });
    await expect(stat(blobs[0]!.path)).resolves.toBeTruthy();
    for (const b of blobs.slice(1)) {
      await expect(stat(b.path)).rejects.toThrow();
    }
  });

  // Important #3 (task 32 fix round 1): closes the upload-vs-GC race --
  // an in-process pin held from before BlobStore.put() until after the
  // attachment row is created must make BOTH GC paths skip that sha256,
  // even though (at that instant) nothing yet references it.
  it('skips a pinned sha256 entirely -- not counted as scanned, not removed', async () => {
    const { sha256, path } = await blobStore.put(Buffer.from('mid-upload, no row yet'));

    let scannedWhilePinned: number | undefined;
    await withPinnedSha(sha256, async () => {
      const result = await sweepOrphanedBlobs(fakeStore([]), blobStore); // deliberately unreferenced
      scannedWhilePinned = result.scanned;
    });

    expect(scannedWhilePinned).toBe(0);
    await expect(stat(path)).resolves.toBeTruthy();
  });

  it('deterministic race: a sweep that runs WHILE the upload is still pinned never removes it; the SAME sweep after unpinning does', async () => {
    const blob = await blobStore.put(Buffer.from('deterministic race content'));

    let sweepResultWhilePinned: { scanned: number; removed: number } | undefined;
    await withPinnedSha(blob.sha256, async () => {
      expect(isPinned(blob.sha256)).toBe(true);
      // Deterministic, not timing-dependent: the sweep runs synchronously
      // within this callback, so it is GUARANTEED to observe the pin --
      // no sleep, no setTimeout, no real concurrency needed to prove it.
      sweepResultWhilePinned = await sweepOrphanedBlobs(fakeStore([]), blobStore);
    });

    expect(sweepResultWhilePinned).toEqual({ scanned: 0, removed: 0 });
    expect(isPinned(blob.sha256)).toBe(false); // unpinned once the callback returned
    await expect(stat(blob.path)).resolves.toBeTruthy();

    // Now that it's unpinned and still unreferenced, the exact same sweep removes it.
    const finalSweep = await sweepOrphanedBlobs(fakeStore([]), blobStore);
    expect(finalSweep.removed).toBe(1);
    await expect(stat(blob.path)).rejects.toThrow();
  });

  // Minor #7: stale *.tmp-* debris from a crash mid-put() is reclaimed;
  // a fresh one (a write genuinely in progress) is left alone.
  describe('stale temp-file reclamation', () => {
    it('removes a *.tmp-* file older than the safe age, inside a real shard dir', async () => {
      const shard = 'ab';
      const shardDir = join(root, shard);
      await mkdir(shardDir, { recursive: true });
      const staleTmp = join(shardDir, `${shard.padEnd(64, '0')}.tmp-deadbeef1234`);
      await writeFile(staleTmp, 'leftover from a crash');
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
      await utimes(staleTmp, oldTime, oldTime);

      await sweepOrphanedBlobs(fakeStore([]), blobStore);

      await expect(stat(staleTmp)).rejects.toThrow();
    });

    it('leaves a fresh *.tmp-* file alone -- may be a write genuinely in progress', async () => {
      const shard = 'ab';
      const shardDir = join(root, shard);
      await mkdir(shardDir, { recursive: true });
      const freshTmp = join(shardDir, `${shard.padEnd(64, '0')}.tmp-deadbeef1234`);
      await writeFile(freshTmp, 'a write in progress right now');

      await sweepOrphanedBlobs(fakeStore([]), blobStore);

      await expect(stat(freshTmp)).resolves.toBeTruthy();
    });
  });
});
