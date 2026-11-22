import { afterEach, describe, expect, it, vi } from 'vitest';
import { extendToTip } from '@otherbench/core/domain/tree.js';
import type { Store } from '@otherbench/core/ports/store.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { openDatabase } from '@otherbench/store-sqlite/db.js';
import { runMigrations } from '@otherbench/store-sqlite/migrations/index.js';
import { SqliteStore } from '@otherbench/store-sqlite/store.js';
import { chatTip, collectMessageTree } from '../src/chat-read.js';
import * as fromRoutes from '../src/routes/chats.js';

/** How the tree was read before: one `children()` query per message. Kept here as what the new reading must equal. */
function treeByWalking(store: Store, chatId: string): CanonMessage[] {
  const result: CanonMessage[] = [];
  const queue = [...store.messages.roots(chatId)];
  while (queue.length > 0) {
    const message = queue.shift();
    if (!message) continue;
    result.push(message);
    queue.push(...store.messages.children(message.id));
  }
  return result;
}

/** How the tip was found before: from the whole tree, parts and all. */
function tipFromWholeTree(store: Store, chatId: string, headId: string | null): string | null {
  const messages = treeByWalking(store, chatId);
  if (messages.length === 0) return null;
  if (headId === null) throw new Error('This chat has messages but no current one to continue from. Open it and pick a reply.');
  const tip = extendToTip(messages, headId).at(-1) ?? messages.find((m) => m.id === headId);
  if (!tip) throw new Error("This chat's current message is missing. Open it and pick a reply.");
  if (tip.role !== 'assistant') {
    throw new Error('This chat ends in a message with no reply kept (an unpicked compare, or a message with no answer). Pick a reply in the chat first.');
  }
  if (tip.status === 'streaming') throw new Error('A reply is still being written in this chat.');
  return tip.id;
}

const outcome = (fn: () => string | null): string | null => {
  try {
    return fn();
  } catch (err) {
    return `throws: ${(err as Error).message}`;
  }
};

function seed(store: Store, chatId: string): void {
  const connectionId = `${chatId}-conn`;
  const profileId = `${chatId}-profile`;
  store.connections.create({ id: connectionId, name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.models.create({
    id: `${chatId}-model`, connectionId, modelId: 'mock', displayName: 'Mock', source: 'manual', supportsVision: false, supportsTools: true,
    supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  store.profiles.create({
    id: profileId, name: 'Profile', description: null, colour: null, connectionId, modelId: `${chatId}-model`, systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null,
  });
  store.chats.create({ id: chatId, title: chatId, profileId, headMessageId: null, workspace: null, pinned: false, archivedAt: null });
}

/**
 * A branched chat, written out of tree order and with ties on the time, so only the right ordering passes:
 *
 * u1 ─ a1 ─ u2 ─┬─ a2x (compare, kept)  ─ u3 ─ a3 (streaming)
 *               ├─ a2y (compare)
 *               └─ a2r (regenerated later)
 *    └ a1b (regenerated) ─ u2b ─┬─ c1 (compare, unpicked)
 *                               └─ c2 (compare, unpicked)
 * e1 (a second root: an edit of u1) ─ e2 ─ e3 (a user message with no reply)
 */
function branched(store: Store, chatId: string): void {
  let n = 0;
  const add = (id: string, parentId: string | null, role: 'user' | 'assistant', createdAt: number, over: Partial<CanonMessage> = {}): void => {
    store.messages.create({
      id, chatId, parentId, role, createdAt, status: 'complete', error: null,
      producedBy: role === 'assistant' ? { profileId: `${chatId}-profile`, profileName: 'p', connectionId: `${chatId}-conn`, modelId: 'mock' } : null,
      parts: [{ type: 'text', text: `${id} #${n++}` }, ...(role === 'assistant' ? [{ type: 'tool-call' as const, id: `t-${id}`, name: 'read', args: { path: id } }] : [])],
      ...over,
    });
  };
  const regenerated = { producedBy: { profileId: `${chatId}-profile`, profileName: 'p', connectionId: `${chatId}-conn`, modelId: 'mock', regenerated: true } };
  add('u1', null, 'user', 10);
  add('e1', null, 'user', 10);
  add('a1', 'u1', 'assistant', 20);
  add('u2', 'a1', 'user', 30);
  // A compare turn: both written in the same millisecond, the later id first.
  add('a2y', 'u2', 'assistant', 40);
  add('a2x', 'u2', 'assistant', 40, { keptAt: 45 });
  add('u3', 'a2x', 'user', 50);
  add('a3', 'u3', 'assistant', 60, { status: 'streaming' });
  add('a2r', 'u2', 'assistant', 70, regenerated);
  add('a1b', 'u1', 'assistant', 80, regenerated);
  add('u2b', 'a1b', 'user', 90);
  add('c2', 'u2b', 'assistant', 100);
  add('c1', 'u2b', 'assistant', 100);
  add('e2', 'e1', 'assistant', 110);
  add('e3', 'e2', 'user', 120);
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const stores: [string, () => Store][] = [
  [
    'the SQLite store',
    () => {
      const db = openDatabase(':memory:');
      runMigrations(db);
      const store = new SqliteStore(db);
      closers.push(() => store.close());
      return store;
    },
  ],
  ['the in-memory store', () => new InMemoryStore()],
];

describe.each(stores)('reading a chat from %s', (_name, open) => {
  it('gives the whole tree as the walk did, same messages in the same order, without a query per message', () => {
    const store = open();
    seed(store, 'chat');
    seed(store, 'other');
    branched(store, 'chat');
    store.messages.create({ id: 'x1', chatId: 'other', parentId: null, role: 'user', parts: [{ type: 'text', text: 'elsewhere' }], status: 'complete', error: null, producedBy: null, createdAt: 5 });

    const walked = treeByWalking(store, 'chat');
    expect(walked.map((m) => m.id)).toEqual(['e1', 'u1', 'e2', 'a1', 'a1b', 'e3', 'u2', 'u2b', 'a2x', 'a2y', 'a2r', 'c1', 'c2', 'u3', 'a3']);

    const children = vi.spyOn(store.messages, 'children');
    const roots = vi.spyOn(store.messages, 'roots');
    expect(collectMessageTree(store, 'chat')).toEqual(walked);
    expect(children).not.toHaveBeenCalled();
    expect(roots).not.toHaveBeenCalled();

    expect(collectMessageTree(store, 'other').map((m) => m.id)).toEqual(['x1']);
    expect(collectMessageTree(store, 'no-such-chat')).toEqual([]);
  });

  it('finds the tip as before from every head, without reading the whole chat', () => {
    const store = open();
    seed(store, 'chat');
    seed(store, 'empty');
    branched(store, 'chat');

    const heads = [null, 'no-such-message', ...treeByWalking(store, 'chat').map((m) => m.id)];
    const expected = heads.map((head) => outcome(() => tipFromWholeTree(store, 'chat', head)));
    // Every kind of ending is among them: a finished reply, a reply still being written, an unpicked compare, no reply.
    expect(expected).toContain('a2r');
    expect(expected).toContain('throws: A reply is still being written in this chat.');
    expect(expected.filter((e) => e?.includes('no reply kept')).length).toBeGreaterThan(1);
    expect(expected).toContain("throws: This chat's current message is missing. Open it and pick a reply.");
    expect(expected).toContain('throws: This chat has messages but no current one to continue from. Open it and pick a reply.');

    const whole = vi.spyOn(store.messages, 'chatTree');
    const roots = vi.spyOn(store.messages, 'roots');
    expect(heads.map((head) => outcome(() => chatTip(store, 'chat', head)))).toEqual(expected);
    expect(whole).not.toHaveBeenCalled();
    expect(roots).not.toHaveBeenCalled();

    // From the end of a branch it reads that message and looks below it once: nothing else of the chat.
    const get = vi.spyOn(store.messages, 'get');
    const children = vi.spyOn(store.messages, 'children');
    expect(chatTip(store, 'chat', 'a2r')).toBe('a2r');
    expect(get).toHaveBeenCalledTimes(1);
    expect(children).toHaveBeenCalledTimes(1);

    expect(chatTip(store, 'empty', null)).toBeNull();
    expect(chatTip(store, 'empty', 'a2r')).toBeNull();
  });
});

describe('routes/chats.ts', () => {
  it('still hands out the same two functions, for the routes and tests that import them from there', () => {
    expect(fromRoutes.collectMessageTree).toBe(collectMessageTree);
    expect(fromRoutes.chatTip).toBe(chatTip);
  });
});
