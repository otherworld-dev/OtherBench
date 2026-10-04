import { describe, it, expect } from 'vitest';
import type { CanonMessage } from '../src/types/messages.js';
import { activePath, siblingsOf, descendantIds, childrenOf, extendForward, isCompareSet, extendToTip } from '../src/domain/tree.js';

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

describe('childrenOf', () => {
  it('returns direct children only, creation-ordered', () => {
    const root = msg({ id: 'root', createdAt: 1 });
    const gc = msg({ id: 'gc', parentId: 'child', createdAt: 4 });
    const childB = msg({ id: 'child-b', parentId: 'root', createdAt: 3 });
    const childA = msg({ id: 'child-a', parentId: 'root', createdAt: 2 });
    const messages = [root, gc, childB, childA];

    expect(childrenOf(messages, 'root').map((m) => m.id)).toEqual(['child-a', 'child-b']);
  });

  it('returns an empty array for a leaf or an unknown parent id, never throws', () => {
    const root = msg({ id: 'root', createdAt: 1 });
    expect(childrenOf([root], 'root')).toEqual([]);
    expect(childrenOf([root], 'no-such-id')).toEqual([]);
  });
});

describe('extendForward', () => {
  it('walks forward through a run of single-child messages to the true leaf', () => {
    const root = msg({ id: 'root', createdAt: 1 });
    const userMsg = msg({ id: 'user', parentId: 'root', createdAt: 2 });
    const reply = msg({ id: 'reply', parentId: 'user', createdAt: 3, role: 'assistant' });
    const messages = [root, userMsg, reply];

    expect(extendForward(messages, 'root').map((m) => m.id)).toEqual(['user', 'reply']);
  });

  it('stops right before an unresolved compare turn (more than one child)', () => {
    const userMsg = msg({ id: 'user', createdAt: 1 });
    const variantA = msg({ id: 'variant-a', parentId: 'user', createdAt: 2, role: 'assistant' });
    const variantB = msg({ id: 'variant-b', parentId: 'user', createdAt: 3, role: 'assistant' });
    const messages = [userMsg, variantA, variantB];

    expect(extendForward(messages, 'user')).toEqual([]);
    // The unresolved set is exactly what `childrenOf` returns at that tail --
    // this is the contract the UI relies on to render the open tab strip.
    expect(childrenOf(messages, 'user').map((m) => m.id)).toEqual(['variant-a', 'variant-b']);
  });

  it('returns an empty array when the tail is already a true leaf', () => {
    const root = msg({ id: 'root', createdAt: 1 });
    expect(extendForward([root], 'root')).toEqual([]);
  });

  it('extends through a chain, then stops at a compare turn partway along it', () => {
    const root = msg({ id: 'root', createdAt: 1 });
    const mid = msg({ id: 'mid', parentId: 'root', createdAt: 2 });
    const variantA = msg({ id: 'variant-a', parentId: 'mid', createdAt: 3, role: 'assistant' });
    const variantB = msg({ id: 'variant-b', parentId: 'mid', createdAt: 4, role: 'assistant' });
    const messages = [root, mid, variantA, variantB];

    expect(extendForward(messages, 'root').map((m) => m.id)).toEqual(['mid']);
  });
});

describe('isCompareSet', () => {
  const pb = (regenerated?: boolean) => ({ profileId: 'p', profileName: 'P', connectionId: 'c', modelId: 'm', ...(regenerated ? { regenerated } : {}) });
  const asst = (id: string, createdAt: number, regenerated?: boolean) =>
    msg({ id, parentId: 'u', role: 'assistant', createdAt, producedBy: pb(regenerated) });

  it('is true for two or more assistant replies fanned out together', () => {
    expect(isCompareSet([asst('a', 1), asst('b', 1)])).toBe(true);
  });
  it('is false for a single reply, with or without regenerated siblings', () => {
    expect(isCompareSet([asst('a', 1)])).toBe(false);
    expect(isCompareSet([asst('a', 1), asst('b', 2, true), asst('c', 3, true)])).toBe(false);
  });
  it('is false for user-message siblings (edits)', () => {
    expect(isCompareSet([msg({ id: 'x', createdAt: 1 }), msg({ id: 'y', createdAt: 2 })])).toBe(false);
  });
});

describe('extendToTip', () => {
  const u = (id: string, parentId: string | null, createdAt: number) => msg({ id, parentId, createdAt });
  const a = (id: string, parentId: string, createdAt: number, regenerated?: boolean) =>
    msg({
      id, parentId, role: 'assistant', createdAt,
      producedBy: { profileId: 'p', profileName: 'P', connectionId: 'c', modelId: 'm', ...(regenerated ? { regenerated } : {}) },
    });

  it('walks a single-child chain to the leaf', () => {
    const ms = [u('u1', null, 1), a('a1', 'u1', 2), u('u2', 'a1', 3), a('a2', 'u2', 4)];
    expect(extendToTip(ms, 'u1').map((m) => m.id)).toEqual(['a1', 'u2', 'a2']);
  });
  it('picks the newest child where the branch point is a regenerate/edit set', () => {
    const ms = [u('u1', null, 1), a('a1', 'u1', 2), a('a1b', 'u1', 3, true), u('u2', 'a1b', 4), u('u2b', 'a1b', 5), a('a3', 'u2b', 6)];
    expect(extendToTip(ms, 'u1').map((m) => m.id)).toEqual(['a1b', 'u2b', 'a3']);
  });
  it('walks through a compare turn the user already resolved and continued (follows the variant with children)', () => {
    const ms = [u('u1', null, 1), a('x', 'u1', 2), a('y', 'u1', 2), u('u2', 'y', 3), a('a2', 'u2', 4)];
    expect(extendToTip(ms, 'u1').map((m) => m.id)).toEqual(['y', 'u2', 'a2']);
  });
  it('when both variants were continued, follows the one whose subtree holds the newest message, not the later-created variant', () => {
    // x and y are created together (y sorts last); x's branch was used most recently.
    const ms = [u('u1', null, 1), a('x', 'u1', 2), a('y', 'u1', 2), u('uy', 'y', 3), u('ux', 'x', 4), a('ax', 'ux', 5), u('ux2', 'ax', 10)];
    expect(extendToTip(ms, 'u1').map((m) => m.id)).toEqual(['x', 'ux', 'ax', 'ux2']);
  });
  it('follows the newest continued variant when several have children', () => {
    const ms = [u('u1', null, 1), a('x', 'u1', 2), a('y', 'u1', 2), u('ux', 'x', 3), u('uy', 'y', 5)];
    expect(extendToTip(ms, 'u1').map((m) => m.id)).toEqual(['y', 'uy']);
  });
  it('stops at an unresolved compare turn', () => {
    const ms = [u('u1', null, 1), a('x', 'u1', 2), a('y', 'u1', 2)];
    expect(extendToTip(ms, 'u1')).toEqual([]);
  });
  it('follows a variant that was kept but never continued', () => {
    const ms = [u('u1', null, 1), a('x', 'u1', 2), { ...a('y', 'u1', 2), keptAt: 7 }];
    expect(extendToTip(ms, 'u1').map((m) => m.id)).toEqual(['y']);
  });
  it('a keep made after continuing another variant wins, and a later continuation wins back', () => {
    const base = [u('u1', null, 1), a('x', 'u1', 2), u('ux', 'x', 5)];
    expect(extendToTip([...base, { ...a('y', 'u1', 2), keptAt: 9 }], 'u1').map((m) => m.id)).toEqual(['y']);
    expect(extendToTip([...base, { ...a('y', 'u1', 2), keptAt: 4 }], 'u1').map((m) => m.id)).toEqual(['x', 'ux']);
  });
});
