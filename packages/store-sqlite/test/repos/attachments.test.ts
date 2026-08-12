import { describe, it, expect } from 'vitest';
import type { Attachment } from '@grunt/core/ports/store.js';
import { freshDb, seedChatChain } from '../helpers.js';
import { SqliteAttachmentRepo } from '../../src/repos/attachments.js';

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
});
