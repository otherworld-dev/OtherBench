import type { CanonMessage } from '../types/messages.js';

// Pure functions over an in-memory CanonMessage[]. They never touch the
// store -- the repo does the SQL walk (recursive CTE for pathToRoot); these
// exist for the domain and the UI to reason about a chat already loaded
// into memory (e.g. rendering the active branch, or a compare-turn's
// sibling set).

/**
 * The chain of messages from the chat's root down to `headId`, in
 * root -> head order. Because one user turn can have several assistant
 * replies (a "compare turn"), a chat is a tree, not a list -- this walks
 * only the branch that ends at `headId`, ignoring any sibling variants.
 *
 * Throws if `headId` isn't present in `messages`, or if a message's
 * `parentId` points at an id that isn't present (an orphaned branch) --
 * both indicate the caller handed us an incomplete or inconsistent slice,
 * and silently truncating the path would hide that rather than surface it.
 */
export function activePath(messages: CanonMessage[], headId: string): CanonMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const head = byId.get(headId);
  if (!head) {
    throw new Error(`activePath: no message with id "${headId}" in the given messages`);
  }

  const path: CanonMessage[] = [head];
  let current = head;
  while (current.parentId !== null) {
    const parent = byId.get(current.parentId);
    if (!parent) {
      throw new Error(
        `activePath: message "${current.id}" references missing parent "${current.parentId}"`
      );
    }
    path.push(parent);
    current = parent;
  }
  return path.reverse();
}

/**
 * The full variant set that `messageId` belongs to -- every message sharing
 * its parent, including itself -- ordered by creation time. This is the set
 * a "compare turn" UI would render as switchable tabs/columns.
 *
 * Throws if `messageId` isn't present in `messages`, since there is no
 * parent to compare against otherwise.
 */
export function siblingsOf(messages: CanonMessage[], messageId: string): CanonMessage[] {
  const target = messages.find((m) => m.id === messageId);
  if (!target) {
    throw new Error(`siblingsOf: no message with id "${messageId}" in the given messages`);
  }
  return messages
    .filter((m) => m.parentId === target.parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * All descendant ids of `messageId` (children, grandchildren, ...),
 * excluding `messageId` itself. Used e.g. to cascade a delete or to grey
 * out an abandoned branch. Returns an empty set for a leaf, or for an id
 * with no children in `messages` (including one not present at all).
 */
export function descendantIds(messages: CanonMessage[], messageId: string): Set<string> {
  const childrenOf = new Map<string, CanonMessage[]>();
  for (const m of messages) {
    if (m.parentId === null) continue;
    const siblings = childrenOf.get(m.parentId);
    if (siblings) siblings.push(m);
    else childrenOf.set(m.parentId, [m]);
  }

  const result = new Set<string>();
  const stack = [...(childrenOf.get(messageId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || result.has(next.id)) continue;
    result.add(next.id);
    const kids = childrenOf.get(next.id);
    if (kids) stack.push(...kids);
  }
  return result;
}
