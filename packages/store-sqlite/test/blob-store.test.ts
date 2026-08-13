import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, createBlobStore } from '../src/blob-store.js';

let dir: string;
let store: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-blob-store-test-'));
  store = createBlobStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('BlobStore.pathFor', () => {
  it('is content-addressed at <dataDir>/attachments/<first-two-hex>/<sha256>, derived purely from the hash', () => {
    const hash = 'ab'.padEnd(64, '0');
    expect(store.pathFor(hash)).toBe(join(dir, 'attachments', 'ab', hash));
  });
});

describe('BlobStore.put / get', () => {
  it('writes bytes content-addressed by their own sha256, and get() reads the same bytes back', async () => {
    const data = Buffer.from('hello world');
    const expectedHash = sha256Hex(data);

    const result = await store.put(data);

    expect(result.sha256).toBe(expectedHash);
    expect(result.size).toBe(data.length);
    expect(result.path).toBe(join(dir, 'attachments', expectedHash.slice(0, 2), expectedHash));
    await expect(stat(result.path)).resolves.toBeTruthy();

    const readBack = await store.get(expectedHash);
    expect(readBack.equals(data)).toBe(true);
  });

  it('dedupes: uploading the SAME bytes twice writes exactly one blob on disk', async () => {
    const data = Buffer.from('duplicate content');

    const first = await store.put(data);
    const second = await store.put(data);

    expect(first.sha256).toBe(second.sha256);
    expect(first.path).toBe(second.path);

    // Only one file exists under this hash's shard directory -- the second
    // put() did not create a sibling or overwrite-with-a-new-name.
    const shardDir = join(dir, 'attachments', first.sha256.slice(0, 2));
    const entries = await readdir(shardDir);
    expect(entries).toEqual([first.sha256]);
  });

  it('different content produces different hashes and independent blobs', async () => {
    const a = await store.put(Buffer.from('content A'));
    const b = await store.put(Buffer.from('content B'));

    expect(a.sha256).not.toBe(b.sha256);
    expect(a.path).not.toBe(b.path);
    expect((await store.get(a.sha256)).toString()).toBe('content A');
    expect((await store.get(b.sha256)).toString()).toBe('content B');
  });

  it('handles an empty buffer', async () => {
    const result = await store.put(Buffer.alloc(0));
    expect(result.size).toBe(0);
    const readBack = await store.get(result.sha256);
    expect(readBack.length).toBe(0);
  });

  it('never leaves a stray .tmp- file behind after a successful put()', async () => {
    const result = await store.put(Buffer.from('no leftovers'));
    const shardDir = join(dir, 'attachments', result.sha256.slice(0, 2));
    const entries = await readdir(shardDir);
    expect(entries.every((e) => !e.includes('.tmp-'))).toBe(true);
  });

  it('get() rejects for a hash that was never put()', async () => {
    await expect(store.get('0'.repeat(64))).rejects.toThrow();
  });
});
