import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@otherbench/core/ports/store.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { gcBlobIfOrphaned, isPinned, sweepOrphanedBlobs, withPinnedSha } from '../src/blob-gc.js';
import { createBlobStore, sha256Of, type BlobStore } from '../src/blob-store.js';

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
  dir = await mkdtemp(join(tmpdir(), 'otherbench-blob-gc-test-'));
  root = join(dir, 'attachments');
  blobStore = createBlobStore(root);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

  // Minor #5: one `referencedShas()` call for the whole sweep as a fast
  // pre-filter, rather than one `isReferenced` query per file on disk (a
  // full table scan with no index, run once per blob, on every chat/
  // profile/connection delete before the migration in this same round).
  //
  // `isReferenced` is NOT gone, though (Important #1, fix round 2): it's
  // now also called once per ORPHAN CANDIDATE, as a synchronous re-check
  // immediately before that blob's own unlink -- see sweepOrphanedBlobs's
  // doc for why the snapshot alone isn't enough. It is never called for a
  // blob the snapshot already says IS referenced (that's the whole point
  // of keeping the snapshot as a pre-filter: most blobs on a real sweep
  // are still in use, and skip the per-file query entirely).
  it('calls referencedShas() once per sweep, and re-checks isReferenced only for orphan candidates right before their unlink', async () => {
    const referencedBlob = await blobStore.put(Buffer.from('referenced'));
    const orphanA = await blobStore.put(Buffer.from('orphan-a'));
    const orphanB = await blobStore.put(Buffer.from('orphan-b'));
    const store = fakeStore([referencedBlob.sha256]);

    const result = await sweepOrphanedBlobs(store, blobStore);

    expect(result).toEqual({ scanned: 3, removed: 2 }); // scanned counts every well-formed blob file, referenced included
    await expect(stat(orphanA.path)).rejects.toThrow();
    await expect(stat(orphanB.path)).rejects.toThrow();
    await expect(stat(referencedBlob.path)).resolves.toBeTruthy();
    expect(store.calls.referencedShas).toBe(1);
    // Exactly one re-check per orphan candidate (orphanA, orphanB) -- NOT
    // called for referencedBlob, which the snapshot pre-filter already
    // skipped before ever reaching the re-check line.
    expect(store.calls.isReferenced).toBe(2);
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

  // ---------------------------------------------------------------------
  // Important #1 (task 32 fix round 2): the one-shot referencedShas()
  // snapshot is only a fast pre-filter now -- adapted from the reviewer's
  // rr/i3.mjs reproduction (3,000 filler blobs, a sweep of ~150-200ms, an
  // upload landing entirely inside that window). Against 22cee46 (fix
  // round 1's code), the deterministic test below fails every run: the
  // stale snapshot said unreferenced, nothing re-checked it, and the blob
  // was unlinked with its row still present.
  // ---------------------------------------------------------------------
  describe('Important #1: a row created after the sweep-start snapshot must still survive', () => {
    it('deterministic: isReferenced disagreeing with the stale referencedShas() snapshot wins -- the blob survives', async () => {
      const target = await blobStore.put(Buffer.from('created after the snapshot was taken'));
      // Simulates the row having been created in the gap between the
      // sweep's ONE referencedShas() snapshot (taken at the very start,
      // here returning an EMPTY set -- "stale", as if this blob's row
      // didn't exist yet) and the synchronous re-check immediately before
      // this blob's own unlink (here answering `true` for the same sha,
      // as if the row now exists) -- exactly the window Important #1
      // closes. A real timing-based version of this same race follows
      // below, adapted directly from the reviewer's rr/i3.mjs.
      const store: Store = {
        attachments: {
          isReferenced: (sha256: string) => sha256 === target.sha256,
          referencedShas: () => new Set<string>(),
        },
      } as unknown as Store;

      const result = await sweepOrphanedBlobs(store, blobStore);

      expect(result.removed).toBe(0);
      await expect(stat(target.path)).resolves.toBeTruthy();
    });

    it(
      'real timing (adapted from rr/i3.mjs): 3,000 filler blobs make the sweep take long enough for an upload ' +
        'landing shortly after it starts to still be mid-flight when the sweep reaches that shard',
      async () => {
        const fillerCount = 3000;
        // Write the fillers in parallel, one task per shard, so setup stays
        // fast under full-suite load; the sweep's own runtime is unchanged.
        const byShard = new Map<string, string[]>();
        for (let i = 0; i < fillerCount; i++) {
          const sha = createHash('sha256').update(`filler${i}`).digest('hex');
          const shard = sha.slice(0, 2);
          const list = byShard.get(shard) ?? [];
          list.push(sha);
          byShard.set(shard, list);
        }
        await Promise.all(
          [...byShard].map(async ([shard, shas]) => {
            const shardDir = join(root, shard);
            await mkdir(shardDir, { recursive: true });
            await Promise.all(shas.map((sha) => writeFile(join(shardDir, sha), 'x')));
          })
        );
        // A target hash landing in a LATE shard ('ff') so the sweep reaches
        // it only after working through the other (up to) 255 shards first.
        let n = 0;
        let data: Buffer;
        let sha: string;
        do {
          data = Buffer.from(`target${n++}`);
          sha = createHash('sha256').update(data).digest('hex');
        } while (!sha.startsWith('ff'));

        const referencedFillerShas = new Set<string>();
        for (let i = 0; i < fillerCount; i++) {
          referencedFillerShas.add(createHash('sha256').update(`filler${i}`).digest('hex'));
        }
        const store: Store = {
          attachments: {
            isReferenced: (s: string) => s === sha,
            referencedShas: () => referencedFillerShas, // stale: target is NOT in it, same as the real fresh-upload case
          },
        } as unknown as Store;

        const sweepPromise = sweepOrphanedBlobs(store, blobStore);
        await new Promise((r) => setTimeout(r, 20)); // the upload starts well inside the sweep's runtime
        await withPinnedSha(sha, async () => {
          await blobStore.put(data);
        });
        const result = await sweepPromise;

        expect(result.removed).toBe(0);
        await expect(stat(blobStore.pathFor(sha))).resolves.toBeTruthy();
      },
      30_000
    );
  });

  // ---------------------------------------------------------------------
  // Important #2 (task 32 fix round 2): gcBlobIfOrphaned decides an
  // attachment is orphaned, then BlobStore.remove's own `await lstat(...)`
  // gives a same-content upload a window to pin, write (or find it
  // already written), and create its row -- all before the original
  // decision ever reaches an actual unlink. Adapted directly from the
  // reviewer's rr/i3.mjs "gc-window" scenario.
  // ---------------------------------------------------------------------
  describe('Important #2: a row created while gcBlobIfOrphaned awaits BlobStore.remove\'s lstat must still survive', () => {
    it('unit: BlobStore.remove aborts when shouldStillRemove returns false, checked right before the unlink', async () => {
      const { sha256, path } = await blobStore.put(Buffer.from('must survive'));

      await blobStore.remove(sha256, () => false);

      await expect(stat(path)).resolves.toBeTruthy();
    });

    it('end-to-end (rr/i3.mjs\'s exact "gc-window" sequence, real InMemoryStore): a same-content upload landing while gc awaits lstat keeps both the row and the blob', async () => {
      const data = Buffer.from('gc-window');
      await blobStore.put(data); // orphan blob already on disk, unreferenced
      const sha = sha256Of(data);
      const store = new InMemoryStore();

      const gc = gcBlobIfOrphaned(store, blobStore, sha); // decides orphaned, then awaits BlobStore.remove's lstat
      await withPinnedSha(sha, async () => {
        const b = await blobStore.put(data); // sees the file already exists; still always writes+renames now (Important #2's put() fix)
        store.attachments.create({
          id: 'target2', chatId: 'c', messageId: null, filename: 't', mime: 't',
          size: b.size, sha256: sha, storagePath: b.path, extractedText: null,
        });
      });
      await gc;

      expect(store.attachments.get('target2')).not.toBeNull();
      await expect(stat(blobStore.pathFor(sha))).resolves.toBeTruthy();
    });
  });
});
