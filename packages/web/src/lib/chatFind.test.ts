import { describe, expect, it } from 'vitest';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import { findMatches, firstMatchFrom, isFindShortcut, markdownText, matchOffsets, messageFindText, stepMatch } from './chatFind.js';

function msg(id: string, role: 'user' | 'assistant', parts: Part[]): CanonMessage {
  return { id, chatId: 'c1', parentId: null, role, parts, status: 'complete', error: null, producedBy: null, createdAt: 0 };
}
const text = (t: string): Part => ({ type: 'text', text: t });

describe('matchOffsets', () => {
  it('finds every occurrence, ignoring case', () => {
    expect(matchOffsets('Apple pie, apple tart, APPLE', 'apple')).toEqual([0, 11, 23]);
  });

  it('takes the query literally, not as a pattern', () => {
    expect(matchOffsets('a.b axb (c) [d]', '.')).toEqual([1]);
    expect(matchOffsets('a.b axb (c) [d]', '(c)')).toEqual([8]);
  });

  it('never overlaps, as a browser does', () => {
    expect(matchOffsets('aaaa', 'aa')).toEqual([0, 2]);
  });

  it('finds nothing for an empty query', () => {
    expect(matchOffsets('anything', '')).toEqual([]);
  });
});

describe('markdownText', () => {
  it('drops the markup and keeps the words', () => {
    expect(markdownText('**bold** and _soft_ and `code`')).toBe('bold and soft and code');
  });

  it("keeps a link's words but not its address, and no image at all", () => {
    expect(markdownText('see [the docs](https://example.com/secret-path) ![a cat](cat.png)')).toBe('see the docs ');
  });

  it('puts a line between blocks, so words in two paragraphs never run together', () => {
    expect(markdownText('# Title\n\nfirst\n\n- one\n- two')).toBe('Title\nfirst\none\ntwo');
  });

  it("keeps a code block's code without its fence", () => {
    expect(markdownText('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('reads GFM tables and strikethrough, a cell never running into the next', () => {
    expect(markdownText('~~gone~~')).toBe('gone');
    const table = markdownText('| a | b |\n|---|---|\n| c | d |');
    expect(table).not.toContain('|');
    expect(table).not.toContain('---');
    expect(matchOffsets(table, 'c')).toHaveLength(1);
    expect(matchOffsets(table, 'c d')).toHaveLength(0);
  });

  it('drops quote marks, list markers, task boxes, rules and heading hashes', () => {
    expect(markdownText('> quoted\n> > deeper\n\n1. first\n- [x] done\n\n---\n\n## Section ##')).toBe('quoted\ndeeper\nfirst\ndone\nSection');
  });

  it('leaves what only looks like markup: a lone star, snake_case, code, escapes', () => {
    expect(markdownText('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(markdownText('call snake_case_name now')).toBe('call snake_case_name now');
    expect(markdownText('run `a*b*c` and `` x `y` ``')).toBe('run a*b*c and x `y`');
    expect(markdownText('\\*not emphasis\\*')).toBe('*not emphasis*');
  });

  it('keeps a code block whole, markup and all, until its fence closes', () => {
    expect(markdownText('~~~\n# not a heading\n**kept**\n~~~\nafter')).toBe('# not a heading\n**kept**\nafter');
  });

  it('shows an autolink as its address, keeps HTML as the text it shows as, and decodes entities', () => {
    expect(markdownText('see <https://example.com> or https://bare.example')).toBe('see https://example.com or https://bare.example');
    // MarkdownBody has no raw HTML: react-markdown shows a tag as its text.
    expect(markdownText('a<br>b &amp; c &lt;d&gt;')).toBe('a<br>b & c <d>');
  });

  it('is quick enough to run on every key in a long chat', () => {
    const reply = `${'Some **text** with \`code\` and a [link](https://x.y) to fill the line.\n\n'.repeat(12)}${'```ts\nconst a = 1;\n```\n\n- one\n- two\n\n| a | b |\n|---|---|\n| c | d |\n\n'.repeat(3)}`;
    const started = performance.now();
    for (let i = 0; i < 300; i++) markdownText(reply + i);
    // micromark took about 600ms here; a key press has to stay well under a frame or two.
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('messageFindText', () => {
  it("is a user message's text as it is shown, markup and all", () => {
    expect(messageFindText(msg('u', 'user', [text('**not bold**'), text('second')]))).toBe('**not bold**\nsecond');
  });

  it("is a reply's text parts as rendered, never its tools or reasoning", () => {
    const reply = msg('a', 'assistant', [
      { type: 'reasoning', text: 'thinking about needle' },
      text('Here is **the** answer'),
      { type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'needle.txt' } },
      { type: 'tool-result', id: 't1', name: 'read_file', result: '{"needle":true}', isError: false },
      text('and more'),
    ]);
    expect(messageFindText(reply)).toBe('Here is the answer\nand more');
  });

  it('is empty for a context line (/clear, /compact), which shows no message text', () => {
    expect(messageFindText(msg('c', 'user', [{ type: 'context', kind: 'clear' }]))).toBe('');
  });
});

describe('findMatches', () => {
  const chat = [
    msg('u1', 'user', [text('where is the needle?')]),
    msg('a1', 'assistant', [text('The **needle** is in the haystack. Another needle too.')]),
    msg('u2', 'user', [text('thanks')]),
  ];

  it('lists every match in thread order, with its message and place', () => {
    expect(findMatches(chat, 'NEEDLE')).toEqual([
      { messageId: 'u1', index: 0, occurrence: 0, start: 13 },
      { messageId: 'a1', index: 1, occurrence: 0, start: 4 },
      { messageId: 'a1', index: 1, occurrence: 1, start: 39 },
    ]);
  });

  it('finds nothing for an empty query', () => {
    expect(findMatches(chat, '')).toEqual([]);
  });
});

describe('firstMatchFrom', () => {
  const matches = [0, 3, 3, 7].map((index, i) => ({ messageId: `m${index}`, index, occurrence: i, start: 0 }));

  it('picks the first match at or after a message', () => {
    expect(firstMatchFrom(matches, 3)).toBe(1);
    expect(firstMatchFrom(matches, 4)).toBe(3);
  });

  it('wraps to the first match when none comes after', () => {
    expect(firstMatchFrom(matches, 8)).toBe(0);
  });

  it('is -1 with no matches', () => {
    expect(firstMatchFrom([], 0)).toBe(-1);
  });
});

describe('stepMatch', () => {
  it('moves on and back, wrapping at either end', () => {
    expect(stepMatch(3, 0, 1)).toBe(1);
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
  });

  it('starts at the first match going on, or the last going back, when none is current', () => {
    expect(stepMatch(3, -1, 1)).toBe(0);
    expect(stepMatch(3, -1, -1)).toBe(2);
  });
});

describe('isFindShortcut', () => {
  const key = (over: Partial<{ key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
    key: 'f',
    code: 'KeyF',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it('is Ctrl+F off a Mac, and Cmd+F on one', () => {
    expect(isFindShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isFindShortcut(key({ metaKey: true }), true)).toBe(true);
    // Ctrl+F on a Mac moves the cursor in a text box; it stays that.
    expect(isFindShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isFindShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it('is not F with Shift or Alt too, or F alone', () => {
    expect(isFindShortcut(key({ ctrlKey: true, shiftKey: true, key: 'F' }), false)).toBe(false);
    expect(isFindShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isFindShortcut(key({}), false)).toBe(false);
  });

  it('follows the letter on a Latin layout, and the key on any other', () => {
    expect(isFindShortcut(key({ ctrlKey: true, key: 'F' }), false)).toBe(true);
    // Dvorak: the F key types "u", and Ctrl+U is not find.
    expect(isFindShortcut(key({ ctrlKey: true, key: 'u' }), false)).toBe(false);
    // Russian: the F key types "а".
    expect(isFindShortcut(key({ ctrlKey: true, key: 'а' }), false)).toBe(true);
  });
});
