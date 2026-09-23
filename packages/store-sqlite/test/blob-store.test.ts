import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, createBlobStore, resolveAttachmentsRoots, sha256Of } from '../src/blob-store.js';

let dir: string;
let root: string;
let store: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-blob-store-test-'));
  root = join(dir, 'attachments');
  store = createBlobStore(root);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('sha256Of', () => {
  it('matches node:crypto\'s own sha256 hex digest', () => {
    const data = Buffer.from('pin me before put()');
    expect(sha256Of(data)).toBe(sha256Hex(data));
  });
});

describe('BlobStore.pathFor', () => {
  it('is content-addressed at <root>/<first-two-hex>/<sha256>, derived purely from the hash', () => {
    const hash = 'ab'.padEnd(64, '0');
    expect(store.pathFor(hash)).toBe(join(root, 'ab', hash));
  });
});

describe('BlobStore.root', () => {
  it('is exactly the root it was constructed with -- no implicit "attachments" subfolder appended', () => {
    expect(store.root).toBe(root);
  });
});

describe('BlobStore.remove', () => {
  it('unlinks a previously-put() blob so a subsequent get() rejects', async () => {
    const data = Buffer.from('to be removed');
    const { sha256, path } = await store.put(data);

    await store.remove(sha256);

    await expect(stat(path)).rejects.toThrow();
    await expect(store.get(sha256)).rejects.toThrow();
  });

  it('removing a blob that was never put() (missing file) resolves without throwing', async () => {
    await expect(store.remove('0'.repeat(64))).resolves.toBeUndefined();
  });

  it('removing one of two distinct blobs leaves the other intact', async () => {
    const a = await store.put(Buffer.from('keep me'));
    const b = await store.put(Buffer.from('remove me'));

    await store.remove(b.sha256);

    await expect(stat(a.path)).resolves.toBeTruthy();
    await expect(stat(b.path)).rejects.toThrow();
  });

  // Minor #6 (task 32 fix round 1): the sweep already refused to follow a
  // symlink/junction standing in for a shard directory; remove() (the
  // single-attachment GC path, `gcBlobIfOrphaned`) did not apply the same
  // check and would happily unlink() straight through one. Reproduced here
  // with a real Windows junction (no admin rights needed for a directory
  // junction), entirely inside this test's own temp dir -- never touching
  // the repo.
  it('never deletes through a junctioned shard directory -- refuses rather than following it', async () => {
    const decoyDir = join(dir, 'decoy-target');
    await mkdir(decoyDir, { recursive: true });
    const sha256 = '11'.padEnd(64, '2');
    const shard = sha256.slice(0, 2); // '11'
    const decoyFile = join(decoyDir, sha256);
    await writeFile(decoyFile, 'do not delete me');

    // root/<shard> is a JUNCTION pointing at decoyDir, not a real directory.
    await mkdir(root, { recursive: true });
    await symlink(decoyDir, join(root, shard), 'junction');

    await store.remove(sha256);

    await expect(stat(decoyFile)).resolves.toBeTruthy();
  });
});

describe('BlobStore.put / get', () => {
  it('writes bytes content-addressed by their own sha256, and get() reads the same bytes back', async () => {
    const data = Buffer.from('hello world');
    const expectedHash = sha256Hex(data);

    const result = await store.put(data);

    expect(result.sha256).toBe(expectedHash);
    expect(result.size).toBe(data.length);
    expect(result.path).toBe(join(root, expectedHash.slice(0, 2), expectedHash));
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
    const shardDir = join(root, first.sha256.slice(0, 2));
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
    const shardDir = join(root, result.sha256.slice(0, 2));
    const entries = await readdir(shardDir);
    expect(entries.every((e) => !e.includes('.tmp-'))).toBe(true);
  });

  it('get() rejects for a hash that was never put()', async () => {
    await expect(store.get('0'.repeat(64))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Legacy-root read fallback (task 32 fix round 1, Critical #2): a blob
// uploaded before per-database roots existed lives in the OLD shared
// directory. get() must still be able to serve it -- but put()/remove()
// must NEVER touch that directory.
// ---------------------------------------------------------------------------

describe('BlobStore legacy-root fallback', () => {
  it('get() falls back to the legacy root when the blob is missing from the primary root', async () => {
    const legacyRoot = join(dir, 'legacy-attachments');
    const data = Buffer.from('uploaded before per-database roots existed');
    const sha256 = sha256Hex(data);
    await mkdir(join(legacyRoot, sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(legacyRoot, sha256.slice(0, 2), sha256), data);

    const storeWithLegacy = createBlobStore(root, legacyRoot);

    const readBack = await storeWithLegacy.get(sha256);
    expect(readBack.equals(data)).toBe(true);
  });

  it('prefers the primary root over the legacy one when both have the same sha256', async () => {
    const legacyRoot = join(dir, 'legacy-attachments');
    const primaryData = Buffer.from('the real, current copy');
    const sha256 = sha256Hex(primaryData);
    await mkdir(join(legacyRoot, sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(legacyRoot, sha256.slice(0, 2), sha256), 'a stale legacy copy, must be ignored');

    const storeWithLegacy = createBlobStore(root, legacyRoot);
    await storeWithLegacy.put(primaryData);

    const readBack = await storeWithLegacy.get(sha256);
    expect(readBack.equals(primaryData)).toBe(true);
  });

  it('still 404s (rejects) when neither root has the blob', async () => {
    const legacyRoot = join(dir, 'legacy-attachments');
    const storeWithLegacy = createBlobStore(root, legacyRoot);

    await expect(storeWithLegacy.get('0'.repeat(64))).rejects.toThrow();
  });

  it('put() never writes into the legacy root', async () => {
    const legacyRoot = join(dir, 'legacy-attachments');
    const storeWithLegacy = createBlobStore(root, legacyRoot);

    const { sha256 } = await storeWithLegacy.put(Buffer.from('new upload'));

    await expect(stat(join(legacyRoot, sha256.slice(0, 2), sha256))).rejects.toThrow();
    await expect(stat(join(root, sha256.slice(0, 2), sha256))).resolves.toBeTruthy();
  });

  it('remove() never touches the legacy root, even when the same sha256 lives there too', async () => {
    const legacyRoot = join(dir, 'legacy-attachments');
    const data = Buffer.from('shared sha in both roots');
    const sha256 = sha256Hex(data);
    await mkdir(join(legacyRoot, sha256.slice(0, 2)), { recursive: true });
    const legacyPath = join(legacyRoot, sha256.slice(0, 2), sha256);
    await writeFile(legacyPath, data);

    const storeWithLegacy = createBlobStore(root, legacyRoot);
    await storeWithLegacy.put(data);

    await storeWithLegacy.remove(sha256);

    await expect(stat(legacyPath)).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// resolveAttachmentsRoots (task 32 fix round 1, Critical #2): derives a
// database's blob root from the DATABASE PATH itself, never from
// secretsPath, and never shared with another database.
// ---------------------------------------------------------------------------

describe('resolveAttachmentsRoots', () => {
  // `:memory:` calls create a REAL temp directory on disk (mkdtempSync) --
  // tracked and removed here so this suite doesn't itself leave orphans
  // under %TEMP%/$TMPDIR (task 32 fix round 2, Minor #2: this is exactly
  // how the reported 28 stray `grunt-attachments-*` directories accumulated
  // in the first place).
  const createdTempRoots: string[] = [];
  function trackMemoryRoots(roots: { writeRoot: string; isTemporary: boolean }): typeof roots {
    if (roots.isTemporary) createdTempRoots.push(roots.writeRoot);
    return roots;
  }

  afterEach(async () => {
    await Promise.all(createdTempRoots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
  });

  it('derives <dir>/<full-basename>.attachments/ for a file database, from the database\'s ENTIRE basename (extension included)', () => {
    const dbPath = join(dir, 'grunt.db');
    const secretsPath = join(dir, 'secrets.json');

    const roots = resolveAttachmentsRoots(dbPath, secretsPath);

    expect(roots.writeRoot).toBe(join(dir, 'grunt.db.attachments'));
    expect(roots.isTemporary).toBe(false);
  });

  it('gives two different database files in the SAME directory two DIFFERENT write roots', () => {
    const secretsPath = join(dir, 'secrets.json');

    const main = resolveAttachmentsRoots(join(dir, 'main.db'), secretsPath);
    const scratch = resolveAttachmentsRoots(join(dir, 'scratch.db'), secretsPath);

    expect(main.writeRoot).not.toBe(scratch.writeRoot);
    expect(main.writeRoot).toBe(join(dir, 'main.db.attachments'));
    expect(scratch.writeRoot).toBe(join(dir, 'scratch.db.attachments'));
  });

  // Task 32 fix round 2, Critical #1: an earlier version stripped the
  // extension before appending ".attachments", so `main.db` and
  // `main.bak` (or `grunt` and `grunt.db`) collided on the exact same
  // `<stem>.attachments/` -- reproduced live: two such databases opened
  // side by side, each one's sweep deleted the other's blobs. The full
  // basename never collides between two distinct filenames, because the
  // filenames themselves don't.
  it('gives two databases with the SAME STEM but different extensions (or no extension at all) two DIFFERENT write roots', () => {
    const secretsPath = join(dir, 'secrets.json');

    const withBak = resolveAttachmentsRoots(join(dir, 'main.bak'), secretsPath);
    const withDb = resolveAttachmentsRoots(join(dir, 'main.db'), secretsPath);
    const noExt = resolveAttachmentsRoots(join(dir, 'grunt'), secretsPath);
    const withExt = resolveAttachmentsRoots(join(dir, 'grunt.db'), secretsPath);

    expect(withBak.writeRoot).not.toBe(withDb.writeRoot);
    expect(noExt.writeRoot).not.toBe(withExt.writeRoot);
    expect(withBak.writeRoot).toBe(join(dir, 'main.bak.attachments'));
    expect(withDb.writeRoot).toBe(join(dir, 'main.db.attachments'));
    expect(noExt.writeRoot).toBe(join(dir, 'grunt.attachments'));
    expect(withExt.writeRoot).toBe(join(dir, 'grunt.db.attachments'));
  });

  // Minor #5: a database literally named `foo.attachments` used to get a
  // write root equal to its own path (`<stem>.attachments` where stem is
  // `foo` -- i.e. `foo.attachments`, colliding with the database file
  // itself) and 500 every upload. The full-basename fix makes this
  // `foo.attachments.attachments` instead -- still distinct.
  it('a database literally named "foo.attachments" gets a write root distinct from its own path', () => {
    const secretsPath = join(dir, 'secrets.json');
    const dbPath = join(dir, 'foo.attachments');

    const roots = resolveAttachmentsRoots(dbPath, secretsPath);

    expect(roots.writeRoot).not.toBe(dbPath);
    expect(roots.writeRoot).toBe(join(dir, 'foo.attachments.attachments'));
  });

  it('a database literally named "foo.attachments" can actually put()/get() a blob through its derived BlobStore', async () => {
    const secretsPath = join(dir, 'secrets.json');
    const dbPath = join(dir, 'foo.attachments');
    const roots = resolveAttachmentsRoots(dbPath, secretsPath);
    const storeForFoo = createBlobStore(roots.writeRoot, roots.legacyRoot);

    const data = Buffer.from('upload into a db literally named foo.attachments');
    const { sha256 } = await storeForFoo.put(data);
    const readBack = await storeForFoo.get(sha256);

    expect(readBack.equals(data)).toBe(true);
  });

  it('legacyRoot is always <dirname(secretsPath)>/attachments -- the old shared location -- regardless of the database path', () => {
    const secretsPath = join(dir, 'secrets.json');

    const roots = resolveAttachmentsRoots(join(dir, 'anything.db'), secretsPath);

    expect(roots.legacyRoot).toBe(join(dir, 'attachments'));
  });

  it(':memory: gets a fresh, unique temp directory every call, and is marked temporary', () => {
    const secretsPath = join(dir, 'secrets.json');

    const a = trackMemoryRoots(resolveAttachmentsRoots(':memory:', secretsPath));
    const b = trackMemoryRoots(resolveAttachmentsRoots(':memory:', secretsPath));

    expect(a.isTemporary).toBe(true);
    expect(b.isTemporary).toBe(true);
    expect(a.writeRoot).not.toBe(b.writeRoot);
  });

  it(':memory: still resolves legacyRoot from secretsPath, so pre-fix blobs stay readable', () => {
    const secretsPath = join(dir, 'secrets.json');

    const roots = trackMemoryRoots(resolveAttachmentsRoots(':memory:', secretsPath));

    expect(roots.legacyRoot).toBe(join(dir, 'attachments'));
  });

  it('handles a database file with no extension', () => {
    const secretsPath = join(dir, 'secrets.json');

    const roots = resolveAttachmentsRoots(join(dir, 'grunt'), secretsPath);

    expect(roots.writeRoot).toBe(join(dir, 'grunt.attachments'));
  });
});
