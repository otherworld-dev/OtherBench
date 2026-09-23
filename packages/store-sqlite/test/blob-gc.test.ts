import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@grunt/core/ports/store.js';
import { gcBlobIfOrphaned, sweepOrphanedBlobs } from '../src/blob-gc.js';
import { createBlobStore, type BlobStore } from '../src/blob-store.js';

/**
 * A minimal `Store` stand-in exposing only what blob-gc.ts actually calls
 * (`store.attachments.isReferenced`), backed by a plain `Set` the test
 * controls directly -- avoids seeding a full connection/model/profile/chat/
 * attachment referential chain just to answer "does anything reference this
 * sha256?".
 */
function fakeStore(referenced: Iterable<string>): Store {
  const shas = new Set(referenced);
  return {
    attachments: {
      isReferenced: (sha256: string) => shas.has(sha256),
    },
  } as unknown as Store;
}

let dir: string;
let blobStore: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-blob-gc-test-'));
  blobStore = createBlobStore(dir);
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

  it('never throws, even when the store or disk operation misbehaves -- it logs and swallows instead', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenStore = {
      attachments: {
        isReferenced: () => {
          throw new Error('boom');
        },
      },
    } as unknown as Store;

    await expect(gcBlobIfOrphaned(brokenStore, blobStore, 'deadbeef')).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
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

  it('leaves a stray non-blob file inside a shard directory completely alone', async () => {
    const orphan = await blobStore.put(Buffer.from('garbage blob'));
    const shardDir = join(dir, 'attachments', orphan.sha256.slice(0, 2));
    const strayPath = join(shardDir, 'not-a-blob.txt');
    await writeFile(strayPath, 'this is not a content-addressed blob');

    const result = await sweepOrphanedBlobs(fakeStore([]), blobStore);

    expect(result.removed).toBe(1); // only the real orphan blob
    await expect(stat(orphan.path)).rejects.toThrow();
    await expect(stat(strayPath)).resolves.toBeTruthy();
  });

  it('leaves a stray file sitting directly under the attachments root (not inside any shard dir) alone', async () => {
    await blobStore.put(Buffer.from('anything, just to create the attachments root'));
    const strayPath = join(dir, 'attachments', 'README.txt');
    await writeFile(strayPath, 'not a shard directory');

    await sweepOrphanedBlobs(fakeStore([]), blobStore);

    await expect(stat(strayPath)).resolves.toBeTruthy();
  });

  it('never touches a well-formed-looking name sitting in the WRONG shard directory', async () => {
    // A syntactically valid 64-hex name, but filed under a shard dir that
    // doesn't match its own first two characters.
    const fakeSha = 'ab'.padEnd(64, '0');
    const wrongShardDir = join(dir, 'attachments', 'ff');
    await mkdir(wrongShardDir, { recursive: true });
    const misplaced = join(wrongShardDir, fakeSha);
    await writeFile(misplaced, 'misplaced');

    const result = await sweepOrphanedBlobs(fakeStore([]), blobStore);

    expect(result.scanned).toBe(0);
    await expect(stat(misplaced)).resolves.toBeTruthy();
  });

  it('ignores a shard-looking directory name that is not two hex characters, and any file under it', async () => {
    const notAShard = join(dir, 'attachments', 'not-hex');
    await mkdir(notAShard, { recursive: true });
    const fakeSha = '0'.repeat(64);
    await writeFile(join(notAShard, fakeSha), 'x');

    const result = await sweepOrphanedBlobs(fakeStore([]), blobStore);

    expect(result.scanned).toBe(0);
    await expect(stat(join(notAShard, fakeSha))).resolves.toBeTruthy();
  });

  it('removes a shard directory once it is left empty after sweeping', async () => {
    const orphan = await blobStore.put(Buffer.from('lone orphan in its shard'));
    const shardDir = join(dir, 'attachments', orphan.sha256.slice(0, 2));

    await sweepOrphanedBlobs(fakeStore([]), blobStore);

    await expect(stat(shardDir)).rejects.toThrow();
  });

  it('keeps a shard directory that still has a referenced blob in it after sweeping', async () => {
    const referenced = await blobStore.put(Buffer.from('keep my shard dir'));
    const shardDir = join(dir, 'attachments', referenced.sha256.slice(0, 2));

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
});
