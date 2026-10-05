import { describe, it, expect } from 'vitest';
import { freshDb, seedChatChain } from '../helpers.js';
import { SqliteMessageRepo } from '../../src/repos/messages.js';
import { SqliteAuditRepo } from '../../src/repos/audit.js';

describe('SqliteAuditRepo', () => {
  it('create defaults createdAt when omitted, and round-trips JSON argsRedacted', () => {
    const db = freshDb();
    seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat-a' });
    new SqliteMessageRepo(db).create({ id: 'msg-a', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    const repo = new SqliteAuditRepo(db);

    const before = Date.now();
    const created = repo.create({
      id: 'audit-a',
      chatId: 'chat-a',
      messageId: 'msg-a',
      toolName: 'fs.read',
      argsRedacted: { path: '[REDACTED]' },
      resultSummary: 'read 42 bytes',
      durationMs: 12,
      grantedBy: 'user',
    });

    expect(created.createdAt).toBeGreaterThanOrEqual(before);
    expect(repo.get('audit-a')).toEqual({
      id: 'audit-a',
      chatId: 'chat-a',
      messageId: 'msg-a',
      toolName: 'fs.read',
      argsRedacted: { path: '[REDACTED]' },
      resultSummary: 'read 42 bytes',
      durationMs: 12,
      grantedBy: 'user',
      decidedOnNode: expect.any(String),
      createdAt: created.createdAt,
    });
    db.close();
  });

  it('list(chatId) filters to that chat', () => {
    const db = freshDb();
    seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat-a' });
    seedChatChain(db, { connectionId: 'c2', modelId: 'm2', profileId: 'p2', chatId: 'chat-b' });
    const messages = new SqliteMessageRepo(db);
    messages.create({ id: 'msg-a', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    messages.create({ id: 'msg-b', chatId: 'chat-b', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    const repo = new SqliteAuditRepo(db);
    repo.create({ id: 'audit-a', chatId: 'chat-a', messageId: 'msg-a', toolName: 'fs.read', argsRedacted: {}, resultSummary: 'ok', durationMs: 1, grantedBy: 'user' });
    repo.create({ id: 'audit-b', chatId: 'chat-b', messageId: 'msg-b', toolName: 'fs.read', argsRedacted: {}, resultSummary: 'ok', durationMs: 1, grantedBy: 'user' });

    expect(repo.list('chat-a').map((a) => a.id)).toEqual(['audit-a']);
    db.close();
  });
});
