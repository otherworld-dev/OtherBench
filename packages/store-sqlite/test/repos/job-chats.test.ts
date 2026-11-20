import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Store } from '@otherbench/core/ports/store.js';
import { SqliteStore } from '../../src/store.js';
import { freshDb } from '../helpers.js';

describe.each([
  ['SqliteStore', (): Store => new SqliteStore(freshDb())],
  ['InMemoryStore', (): Store => new InMemoryStore()],
])('jobChats (%s)', (_name, make) => {
  it('knows a chat added as a job chat, and its folder', () => {
    const store = make();
    store.jobChats.add('chat-1', 'E:\jobs\one');
    expect(store.jobChats.folderFor('chat-1')).toBe('E:\jobs\one');
  });

  it('gives null for any other chat', () => {
    expect(make().jobChats.folderFor('nope')).toBeNull();
  });

  it('forgets a removed chat', () => {
    const store = make();
    store.jobChats.add('chat-1', 'E:\jobs\one');
    store.jobChats.remove('chat-1');
    expect(store.jobChats.folderFor('chat-1')).toBeNull();
  });
});
