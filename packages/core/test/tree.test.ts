import { describe, it, expect } from 'vitest';
import type { CanonMessage } from '../src/types/messages.js';
import { activePath, siblingsOf, descendantIds } from '../src/domain/tree.js';

function msg(over: Partial<CanonMessage> & { id: string; createdAt: number }): CanonMessage {
  return {
    chatId: 'chat-1',
    parentId: null,
    role: 'user',
    parts: [{ type: 'text', text: over.id }],
    status: 'complete',
    error: null,
    producedBy: null,
    ...over,
  };
}

describe('activePath', () => {
  it('returns all messages root -> head, in order, for a linear thread', () => {
    const root = msg({ id: 'root', createdAt: 1 });
    const reply1 = msg({ id: 'reply1', parentId: 'root', role: 'assistant', createdAt: 2 });
    const reply2 = msg({ id: 'reply2', parentId: 'reply1', role: 'user', createdAt: 3 });
    const messages = [root, reply1, reply2];

    expect(activePath(messages, 'reply2').map((m) => m.id)).toEqual(['root', 'reply1', 'reply2']);
  });

  it('returns only the branch leading to the head on a compare turn with three assistant siblings', () => {
    const userTurn = msg({ id: 'user-1', createdAt: 1 });
    const replyA = msg({ id: 'reply-a', parentId: 'user-1', role: 'assistant', createdAt: 2 });
    const replyB = msg({ id: 'reply-b', parentId: 'user-1', role: 'assistant', createdAt: 3 });
    const replyC = msg({ id: 'reply-c', parentId: 'user-1', role: 'assistant', createdAt: 4 });
    const messages = [userTurn, replyA, replyB, replyC];

    expect(activePath(messages, 'reply-b').map((m) => m.id)).toEqual(['user-1', 'reply-b']);
  });

  it('moving the head to a different sibling changes activePath but leaves the others retrievable', () => {
    const userTurn = msg({ id: 'user-1', createdAt: 1 });
    const replyA = msg({ id: 'reply-a', parentId: 'user-1', role: 'assistant', createdAt: 2 });
    const replyB = msg({ id: 'reply-b', parentId: 'user-1', role: 'assistant', createdAt: 3 });
    const messages = [userTurn, replyA, replyB];

    expect(activePath(messages, 'reply-a').map((m) => m.id)).toEqual(['user-1', 'reply-a']);
    expect(activePath(messages, 'reply-b').map((m) => m.id)).toEqual(['user-1', 'reply-b']);
    // both siblings remain fully retrievable regardless of which one is "head"
    expect(siblingsOf(messages, 'reply-a').map((m) => m.id)).toEqual(['reply-a', 'reply-b']);
    expect(siblingsOf(messages, 'reply-b').map((m) => m.id)).toEqual(['reply-a', 'reply-b']);
  });

  it('throws a clear error when the head id is not present in the messages', () => {
    const messages = [msg({ id: 'root', createdAt: 1 })];
    expect(() => activePath(messages, 'does-not-exist')).toThrow(/does-not-exist/);
  });

  it('throws a clear error when an ancestor referenced by parentId is missing (orphaned branch)', () => {
    const orphan = msg({ id: 'orphan', parentId: 'ghost-parent', createdAt: 5 });
    expect(() => activePath([orphan], 'orphan')).toThrow(/ghost-parent/);
  });
});

describe('siblingsOf', () => {
  it('returns all three assistant siblings, creation-ordered, regardless of input array order', () => {
    const userTurn = msg({ id: 'user-1', createdAt: 1 });
    const replyA = msg({ id: 'reply-a', parentId: 'user-1', role: 'assistant', createdAt: 4 });
    const replyB = msg({ id: 'reply-b', parentId: 'user-1', role: 'assistant', createdAt: 2 });
    const replyC = msg({ id: 'reply-c', parentId: 'user-1', role: 'assistant', createdAt: 3 });
    // deliberately shuffled input order
    const messages = [replyA, userTurn, replyC, replyB];

    expect(siblingsOf(messages, 'reply-c').map((m) => m.id)).toEqual(['reply-b', 'reply-c', 'reply-a']);
  });

  it('includes the message itself among its siblings', () => {
    const root = msg({ id: 'root', createdAt: 1 });
    expect(siblingsOf([root], 'root').map((m) => m.id)).toEqual(['root']);
  });

  it('throws a clear error when the given message id is not present', () => {
    expect(() => siblingsOf([], 'nope')).toThrow(/nope/);
  });
});

describe('descendantIds', () => {
  it('collects all descendants across multiple levels, excluding the message itself', () => {
    const root = msg({ id: 'root', createdAt: 1 });
    const child = msg({ id: 'child', parentId: 'root', createdAt: 2 });
    const grandchild1 = msg({ id: 'gc1', parentId: 'child', createdAt: 3 });
    const grandchild2 = msg({ id: 'gc2', parentId: 'child', createdAt: 4 });
    const unrelated = msg({ id: 'unrelated', createdAt: 5 });
    const messages = [root, child, grandchild1, grandchild2, unrelated];

    expect(descendantIds(messages, 'root')).toEqual(new Set(['child', 'gc1', 'gc2']));
  });

  it('returns an empty set for a leaf message with no children', () => {
    const root = msg({ id: 'root', createdAt: 1 });
    const leaf = msg({ id: 'leaf', parentId: 'root', createdAt: 2 });
    expect(descendantIds([root, leaf], 'leaf')).toEqual(new Set());
  });
});
