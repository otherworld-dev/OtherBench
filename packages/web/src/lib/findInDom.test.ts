import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIND_HIGHLIGHT, findRoots, locateMatch, showFindHighlight } from './findInDom.js';

function html(markup: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = markup;
  document.body.append(div);
  return div;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('locateMatch', () => {
  it('spans a match split across elements', () => {
    const root = html('<p>The <strong>nee</strong>dle is here</p>');
    expect(locateMatch([root], 'NEEDLE', 0)?.toString()).toBe('needle');
  });

  it('takes the match asked for, and the last when the page shows fewer', () => {
    const root = html('<p>one a, two a</p>');
    const second = locateMatch([root], 'a', 1)!;
    expect(second.startOffset).toBe(11);
    expect(locateMatch([root], 'a', 5)!.startOffset).toBe(11);
  });

  it('is null when the text is not there', () => {
    expect(locateMatch([html('<p>nothing</p>')], 'needle', 0)).toBeNull();
  });

  it('skips the Copy buttons and other controls marked as not text', () => {
    const root = html('<button data-copy-chrome>Copy</button><p>copy this</p><span data-find-skip><button>Show all</button></span>');
    const range = locateMatch([root], 'copy', 0)!;
    expect(range.startContainer.parentElement?.tagName).toBe('P');
    expect(locateMatch([root], 'show all', 0)).toBeNull();
  });

  it('counts across several roots in order, a line apart', () => {
    const a = html('<p>x</p>');
    const b = html('<p>x</p>');
    expect(locateMatch([a, b], 'x', 1)!.startContainer.parentElement?.parentElement).toBe(b);
    expect(locateMatch([a, b], 'x\nx', 0)).not.toBeNull();
  });
});

describe('findRoots', () => {
  it("is a user message's body", () => {
    const article = html('<article data-role="user"><div data-message-header>You</div><div data-message-body>hello</div></article>').firstElementChild!;
    expect(findRoots(article)).toEqual([article.querySelector('[data-message-body]')]);
  });

  it("is a reply's own text blocks, not a helper's text inside a card", () => {
    const article = html(
      '<article data-role="assistant"><div data-message-body><div class="markdown-body">one</div><details><div class="markdown-body">helper</div></details><div class="markdown-body">two</div></div></article>'
    ).firstElementChild!;
    expect(findRoots(article).map((el) => el.textContent)).toEqual(['one', 'two']);
  });
});

describe('showFindHighlight', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows each open find bar’s current match, and clears it', () => {
    const registry = new Map<string, { ranges: Range[] }>();
    vi.stubGlobal('CSS', { highlights: registry });
    vi.stubGlobal(
      'Highlight',
      class {
        ranges: Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      }
    );
    const a = {};
    const b = {};
    const r1 = document.createRange();
    const r2 = document.createRange();
    showFindHighlight(a, r1);
    showFindHighlight(b, r2);
    expect(registry.get(FIND_HIGHLIGHT)?.ranges).toEqual([r1, r2]);
    showFindHighlight(a, null);
    expect(registry.get(FIND_HIGHLIGHT)?.ranges).toEqual([r2]);
    showFindHighlight(b, null);
    expect(registry.has(FIND_HIGHLIGHT)).toBe(false);
  });

  it('does nothing where the browser has no highlights', () => {
    vi.stubGlobal('CSS', undefined);
    expect(() => showFindHighlight({}, document.createRange())).not.toThrow();
  });
});
