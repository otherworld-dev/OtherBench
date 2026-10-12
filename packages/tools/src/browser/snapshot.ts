/** A snapshot this long is about 10,000 tokens: anything past it is cut (spec §2). */
export const MAX_SNAPSHOT_CHARS = 40_000;
const CUT_NOTE = '[The rest of the page was cut: its snapshot is longer than 40,000 characters.]';

/** The snapshot, cut at the last line break before 40,000 characters, with a note saying so. */
export function cutSnapshot(snapshot: string): { snapshot: string; truncated: boolean } {
  if (snapshot.length <= MAX_SNAPSHOT_CHARS) return { snapshot, truncated: false };
  const cut = snapshot.lastIndexOf('\n', MAX_SNAPSHOT_CHARS);
  return { snapshot: `${snapshot.slice(0, cut > 0 ? cut : MAX_SNAPSHOT_CHARS)}\n${CUT_NOTE}`, truncated: true };
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
    if (ref && !out.has(ref[1]!)) out.set(ref[1]!, text.slice(0, 200));
  }
  return out;
}
