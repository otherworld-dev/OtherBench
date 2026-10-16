import { HIDDEN_RANGES, revealHidden } from '@otherbench/core/domain/card-text.js';

/**
 * The hidden-character table and `revealHidden` live in core (domain/card-text.ts):
 * one table for every card, the browser's and computer use's alike.
 */
export { HIDDEN_RANGES, revealHidden };

const hex = (n: number): string => `\\u{${n.toString(16)}}`;
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('')}]+`, 'gu');
/** A run that was whitespace or a line break reads as a space; anything else vanishes. */
const WHITESPACE_RUN = new RegExp(`[\\t\\n\\r${hex(0x2028)}${hex(0x2029)}]`, 'u');
const LINE_BREAK = new RegExp(`\\r\\n|[\\n\\r${hex(0x2028)}${hex(0x2029)}]`, 'u');

/** Page-derived text (the title, the address) as one plain line: React escapes it, this strips what escaping can't. */
export function oneLine(text: unknown): string {
  return typeof text === 'string' ? text.replace(HIDDEN, (m) => (WHITESPACE_RUN.test(m) ? ' ' : '')).replace(/\s+/g, ' ').trim() : '';
}

/**
 * A page snapshot for display: each line sanitised the way `oneLine` does, with
 * the line breaks and indentation kept. Display only: the model saw the raw text.
 */
export function displayLines(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text
    .split(LINE_BREAK)
    .map((line) => line.replace(HIDDEN, (m) => (m.includes('\t') ? ' ' : '')).trimEnd())
    .join('\n');
}

/** How the thread shows a `browser` call (spec 2026-10-12-model-browser-design §6): `open https://…`, `click e12`, ... */
export function browserCallLabel(args: unknown): string {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const s = (key: string): string => oneLine(a[key]);
  switch (a['command']) {
    case 'open':
      return `open ${s('url')}`;
    case 'click':
      return `${a['double'] === true ? 'double-click' : 'click'} ${s('ref')}`;
    case 'type':
      return `type into ${s('ref')}`;
    case 'select':
      return `select in ${s('ref')}`;
    case 'press':
      return `press ${s('key')}`;
    case 'scroll':
      return `scroll ${s('direction') || 'down'}${s('ref') ? ` to ${s('ref')}` : ''}`;
    default:
      return typeof a['command'] === 'string' ? oneLine(a['command']) || '?' : '?';
  }
}

export interface BrowserPage {
  url: string;
  title: string;
  snapshot: string;
}

/** A browser result's page (from the object, or its JSON text as the Mock and Claude Code report it), or null. */
export function browserPageOf(result: unknown): BrowserPage | null {
  let value = result;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  return typeof r['url'] === 'string' && typeof r['title'] === 'string' && typeof r['snapshot'] === 'string'
    ? { url: r['url'], title: r['title'], snapshot: r['snapshot'] }
    : null;
}
