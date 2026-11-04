import { matchOffsets } from './chatFind.js';

/**
 * The drawn half of find in a chat (chatFind.ts finds the matches in the messages): where a match sits in a message
 * on the page, and its highlight. The highlight is a CSS Custom Highlight over a Range, so the message's elements are
 * never touched and `MarkdownBody`'s memo holds.
 */

/** Controls inside message text that aren't its text: Copy buttons, and a long message's Show all. */
const NOT_TEXT = '[data-copy-chrome], [data-find-skip]';

/** The `::highlight()` name index.css styles. */
export const FIND_HIGHLIGHT = 'chat-find';

/** What find searches in a drawn message: a user message's body, or a reply's own text blocks (not those in its tool and helper cards). */
export function findRoots(article: Element): Element[] {
  const body = article.querySelector('[data-message-body]');
  if (!body) return [];
  return article.getAttribute('data-role') === 'user' ? [body] : Array.from(body.querySelectorAll(':scope > .markdown-body'));
}

/**
 * A Range over match `occurrence` of `query` in `roots`' text, the roots a line apart as chatFind's text is. The
 * rendered text can come out with fewer matches than the message's (a footnote, say), so past the last it takes the
 * last. Null when there's none.
 */
export function locateMatch(roots: readonly Element[], query: string, occurrence: number): Range | null {
  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  roots.forEach((root, i) => {
    if (i > 0) text += '\n';
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest(NOT_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n as Text, start: text.length });
      text += (n as Text).data;
    }
  });
  const offsets = matchOffsets(text, query);
  if (offsets.length === 0) return null;
  const from = offsets[Math.min(occurrence, offsets.length - 1)]!;
  const to = from + query.length;
  const first = nodes.find((n) => n.start <= from && from < n.start + n.node.data.length);
  const last = nodes.find((n) => n.start < to && to <= n.start + n.node.data.length);
  if (!first || !last) return null;
  const range = first.node.ownerDocument.createRange();
  range.setStart(first.node, from - first.start);
  range.setEnd(last.node, to - last.start);
  return range;
}

// Every open find bar's current match, by the thread that owns it: two panes can each have one open.
const current = new Map<object, Range>();

/** Highlights `owner`'s current match, or clears it (null). Where the browser has no CSS highlights, the match is only scrolled to. */
export function showFindHighlight(owner: object, range: Range | null): void {
  if (range) current.set(owner, range);
  else current.delete(owner);
  const registry = typeof CSS !== 'undefined' ? CSS?.highlights : undefined;
  if (!registry || typeof Highlight === 'undefined') return;
  if (current.size === 0) registry.delete(FIND_HIGHLIGHT);
  else registry.set(FIND_HIGHLIGHT, new Highlight(...current.values()));
}
