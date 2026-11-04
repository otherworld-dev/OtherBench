import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { Attachment } from '@otherbench/core/ports/store.js';
import { encodeHlc } from '@otherbench/core/domain/hlc.js';
import { ABANDONED_ATTACHMENT_GRACE_MS, sweepAbandonedAttachments, withPinnedSha } from '../src/blob-gc.js';
import { createBlobStore, type BlobStore } from '../src/blob-store.js';
import { SqliteStore } from '../src/store.js';
import { freshDb, seedChatChain } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

let dir: string;
let blobStore: BlobStore;
let db: DatabaseSync;
let store: SqliteStore;
/** What the store's clock reads: every row stamp is written at this time. */
const clock = { now: T0 };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otherbench-abandoned-test-'));
  blobStore = createBlobStore(join(dir, 'attachments'));
  clock.now = T0;
  db = freshDb();
  seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat-a' });
  store = new SqliteStore(db, { now: () => clock.now });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Puts `content` in the blob store and creates an attachment row for it at the clock's current time. */
async function upload(id: string, content: string, over: Partial<Attachment> = {}): Promise<Attachment & { path: string }> {
  const { sha256, path } = await blobStore.put(Buffer.from(content));
  const row = store.attachments.create({
    id,
    chatId: 'chat-a',
    messageId: null,
    filename: `${id}.txt`,
    mime: 'text/plain',
    size: content.length,
    sha256,
    storagePath: path,
    extractedText: null,
    ...over,
  });
  return { ...row, path };
}

describe('ABANDONED_ATTACHMENT_GRACE_MS', () => {
  it('is 30 days', () => {
    expect(ABANDONED_ATTACHMENT_GRACE_MS).toBe(30 * DAY);
  });
});

describe('sweepAbandonedAttachments', () => {
  it('deletes an unsent attachment older than the grace period, and its blob', async () => {
    const old = await upload('old', 'left behind');

    const result = await sweepAbandonedAttachments(store, blobStore, { now: T0 + ABANDONED_ATTACHMENT_GRACE_MS + 1 });

    expect(result).toEqual({ removed: 1 });
    expect(store.attachments.get('old')).toBeNull();
    await expect(stat(old.path)).rejects.toThrow();
  });

  it('keeps an unsent attachment still inside the grace period, and its blob', async () => {
    const young = await upload('young', 'still being drafted');

    const result = await sweepAbandonedAttachments(store, blobStore, { now: T0 + ABANDONED_ATTACHMENT_GRACE_MS });

    expect(result).toEqual({ removed: 0 });
    expect(store.attachments.get('young')).not.toBeNull();
    await expect(stat(young.path)).resolves.toBeTruthy();
  });

  it('never deletes a sent attachment, however old', async () => {
    db.exec(`INSERT INTO message (id, chat_id, parent_id, role, parts, status, created_at) VALUES ('msg-1', 'chat-a', NULL, 'user', '[]', 'complete', 1)`);
    const sent = await upload('sent', 'part of the transcript', { messageId: 'msg-1' });

    const result = await sweepAbandonedAttachments(store, blobStore, { now: T0 + 10 * 365 * DAY });

    expect(result).toEqual({ removed: 0 });
    expect(store.attachments.get('sent')).not.toBeNull();
    await expect(stat(sent.path)).resolves.toBeTruthy();
  });

  it('keeps the blob when a sent attachment shares its content', async () => {
    db.exec(`INSERT INTO message (id, chat_id, parent_id, role, parts, status, created_at) VALUES ('msg-1', 'chat-a', NULL, 'user', '[]', 'complete', 1)`);
    const abandoned = await upload('abandoned', 'same bytes');
    await upload('sent', 'same bytes', { messageId: 'msg-1' });

    const result = await sweepAbandonedAttachments(store, blobStore, { now: T0 + ABANDONED_ATTACHMENT_GRACE_MS + 1 });

    expect(result).toEqual({ removed: 1 });
    expect(store.attachments.get('abandoned')).toBeNull();
    expect(store.attachments.get('sent')).not.toBeNull();
    await expect(stat(abandoned.path)).resolves.toBeTruthy();
  });

  it('measures the grace period from the last change to the row', async () => {
    await upload('att', 'text read later');
    clock.now = T0 + 20 * DAY;
    store.attachments.update('att', { extractedText: 'read later' });

    // 31 days after upload, but only 11 since it last changed.
    const result = await sweepAbandonedAttachments(store, blobStore, { now: T0 + 31 * DAY });

    expect(result).toEqual({ removed: 0 });
    expect(store.attachments.get('att')).not.toBeNull();
  });

  it('skips an attachment the caller says is held (on a note waiting to be sent)', async () => {
    const held = await upload('held', 'on a waiting note');
    await upload('loose', 'nobody wants me');

    const result = await sweepAbandonedAttachments(store, blobStore, {
      now: T0 + ABANDONED_ATTACHMENT_GRACE_MS + 1,
      isHeld: (a) => a.id === 'held',
    });

    expect(result).toEqual({ removed: 1 });
    expect(store.attachments.get('held')).not.toBeNull();
    expect(store.attachments.get('loose')).toBeNull();
    await expect(stat(held.path)).resolves.toBeTruthy();
  });

  it('never deletes a row last written by another machine', async () => {
    const theirs = await upload('theirs', 'from a paired machine');
    db.prepare('UPDATE attachment SET hlc = ? WHERE id = ?').run(encodeHlc(T0, 0, 'another-machine'), 'theirs');

    const result = await sweepAbandonedAttachments(store, blobStore, { now: T0 + 10 * 365 * DAY });

    expect(result).toEqual({ removed: 0 });
    expect(store.attachments.get('theirs')).not.toBeNull();
    await expect(stat(theirs.path)).resolves.toBeTruthy();
  });

  it('removes the row but leaves the blob while an upload of the same content is pinned', async () => {
    const old = await upload('old', 'uploaded again right now');

    await withPinnedSha(old.sha256, async () => {
      const result = await sweepAbandonedAttachments(store, blobStore, { now: T0 + ABANDONED_ATTACHMENT_GRACE_MS + 1 });
      expect(result).toEqual({ removed: 1 });
    });

    expect(store.attachments.get('old')).toBeNull();
    await expect(stat(old.path)).resolves.toBeTruthy();
  });

  it('honours a shorter grace period when given one', async () => {
    await upload('att', 'short grace');

    const result = await sweepAbandonedAttachments(store, blobStore, { now: T0 + DAY + 1, graceMs: DAY });

    expect(result).toEqual({ removed: 1 });
  });
});
