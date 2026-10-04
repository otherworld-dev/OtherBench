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
 * Direct children of `parentId`, creation-ordered. Empty if there are none
 * -- including an unknown `parentId` -- unlike `siblingsOf`/`activePath`,
 * this never throws: "no children yet" is the ordinary case for whatever is
 * currently the last message in a branch, not a data-consistency problem.
 */
export function childrenOf(messages: CanonMessage[], parentId: string): CanonMessage[] {
  return messages.filter((m) => m.parentId === parentId).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Extends a rendered path forward, past `tailId`, through any run of
 * single-child messages -- e.g. `chat.headMessageId` lands on the new user
 * message right after it's sent (Composer never auto-advances past it), so
 * a single-profile reply's lone assistant child needs to be walked into the
 * displayed thread automatically, the same way `activePath` walks everything
 * *up to* the head.
 *
 * Stops the moment a message has zero children (nothing more exists yet) or
 * more than one (an unresolved compare turn belongs there instead --
 * `childrenOf` at that point is the sibling set the UI renders as an open
 * tab strip; which one to keep is always an explicit choice, task 27, never
 * something this function decides for the caller by picking one to continue
 * through).
 */
export function extendForward(messages: CanonMessage[], tailId: string): CanonMessage[] {
  const extension: CanonMessage[] = [];
  let currentId = tailId;
  const seen = new Set<string>([tailId]); // guards against a malformed cycle looping forever
  for (;;) {
    const children = childrenOf(messages, currentId);
    if (children.length !== 1) break;
    const only = children[0]!;
    if (seen.has(only.id)) break; // defensive -- should be unreachable given create()'s own cycle guards
    extension.push(only);
    seen.add(only.id);
    currentId = only.id;
  }
  return extension;
}

/**
 * True when `siblings` is a compare turn: two or more assistant replies that
 * were fanned out together by one send. Replies added later by Regenerate
 * (`producedBy.regenerated`) don't count, and neither do user-message
 * siblings (edits), so those sets are browsed with the branch switcher and
 * only a real compare set gets the tab UI.
 */
export function isCompareSet(siblings: CanonMessage[]): boolean {
  return siblings.filter((m) => m.role === 'assistant' && !m.producedBy?.regenerated).length >= 2;
}

/**
 * Like `extendForward`, but for choosing where a whole branch ends: at a
 * point with several children that is NOT a compare turn (a regenerated
 * reply, an edited message) it continues into the newest child instead of
 * stopping. An UNRESOLVED compare turn (no variant kept or continued) still
 * stops the walk -- which variant to keep is the user's call; a resolved one
 * is walked through the variant used last. Used to find the tip to move the
 * head to when switching branches, and to display a branch down to its end.
 */
export function extendToTip(messages: CanonMessage[], tailId: string): CanonMessage[] {
  const extension: CanonMessage[] = [];
  let currentId = tailId;
  const seen = new Set<string>([tailId]);
  for (;;) {
    const children = childrenOf(messages, currentId);
    if (children.length === 0) break;
    let next: CanonMessage | undefined;
    if (isCompareSet(children)) {
      // A compare turn the user already resolved: follow the variant used
      // last -- the later of when it was kept (`keptAt`) and the newest
      // message below it (it was continued). Variants are created together,
      // so their own timestamps say nothing. Stop only when none was kept or
      // continued -- then it is still unresolved.
      let best = -1;
      for (const c of children) {
        const below = [...descendantIds(messages, c.id)].map((id) => messages.find((m) => m.id === id)?.createdAt ?? 0);
        const lastUsed = Math.max(c.keptAt ?? -1, ...below);
        if (lastUsed < 0) continue;
        if (lastUsed >= best) {
          best = lastUsed;
          next = c;
        }
      }
      if (!next) break;
    } else {
      next = children[children.length - 1]!; // creation-ordered, so the newest
    }
    if (seen.has(next.id)) break;
    extension.push(next);
    seen.add(next.id);
    currentId = next.id;
  }
  return extension;
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
