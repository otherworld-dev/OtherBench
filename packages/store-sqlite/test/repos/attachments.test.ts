import { describe, it, expect } from 'vitest';
import type { Attachment } from '@otherbench/core/ports/store.js';
import { encodeHlc } from '@otherbench/core/domain/hlc.js';
import { freshDb, seedChatChain } from '../helpers.js';
import { SqliteAttachmentRepo } from '../../src/repos/attachments.js';
import { clockOf } from '../../src/repos/clock.js';
import { selfIdOf } from '../../src/repos/nodes.js';

function makeAttachment(over: Partial<Attachment> & { id: string; chatId: string }): Attachment {
  return {
    messageId: null,
    filename: 'test.txt',
    mime: 'text/plain',
    size: 4,
    sha256: 'deadbeef',
    storagePath: '/tmp/test.txt',
    extractedText: null,
    ...over,
  };
}

describe('SqliteAttachmentRepo', () => {
  it('create/get round-trips every field', () => {
    const db = freshDb();
    seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat-a' });
    const repo = new SqliteAttachmentRepo(db);

    repo.create(
      makeAttachment({
        id: 'att-a',
        chatId: 'chat-a',
        filename: 'photo.png',
        mime: 'image/png',
        size: 1024,
        sha256: 'abc123',
        storagePath: '/data/photo.png',
        extractedText: 'some ocr text',
      })
    );

    expect(repo.get('att-a')).toEqual({
      id: 'att-a',
      chatId: 'chat-a',
      messageId: null,
      filename: 'photo.png',
      mime: 'image/png',
      size: 1024,
      sha256: 'abc123',
      storagePath: '/data/photo.png',
      extractedText: 'some ocr text',
    });
    db.close();
  });

  it('list(chatId) filters to that chat', () => {
    const db = freshDb();
    seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat-a' });
    seedChatChain(db, { connectionId: 'c2', modelId: 'm2', profileId: 'p2', chatId: 'chat-b' });
    const repo = new SqliteAttachmentRepo(db);
    repo.create(makeAttachment({ id: 'att-a', chatId: 'chat-a' }));
    repo.create(makeAttachment({ id: 'att-b', chatId: 'chat-b' }));

    expect(repo.list('chat-a').map((a) => a.id)).toEqual(['att-a']);
    db.close();
  });

  it('delete is idempotent on a missing id, and a subsequent get returns null', () => {
    const db = freshDb();
    const repo = new SqliteAttachmentRepo(db);
    expect(() => repo.delete('does-not-exist')).not.toThrow();
    expect(repo.get('does-not-exist')).toBeNull();
    db.close();
  });

  describe('abandoned(writtenBefore)', () => {
    const T0 = 1_800_000_000_000;

    /** A repo whose clock reads `at.now`, so every stamp it writes is at a time the test picked. */
    function repoAt(at: { now: number }) {
      const db = freshDb();
      seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat-a' });
      const selfId = selfIdOf(db);
      const repo = new SqliteAttachmentRepo(db, clockOf(db, selfId, () => at.now));
      return { db, repo, selfId };
    }

    it('lists an unsent attachment last written before the cutoff, and not one written at or after it', () => {
      const at = { now: T0 };
      const { db, repo } = repoAt(at);
      repo.create(makeAttachment({ id: 'old', chatId: 'chat-a' }));
      at.now = T0 + 10;
      repo.create(makeAttachment({ id: 'new', chatId: 'chat-a' }));

      expect(repo.abandoned(T0 + 1).map((a) => a.id)).toEqual(['old']);
      expect(repo.abandoned(T0)).toEqual([]);
      expect(repo.abandoned(T0 + 11).map((a) => a.id).sort()).toEqual(['new', 'old']);
      db.close();
    });

    it('never lists a sent attachment, however old', () => {
      const at = { now: T0 };
      const { db, repo } = repoAt(at);
      db.exec(`INSERT INTO message (id, chat_id, parent_id, role, parts, status, created_at) VALUES ('msg-1', 'chat-a', NULL, 'user', '[]', 'complete', 1)`);
      repo.create(makeAttachment({ id: 'sent', chatId: 'chat-a', messageId: 'msg-1' }));

      expect(repo.abandoned(T0 + 365 * 24 * 60 * 60 * 1000)).toEqual([]);
      db.close();
    });

    it('measures age from the last write, not the upload: a later change makes it young again', () => {
      const at = { now: T0 };
      const { db, repo } = repoAt(at);
      repo.create(makeAttachment({ id: 'att', chatId: 'chat-a' }));
      at.now = T0 + 1000;
      repo.update('att', { extractedText: 'read later' });

      expect(repo.abandoned(T0 + 500)).toEqual([]);
      expect(repo.abandoned(T0 + 1001).map((a) => a.id)).toEqual(['att']);
      db.close();
    });

    it('never lists a row whose last write came from another machine', () => {
      const at = { now: T0 };
      const { db, repo } = repoAt(at);
      repo.create(makeAttachment({ id: 'theirs', chatId: 'chat-a' }));
      db.prepare('UPDATE attachment SET hlc = ? WHERE id = ?').run(encodeHlc(T0, 0, 'another-machine'), 'theirs');

      expect(repo.abandoned(T0 + 365 * 24 * 60 * 60 * 1000)).toEqual([]);
      db.close();
    });

    it('never lists a row with no stamp at all', () => {
      const at = { now: T0 };
      const { db, repo } = repoAt(at);
      repo.create(makeAttachment({ id: 'unstamped', chatId: 'chat-a' }));
      db.prepare(`UPDATE attachment SET hlc = '' WHERE id = ?`).run('unstamped');

      expect(repo.abandoned(T0 + 365 * 24 * 60 * 60 * 1000)).toEqual([]);
      db.close();
    });
  });
});
