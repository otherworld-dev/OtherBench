import { describe, it, expect } from 'vitest';
import type { Part } from '@grunt/core/types/messages.js';
import { freshDb, seedChatChain } from '../helpers.js';
import { SqliteMessageRepo } from '../../src/repos/messages.js';

function seedChat(db: ReturnType<typeof freshDb>, chatId = 'chat-a'): void {
  seedChatChain(db, { connectionId: `${chatId}::conn`, modelId: `${chatId}::model`, profileId: `${chatId}::profile`, chatId });
}

describe('SqliteMessageRepo', () => {
  it('create defaults createdAt and round-trips parts/producedBy JSON', () => {
    const db = freshDb();
    seedChat(db);
    const repo = new SqliteMessageRepo(db);

    const before = Date.now();
    const parts: Part[] = [{ type: 'text', text: 'hello there' }];
    const created = repo.create({
      id: 'msg-a',
      chatId: 'chat-a',
      parentId: null,
      role: 'user',
      parts,
      status: 'complete',
      error: null,
      producedBy: { profileId: 'p1', profileName: 'P', connectionId: 'c1', modelId: 'm1' },
    });

    expect(created.createdAt).toBeGreaterThanOrEqual(before);
    const got = repo.get('msg-a');
    expect(got?.parts).toEqual(parts);
    expect(got?.producedBy).toEqual({ profileId: 'p1', profileName: 'P', connectionId: 'c1', modelId: 'm1' });
    db.close();
  });

  it('get returns null for an unknown id', () => {
    const db = freshDb();
    const repo = new SqliteMessageRepo(db);
    expect(repo.get('does-not-exist')).toBeNull();
    db.close();
  });

  it('create throws on a duplicate id', () => {
    const db = freshDb();
    seedChat(db);
    const repo = new SqliteMessageRepo(db);
    repo.create({ id: 'msg-a', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    expect(() =>
      repo.create({ id: 'msg-a', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null })
    ).toThrow(Error);
    db.close();
  });

  it('children returns messages ordered by createdAt ascending, not insertion order', () => {
    const db = freshDb();
    seedChat(db);
    const repo = new SqliteMessageRepo(db);
    repo.create({ id: 'parent', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 1 });
    repo.create({ id: 'child-2', chatId: 'chat-a', parentId: 'parent', role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 30 });
    repo.create({ id: 'child-1', chatId: 'chat-a', parentId: 'parent', role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 10 });

    expect(repo.children('parent').map((m) => m.id)).toEqual(['child-1', 'child-2']);
    db.close();
  });

  it('roots returns only root messages for the given chat', () => {
    const db = freshDb();
    seedChat(db, 'chat-a');
    seedChat(db, 'chat-b');
    const repo = new SqliteMessageRepo(db);
    repo.create({ id: 'root-a', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 1 });
    repo.create({ id: 'child-a', chatId: 'chat-a', parentId: 'root-a', role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 2 });
    repo.create({ id: 'root-b', chatId: 'chat-b', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 1 });

    expect(repo.roots('chat-a').map((m) => m.id)).toEqual(['root-a']);
    db.close();
  });

  it('pathToRoot returns root -> leaf order; [] for an unknown id', () => {
    const db = freshDb();
    seedChat(db);
    const repo = new SqliteMessageRepo(db);
    repo.create({ id: 'root', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 1 });
    repo.create({ id: 'mid', chatId: 'chat-a', parentId: 'root', role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 2 });
    repo.create({ id: 'leaf', chatId: 'chat-a', parentId: 'mid', role: 'user', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 3 });

    expect(repo.pathToRoot('leaf').map((m) => m.id)).toEqual(['root', 'mid', 'leaf']);
    expect(repo.pathToRoot('does-not-exist')).toEqual([]);
    db.close();
  });

  it('updateParts persists new parts and re-derives search_text (verified via searchText)', () => {
    const db = freshDb();
    seedChat(db);
    const repo = new SqliteMessageRepo(db);
    repo.create({ id: 'msg-a', chatId: 'chat-a', parentId: null, role: 'user', parts: [{ type: 'text', text: 'original zephyrwombat' }], status: 'complete', error: null, producedBy: null });

    repo.updateParts('msg-a', [{ type: 'text', text: 'updated banana content' }]);

    expect(repo.get('msg-a')?.parts).toEqual([{ type: 'text', text: 'updated banana content' }]);
    expect(repo.searchText('zephyrwombat', 10).map((r) => r.messageId)).toEqual([]);
    expect(repo.searchText('banana', 10).map((r) => r.messageId)).toEqual(['msg-a']);
    db.close();
  });

  it('updateParts ignores non-text parts when deriving search_text', () => {
    const db = freshDb();
    seedChat(db);
    const repo = new SqliteMessageRepo(db);
    repo.create({ id: 'msg-a', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });

    repo.updateParts('msg-a', [
      { type: 'text', text: 'searchable kumquat text' },
      { type: 'tool-call', id: 't1', name: 'fs.read', args: { path: 'unsearchable-artifact.txt' } },
    ]);

    expect(repo.searchText('kumquat', 10).map((r) => r.messageId)).toEqual(['msg-a']);
    db.close();
  });

  it('updateParts throws when the id does not exist', () => {
    const db = freshDb();
    const repo = new SqliteMessageRepo(db);
    expect(() => repo.updateParts('does-not-exist', [{ type: 'text', text: 'x' }])).toThrow(Error);
    db.close();
  });

  it('updateStatus persists status and error, and clears error when omitted', () => {
    const db = freshDb();
    seedChat(db);
    const repo = new SqliteMessageRepo(db);
    repo.create({ id: 'msg-a', chatId: 'chat-a', parentId: null, role: 'assistant', parts: [], status: 'streaming', error: null, producedBy: null });

    repo.updateStatus('msg-a', 'error', { kind: 'transient', message: 'boom', retryable: true });
    let after = repo.get('msg-a');
    expect(after?.status).toBe('error');
    expect(after?.error).toEqual({ kind: 'transient', message: 'boom', retryable: true });

    repo.updateStatus('msg-a', 'complete');
    after = repo.get('msg-a');
    expect(after?.status).toBe('complete');
    expect(after?.error).toBeNull();
    db.close();
  });

  it('updateStatus throws when the id does not exist', () => {
    const db = freshDb();
    const repo = new SqliteMessageRepo(db);
    expect(() => repo.updateStatus('does-not-exist', 'complete')).toThrow(Error);
    db.close();
  });

  it('searchText respects the limit argument', () => {
    const db = freshDb();
    seedChat(db);
    const repo = new SqliteMessageRepo(db);
    for (let i = 0; i < 5; i++) {
      repo.create({ id: `msg-${i}`, chatId: 'chat-a', parentId: null, role: 'user', parts: [{ type: 'text', text: 'papaya common word' }], status: 'complete', error: null, producedBy: null });
    }
    expect(repo.searchText('papaya', 2)).toHaveLength(2);
    db.close();
  });
});
