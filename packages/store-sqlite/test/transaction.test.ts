import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

// The rollback half of Store.transaction: the shared contract can only check
// the commit half, because InMemoryStore has nothing to roll back to.
let store: SqliteStore;

beforeEach(() => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  store = new SqliteStore(db);
  store.connections.create({ id: 'conn', name: 'C', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'profile',
    name: 'P',
    description: null,
    colour: null,
    connectionId: 'conn',
    modelId: 'm',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
  });
});

afterEach(() => {
  store.close();
});

function chatInput(id: string) {
  return { id, title: id, profileId: 'profile', headMessageId: null, pinned: false, archivedAt: null };
}

describe('SqliteStore.transaction', () => {
  it('rolls every write back when fn throws, and rethrows', () => {
    expect(() =>
      store.transaction(() => {
        store.chats.create(chatInput('chat-a'));
        store.messages.create({ id: 'm1', chatId: 'chat-a', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hello' }], status: 'complete', error: null, producedBy: null });
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(store.chats.get('chat-a')).toBeNull();
    expect(store.messages.get('m1')).toBeNull();
    expect(store.messages.searchText('hello', 10)).toEqual([]);
  });

  it('works again after a rollback', () => {
    expect(() =>
      store.transaction(() => {
        store.chats.create(chatInput('chat-a'));
        throw new Error('x');
      })
    ).toThrow('x');
    store.transaction(() => store.chats.create(chatInput('chat-b')));
    expect(store.chats.get('chat-b')).not.toBeNull();
  });

  it('a throw inside a nested call rolls back the outer one too', () => {
    expect(() =>
      store.transaction(() => {
        store.chats.create(chatInput('chat-a'));
        store.transaction(() => {
          throw new Error('inner');
        });
      })
    ).toThrow('inner');
    expect(store.chats.get('chat-a')).toBeNull();
  });
});
