/** A snapshot this long is about 10,000 tokens: anything past it is cut (spec §2). */
export const MAX_SNAPSHOT_CHARS = 40_000;
/** The longest page text shown on a card (a ref's line) or as the title; notes and errors may run to 300. */
export const MAX_TARGET_CHARS = 200;
export const MAX_NOTE_CHARS = 300;
const CUT_NOTE = '[The rest of the page was cut: its snapshot is longer than 40,000 characters.]';

/** The snapshot, cut at the last line break before 40,000 characters, with a note saying so. */
export function cutSnapshot(snapshot: string): { snapshot: string; truncated: boolean } {
  if (snapshot.length <= MAX_SNAPSHOT_CHARS) return { snapshot, truncated: false };
  const cut = snapshot.lastIndexOf('\n', MAX_SNAPSHOT_CHARS);
  return { snapshot: `${snapshot.slice(0, cut > 0 ? cut : MAX_SNAPSHOT_CHARS)}\n${CUT_NOTE}`, truncated: true };
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
 */
const LINE_HEAD = /^([A-Za-z][\w-]*)(?:\s+"(?:[^"\\]|\\.)*")?((?:\s*\[[^\]]*\])*)/;

/**
 * Each element's `[ref=…]` in a snapshot -> its line, trimmed, without the
 * leading "- ", at most 200 characters. The first line that claims a ref keeps
 * it; a later one never overwrites it.
 */
export function refLines(snapshot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of snapshot.split('\n')) {
    const text = line.trim().replace(/^- /, '');
    const head = LINE_HEAD.exec(text);
    if (!head) continue;
    const ref = /\[ref=([A-Za-z0-9]+)\]/.exec(head[2]!);
    if (ref && !out.has(ref[1]!)) out.set(ref[1]!, pageText(text, MAX_TARGET_CHARS));
  }
  return out;
}
