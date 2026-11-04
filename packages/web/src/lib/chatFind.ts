import { contextLineOf } from '@otherbench/core/domain/context-lines.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';

/**
 * Find in a chat (Ctrl+F in a chat pane). The thread draws only its last messages (`THREAD_WINDOW`), so the browser's
 * own find can't reach the rest; this searches the messages the store holds, which is every one of the chat's (the
 * chat's whole tree comes with it). It searches what the thread shows as message text: a user message's text as
 * typed, and a reply's text parts as rendered, without their Markdown. Tool calls and results, reasoning and the
 * cards are left out, so raw tool JSON never matches.
 */

/** One match: the message it's in, that message's place in the thread, which match it is in that message, and where its text starts. */
export interface FindMatch {
  messageId: string;
  index: number;
  occurrence: number;
  start: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where `query` starts in `text`, ignoring case, matches never overlapping. A regular expression rather than
 * `toLowerCase`: lower-casing can change a string's length (İ), which would put every offset after it out.
 */
export function matchOffsets(text: string, query: string): number[] {
  if (query.length === 0) return [];
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(escapeRegExp(query), 'giu'))) out.push(m.index);
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** One line of a paragraph, heading, list item or cell, as rendered: links by their words, no image, no emphasis marks. */
function inlineText(line: string): string {
  // Code spans keep everything in them, so they're set aside first; so are escaped characters, which show as themselves.
  const kept: string[] = [];
  const keep = (text: string): string => `${kept.push(text) - 1}`;
  const s = line
    .replace(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (_, _run, code: string) => keep(/^ .*[^ ].* $/.test(code) ? code.slice(1, -1) : code))
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => keep(c))
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\[[^\]]*\]/g, (_, a: string | undefined, b: string | undefined) => a ?? b ?? '')
    .replace(/<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/g, '$1')
    // Emphasis marks touch a word; a star with spaces round it, or an underscore inside one (snake_case), is text.
    .replace(/\*+(?=\S)|(?<=\S)\*+/g, '')
    .replace(/(?<![\p{L}\p{N}])_+(?=\S)|(?<=\S)_+(?![\p{L}\p{N}])/gu, '')
    .replace(/~~(?=\S)|(?<=\S)~~/g, '')
    .replace(/\\$/, '');
  return decodeEntities(s).replace(/(\d+)/g, (_, i: string) => kept[Number(i)] ?? '');
}

/**
 * Markdown as the words a reader sees once `MarkdownBody` has rendered it, its blocks a line apart so words from two
 * never run together. Worked out line by line rather than with a Markdown parser: micromark took about 2ms a reply,
 * the better part of a second on the first key in a long chat. Close enough is enough here: a match the page shows
 * differently is still found and scrolled to, only its highlight can land on another match in the same message.
 * Raw HTML stays as written, as react-markdown shows it as text.
 */
export function markdownText(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,}) *$/.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      else out.push(line);
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (open) {
      fence = open;
      continue;
    }
    // Rules, setext underlines and a table's delimiter row show no text.
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line) || /^ {0,3}=+ *$/.test(line) || /^ *\|?( *:?-+:? *\|)+( *:?-+:? *)?\|? *$/.test(line)) continue;
    let s = line.replace(/^(?: {0,3}> ?)+/, '').replace(/^ *(?:[-*+]|\d{1,9}[.)]) +(?:\[[ xX]\] +)?/, '');
    const heading = /^ {0,3}#{1,6}(?: +|$)/.exec(s);
    if (heading) s = s.slice(heading[0].length).replace(/ +#+ *$/, '');
    const cells = s.trimStart().startsWith('|') ? s.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()) : [s];
    for (const cell of cells) {
      const text = inlineText(cell);
      if (text.trim().length > 0) out.push(text);
    }
  }
  return out.join('\n');
}

// A message's text is worked out once per version of it: the store replaces a message when it changes, so a reply
// streaming in is read again and the rest of the chat isn't.
const textCache = new WeakMap<CanonMessage, string>();

/** The text find searches in one message, its text parts a line apart. */
export function messageFindText(message: CanonMessage): string {
  const cached = textCache.get(message);
  if (cached !== undefined) return cached;
  let text = '';
  if (message.role === 'user') {
    // As typed, joined exactly as Message joins it for UserText, so a match's offset says whether it's past the fold.
    if (!contextLineOf(message)) text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  } else {
    text = message.parts.flatMap((p) => (p.type === 'text' ? [markdownText(p.text)] : [])).join('\n');
  }
  textCache.set(message, text);
  return text;
}

/** Every match of `query` in `messages` (the thread, oldest first), in order. */
export function findMatches(messages: readonly CanonMessage[], query: string): FindMatch[] {
  if (query.length === 0) return [];
  const out: FindMatch[] = [];
  messages.forEach((m, index) => {
    matchOffsets(messageFindText(m), query).forEach((start, occurrence) => out.push({ messageId: m.id, index, occurrence, start }));
  });
  return out;
}

/** The first match in or after the message at `fromIndex`, else the first of all (a browser's find wraps too); -1 for none. */
export function firstMatchFrom(matches: readonly FindMatch[], fromIndex: number): number {
  if (matches.length === 0) return -1;
  const at = matches.findIndex((m) => m.index >= fromIndex);
  return at === -1 ? 0 : at;
}

/** The match `delta` on from `current` (-1 for none yet), wrapping round. */
export function stepMatch(count: number, current: number, delta: 1 | -1): number {
  if (current === -1) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** Ctrl+F, or Cmd+F on a Mac, where Ctrl+F moves the cursor in a text box. By the letter on a Latin layout, else by the key. */
export function isFindShortcut(
  e: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  mac: boolean
): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false;
  return /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === 'f' : e.code === 'KeyF';
}

/** Whether this is a Mac (or an iPad), for the find key. */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
