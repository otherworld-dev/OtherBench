import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runServe } from '../src/cli.js';
import { createApp } from '../src/app.js';
import { createContainer, type Container } from '../src/container.js';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Task 32 fix round 1, Critical #2: the pre-fix scheme derived ONE shared
 * attachments directory (`dirname(secretsPath)/attachments`) that every
 * database opened in the same place -- including the default `:memory:`
 * config, which resolves to `~/.grunt/secrets.json` same as the default
 * file database -- wrote to and swept. Reproduced live: (a) two file
 * databases in the same directory, one's startup/cascade sweep deleting
 * the other's still-referenced blobs; (b) `grunt serve --db :memory:`
 * deleting every attachment under the real default `~/.grunt/attachments`.
 * This file proves the fix: per-database write roots, a read-only legacy
 * fallback, and `:memory:` never touching the real home directory.
 */

function uploadForm(filename: string, content: string, mime: string): FormData {
  const form = new FormData();
  form.append('file', new File([content], filename, { type: mime }));
  return form;
}

async function seedProfile(container: Container, id: string): Promise<{ profileId: string }> {
  const connectionId = `${id}::conn`;
  const modelId = `${id}::model`;
  const profileId = `${id}::profile`;
  container.store.connections.create({
    id: connectionId, name: 'Test Connection', kind: 'mock', baseUrl: null, secretRef: null,
    extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null,
  });
  container.store.models.create({
    id: modelId, connectionId, modelId: 'mock-standard', displayName: 'Mock', source: 'manual',
    supportsVision: false, supportsTools: false, supportsReasoning: false, contextWindow: null,
    maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  container.store.profiles.create({
    id: profileId, name: 'Test Profile', description: null, colour: null, connectionId, modelId,
    systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false, archivedAt: null,
  });
  return { profileId };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-attachment-roots-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('two databases in the same directory never share or clobber each other\'s blobs', () => {
  it('uploading/deleting/sweeping in ONE database never removes the OTHER\'s blob, even sharing one secrets.json', async () => {
    // Mirrors how cli.ts actually derives secretsPath in practice: every
    // database in the same directory defaults to the SAME secrets.json
    // next to it. That's exactly the setup the old shared-root scheme got
    // wrong -- this must now be safe.
    const secretsPath = join(dir, 'secrets.json');

    const containerA = await createContainer({ dbPath: join(dir, 'main.db'), secretsPath });
    const containerB = await createContainer({ dbPath: join(dir, 'scratch.db'), secretsPath });
    try {
      const { profileId: profileA } = await seedProfile(containerA, 'a');
      const { profileId: profileB } = await seedProfile(containerB, 'b');
      containerA.store.chats.create({ id: 'chat-a', title: 'A', profileId: profileA, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
      containerB.store.chats.create({ id: 'chat-b', title: 'B', profileId: profileB, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });

      const uploadA = await (
        await createApp(containerA).request('/api/chats/chat-a/attachments', { method: 'POST', body: uploadForm('a.txt', 'database A content', 'text/plain') })
      ).json();
      const uploadB = await (
        await createApp(containerB).request('/api/chats/chat-b/attachments', { method: 'POST', body: uploadForm('b.txt', 'database B content', 'text/plain') })
      ).json();

      // Different per-database write roots entirely.
      expect(containerA.blobStore.root).not.toBe(containerB.blobStore.root);
      expect(containerA.blobStore.root).toBe(join(dir, 'main.db.attachments'));
      expect(containerB.blobStore.root).toBe(join(dir, 'scratch.db.attachments'));

      // Deleting chat-a (cascades A's attachment row, sweeps A's root) must
      // not touch B's blob at all.
      const delA = await createApp(containerA).request('/api/chats/chat-a', { method: 'DELETE' });
      expect(delA.status).toBe(204);

      const bBlobPath = join(containerB.blobStore.root, uploadB.sha256.slice(0, 2), uploadB.sha256);
      await expect(stat(bBlobPath)).resolves.toBeTruthy();

      // And the other direction.
      const delB = await createApp(containerB).request('/api/chats/chat-b', { method: 'DELETE' });
      expect(delB.status).toBe(204);

      // A's blob was already gone (real GC did its job); B's row/blob are
      // now gone too, but neither ever affected the other's root.
      const aBlobPath = join(containerA.blobStore.root, uploadA.sha256.slice(0, 2), uploadA.sha256);
      await expect(stat(aBlobPath)).rejects.toThrow();
      await expect(stat(bBlobPath)).rejects.toThrow();
    } finally {
      containerA.close();
      containerB.close();
    }
  });

  it('restarting database A (startup sweep) never deletes database B\'s still-referenced blob sitting in the same parent directory', async () => {
    const secretsPath = join(dir, 'secrets.json');
    const dbPathA = join(dir, 'main.db');
    const dbPathB = join(dir, 'scratch.db');

    const containerB = await createContainer({ dbPath: dbPathB, secretsPath });
    const { profileId: profileB } = await seedProfile(containerB, 'b');
    containerB.store.chats.create({ id: 'chat-b', title: 'B', profileId: profileB, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const uploadB = await (
      await createApp(containerB).request('/api/chats/chat-b/attachments', { method: 'POST', body: uploadForm('b.txt', 'B content, must survive A restarting', 'text/plain') })
    ).json();
    const bBlobPath = join(containerB.blobStore.root, uploadB.sha256.slice(0, 2), uploadB.sha256);
    await expect(stat(bBlobPath)).resolves.toBeTruthy();
    containerB.close();

    // Database A starts up (and its own startup sweep runs) with NO
    // knowledge of database B's attachment table at all.
    const containerA = await createContainer({ dbPath: dbPathA, secretsPath });
    try {
      await expect(stat(bBlobPath)).resolves.toBeTruthy();
    } finally {
      containerA.close();
    }
  });

  /**
   * Task 32 fix round 2, Critical #1: an earlier version of
   * `resolveAttachmentsRoots` stripped the extension before appending
   * ".attachments", so two databases sharing a STEM -- `main.db`/
   * `main.bak`, or `grunt`/`grunt.db` -- collided on the exact same
   * `<stem>.attachments/` root. Reproduced live (the reviewer's rr/c2.mjs,
   * adapted here): two such servers side by side, a chat delete (and a
   * restart) in one made the other's attachment 404. Fails against
   * 22cee46 for BOTH pairs below; the "distinct-stem" test above alone
   * would never have caught this, since `main.db`/`scratch.db` never
   * shared a stem in the first place.
   */
  describe.each([
    ['main.db', 'main.bak', 'same stem, different extension'],
    ['grunt', 'grunt.db', 'same stem, one with no extension at all'],
  ])('same-stem collision: %s vs %s (%s)', (nameA, nameB) => {
    it('a chat delete (sweep) and a restart in one database never 404s the other\'s attachment', async () => {
      const secretsPath = join(dir, 'secrets.json');
      let A = await createContainer({ dbPath: join(dir, nameA), secretsPath });
      let B = await createContainer({ dbPath: join(dir, nameB), secretsPath });
      try {
        const { profileId: profileA } = await seedProfile(A, 'a');
        const { profileId: profileB } = await seedProfile(B, 'b');
        A.store.chats.create({ id: 'chat-a', title: 'A', profileId: profileA, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
        B.store.chats.create({ id: 'chat-b', title: 'B', profileId: profileB, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });

        const uploadA = await (
          await createApp(A).request('/api/chats/chat-a/attachments', { method: 'POST', body: uploadForm('a.txt', `A-content-${nameA}`, 'text/plain') })
        ).json();
        const uploadB = await (
          await createApp(B).request('/api/chats/chat-b/attachments', { method: 'POST', body: uploadForm('b.txt', `B-content-${nameB}`, 'text/plain') })
        ).json();

        expect(A.blobStore.root).not.toBe(B.blobStore.root);

        // An extra chat in A, deleted -- triggers A's own cascade sweep.
        A.store.chats.create({ id: 'chat-a2', title: 'A2', profileId: profileA, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
        await createApp(A).request('/api/chats/chat-a2/attachments', { method: 'POST', body: uploadForm('x.txt', `A-throwaway-${nameA}`, 'text/plain') });
        const del = await createApp(A).request('/api/chats/chat-a2', { method: 'DELETE' });
        expect(del.status).toBe(204);

        A.close();
        A = await createContainer({ dbPath: join(dir, nameA), secretsPath }); // A's own startup sweep

        const bAfterASweep = await createApp(B).request(`/api/attachments/${uploadB.id}/content`);
        const aOwn = await createApp(A).request(`/api/attachments/${uploadA.id}/content`);
        expect(bAfterASweep.status).toBe(200);
        expect(aOwn.status).toBe(200);

        B.close();
        B = await createContainer({ dbPath: join(dir, nameB), secretsPath });
        const aAfterBRestart = await createApp(A).request(`/api/attachments/${uploadA.id}/content`);
        expect(aAfterBRestart.status).toBe(200);
      } finally {
        A.close();
        B.close();
      }
    });
  });
});

describe('a legacy-root blob is still served', () => {
  it('GET /attachments/:id/content serves a blob that only exists in the pre-fix shared "attachments" directory next to secretsPath', async () => {
    const secretsPath = join(dir, 'secrets.json');
    const dbPath = join(dir, 'grunt.db');
    const legacyRoot = join(dir, 'attachments'); // dirname(secretsPath)/attachments -- the OLD shared location
    const content = 'uploaded before per-database roots existed';
    const sha256 = sha256Hex(content);
    await mkdir(join(legacyRoot, sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(legacyRoot, sha256.slice(0, 2), sha256), content);

    const container = await createContainer({ dbPath, secretsPath });
    try {
      const { profileId } = await seedProfile(container, 'legacy');
      container.store.chats.create({ id: 'chat-legacy', title: 'Legacy', profileId, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
      // A row referencing the legacy blob's sha256, as if it were uploaded
      // before this fix (storagePath here is illustrative only -- the
      // server never serves via storagePath, only via BlobStore.get).
      container.store.attachments.create({
        id: 'att-legacy', chatId: 'chat-legacy', messageId: null, filename: 'old-upload.txt', mime: 'text/plain',
        size: content.length, sha256, storagePath: join(legacyRoot, sha256.slice(0, 2), sha256), extractedText: null,
      });

      const res = await createApp(container).request('/api/attachments/att-legacy/content');

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(content);
    } finally {
      container.close();
    }
  });

  it('the startup sweep never removes a legacy-root blob, even one no row references any more', async () => {
    const secretsPath = join(dir, 'secrets.json');
    const dbPath = join(dir, 'grunt.db');
    const legacyRoot = join(dir, 'attachments');
    const content = 'orphaned in the legacy root -- must be left alone regardless';
    const sha256 = sha256Hex(content);
    const legacyBlobPath = join(legacyRoot, sha256.slice(0, 2), sha256);
    await mkdir(join(legacyRoot, sha256.slice(0, 2)), { recursive: true });
    await writeFile(legacyBlobPath, content);

    const container = await createContainer({ dbPath, secretsPath });
    try {
      await expect(stat(legacyBlobPath)).resolves.toBeTruthy();
    } finally {
      container.close();
    }
  });
});

describe(':memory: never touches the real default ~/.grunt directory', () => {
  let fakeHome: string;
  let savedUserProfile: string | undefined;
  let savedHome: string | undefined;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'grunt-fake-home-'));
    savedUserProfile = process.env['USERPROFILE'];
    savedHome = process.env['HOME'];
    // node:os homedir() reads USERPROFILE on win32, HOME elsewhere -- both
    // set so this is safe regardless of which platform CI runs this on.
    process.env['USERPROFILE'] = fakeHome;
    process.env['HOME'] = fakeHome;
  });

  afterEach(async () => {
    if (savedUserProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = savedUserProfile;
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('grunt serve --db :memory: (through the real CLI wiring) never writes to or deletes from ~/.grunt/attachments', async () => {
    // Pre-seeds the FAKE "real default database"'s own legitimate blob,
    // exactly where the pre-fix shared scheme would have put it --
    // dirname(defaultSecretsPath(':memory:'))/attachments ==
    // <fakeHome>/.grunt/attachments. This simulates a machine that already
    // has a real ~/.grunt/grunt.db with real attachments on it.
    const realDefaultAttachments = join(fakeHome, '.grunt', 'attachments');
    const importantContent = 'a REAL user\'s REAL attachment on their REAL default database';
    const sha256 = sha256Hex(importantContent);
    const importantBlobPath = join(realDefaultAttachments, sha256.slice(0, 2), sha256);
    await mkdir(join(realDefaultAttachments, sha256.slice(0, 2)), { recursive: true });
    await writeFile(importantBlobPath, importantContent);

    // `serve` itself is faked (this test must never actually bind a real
    // network port); `createContainer`/`createApp` are the REAL
    // implementations, so the real default-path derivation actually runs.
    const fakeServerHandle = { close: vi.fn() };
    const handle = await runServe(['--db', ':memory:', '--port', '45699'], {
      serve: vi.fn(() => fakeServerHandle as never),
    });
    handle.close();

    // The pre-existing "real user" blob must be completely untouched.
    await expect(stat(importantBlobPath)).resolves.toBeTruthy();
  });
});
