import { describe, it, expect } from 'vitest';
import { freshDb, seedProfileChain } from '../helpers.js';
import { SqliteChatRepo } from '../../src/repos/chats.js';

describe('SqliteChatRepo', () => {
  it('create defaults createdAt/updatedAt when omitted', () => {
    const db = freshDb();
    seedProfileChain(db, { connectionId: 'conn-a', modelId: 'model-a', profileId: 'profile-a' });
    const repo = new SqliteChatRepo(db);

    const before = Date.now();
    const created = repo.create({
      id: 'chat-a',
      title: 'My Chat',
      profileId: 'profile-a',
      headMessageId: null,
      workspaceRoot: null,
      pinned: false,
      archivedAt: null,
    });
    const after = Date.now();

    expect(created.createdAt).toBeGreaterThanOrEqual(before);
    expect(created.createdAt).toBeLessThanOrEqual(after);
    expect(created.updatedAt).toBe(created.createdAt);
    db.close();
  });

  it('create honors explicit createdAt/updatedAt', () => {
    const db = freshDb();
    seedProfileChain(db, { connectionId: 'conn-a', modelId: 'model-a', profileId: 'profile-a' });
    const repo = new SqliteChatRepo(db);

    const created = repo.create({
      id: 'chat-a',
      title: 'My Chat',
      profileId: 'profile-a',
      headMessageId: null,
      workspaceRoot: null,
      pinned: false,
      archivedAt: null,
      createdAt: 1000,
      updatedAt: 2000,
    });

    expect(created.createdAt).toBe(1000);
    expect(created.updatedAt).toBe(2000);
    db.close();
  });

  it('get/list round-trip pinned as a real boolean', () => {
    const db = freshDb();
    seedProfileChain(db, { connectionId: 'conn-a', modelId: 'model-a', profileId: 'profile-a' });
    const repo = new SqliteChatRepo(db);
    repo.create({
      id: 'chat-a',
      title: 'Pinned Chat',
      profileId: 'profile-a',
      headMessageId: null,
      workspaceRoot: '/some/workspace',
      pinned: true,
      archivedAt: null,
    });

    const got = repo.get('chat-a');
    expect(got?.pinned).toBe(true);
    expect(got?.workspaceRoot).toBe('/some/workspace');
    expect(repo.list().map((c) => c.id)).toEqual(['chat-a']);
    db.close();
  });

  it('delete is idempotent on a missing id', () => {
    const db = freshDb();
    const repo = new SqliteChatRepo(db);
    expect(() => repo.delete('does-not-exist')).not.toThrow();
    db.close();
  });
});
