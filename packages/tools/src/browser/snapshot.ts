/** One part of a snapshot is at most this long, about 10,000 tokens (spec §2); a longer page comes in several parts. */
export const MAX_SNAPSHOT_CHARS = 40_000;
/** The highest part a call may ask for: four billion characters of snapshot, far past any page. */
export const MAX_SNAPSHOT_PART = 100_000;
/** The longest page text shown on a card (a ref's line) or as the title; notes and errors may run to 300. */
export const MAX_TARGET_CHARS = 200;
export const MAX_NOTE_CHARS = 300;

/**
 * The snapshot in parts of at most 40,000 characters, in order. Each part
 * ends at the last line break before the limit, and that line break belongs
 * to neither part; a part with no line break to end at is cut at the limit
 * itself, never between the two halves of a surrogate pair. Nothing else is
 * dropped. A snapshot within the limit is one part, an empty one included.
 */
export function snapshotParts(snapshot: string): string[] {
  const parts: string[] = [];
  let rest = snapshot;
  while (rest.length > MAX_SNAPSHOT_CHARS) {
    const cut = rest.lastIndexOf('\n', MAX_SNAPSHOT_CHARS);
    if (cut > 0) {
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
      continue;
    }
    let end = MAX_SNAPSHOT_CHARS;
    const last = rest.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest !== '' || parts.length === 0) parts.push(rest);
  return parts;
}

/**
 * Part `part` (from 1) of the snapshot, as the model is shown it. A snapshot
 * of more than one part ends with a note saying which part this is and, until
 * the last, how to get the next: scrolling the page never shows the rest of a
 * snapshot, so without it the model could not tell there was more. A part
 * past the end gives only how many parts there are.
 */
export function snapshotPart(snapshot: string, part: number): { snapshot: string; part: number; parts: number } | { parts: number } {
  const all = snapshotParts(snapshot);
  const parts = all.length;
  const text = all[part - 1];
  if (text === undefined) return { parts };
  if (parts === 1) return { snapshot: text, part, parts };
  const note =
    part < parts
      ? `[This is part ${part} of ${parts} of the page's snapshot. To read on, use snapshot with part ${part + 1}; scrolling does not change which part you get.]`
      : `[This is part ${part} of ${parts} of the page's snapshot: the end of the page.]`;
  return { snapshot: `${text}\n${note}`, part, parts };
}

/** Any whitespace, line and paragraph separators and NEL: a single space in page text shown outside the snapshot. */
const SPACING = /[\s\u0085\u2028\u2029]+/g;
/**
 * Characters that show nothing or reorder what is shown: C0/C1 controls and
 * DEL, soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul and
 * Khmer fillers, Mongolian free variation selectors, zero-width and bidi marks
 * (U+200B-U+200F, U+202A-U+202E), the invisible operators and bidi isolates
 * (U+2060-U+206F), the BOM and the interlinear annotation marks.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb]/g;

/**
 * Page-sourced text (a snapshot line for a ref, the title, a dialog's message)
 * that can reach an approval card or the thread, made safe to show: one line
 * (every kind of line break and tab becomes a space, runs of spaces collapse),
 * no invisible or direction-changing characters, at most `max` characters
 * (an ellipsis in the last place when cut; a surrogate pair is never split).
 * The single place this is done, so a card can't show what the page hid.
 */
export function pageText(text: string, max: number): string {
  const clean = text.replace(SPACING, ' ').replace(INVISIBLE, '').replace(SPACING, ' ').trim();
  if (clean.length <= max) return clean;
  let end = max - 1;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${clean.slice(0, end)}…`;
}

/**
 * A snapshot line is `- role "accessible name" [attr] [ref=e12] ...` and then
 * maybe `: text`. The name and the text are the page's own, so they can hold
 * anything, `[ref=e5]` included: only the attribute list between the (quoted,
 * backslash-escaped) name and the colon is Playwright's.
 *
 * When the key (role, name and attributes together) needs YAML quoting,
 * Playwright wraps all of it in single quotes with each `'` doubled
 * (`yamlEscapeKeyIfNeeded`: a name with `: `, a trailing `:`, ` #`, braces, a
 * backtick, edge whitespace, a leading `-` or `[`, ...). The name inside is
 * JSON-quoted, so its own quotes are escaped. Both shapes are read below.
 */
const LINE_HEAD = /^([A-Za-z][\w-]*)(?:\s+"(?:[^"\\]|\\.)*")?((?:\s*\[[^\]]*\])*)/;
/** A YAML single-quoted key at the start of a line, then the `:` (or the end) that follows it. */
const QUOTED_KEY = /^'((?:[^']|'')*)'(?=\s*(?::|$))/;

/**
 * The role/name/attributes part of one snapshot line (the line trimmed and
 * without its "- "), unquoted if Playwright quoted it; null for a line that
 * isn't an element. What follows the key (`:` and any text) is dropped.
 */
function lineKey(text: string): { key: string; attrs: string } | null {
  let key = text;
  if (text.startsWith("'")) {
    const quoted = QUOTED_KEY.exec(text);
    if (!quoted) return null;
    key = quoted[1]!.replace(/''/g, "'");
  }
  const head = LINE_HEAD.exec(key);
  return head ? { key: head[0], attrs: head[2]! } : null;
}

/**
 * Each element's `[ref=…]` in a snapshot -> its key (role, name, attributes),
 * cleaned by `pageText` to a single line of at most 200 characters. The first
 * line that claims a ref keeps it; a later one never overwrites it.
 */
export function refLines(snapshot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of snapshot.split('\n')) {
    const head = lineKey(line.trim().replace(/^- /, ''));
    if (!head) continue;
    const ref = /\[ref=([A-Za-z0-9]+)\]/.exec(head.attrs);
    if (ref && !out.has(ref[1]!)) out.set(ref[1]!, pageText(head.key, MAX_TARGET_CHARS));
  }
  return out;
}
