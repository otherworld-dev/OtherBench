/** A snapshot this long is about 10,000 tokens: anything past it is cut (spec §2). */
export const MAX_SNAPSHOT_CHARS = 40_000;
const CUT_NOTE = '[The rest of the page was cut: its snapshot is longer than 40,000 characters.]';

/** The snapshot, cut at the last line break before 40,000 characters, with a note saying so. */
export function cutSnapshot(snapshot: string): { snapshot: string; truncated: boolean } {
  if (snapshot.length <= MAX_SNAPSHOT_CHARS) return { snapshot, truncated: false };
  const cut = snapshot.lastIndexOf('\n', MAX_SNAPSHOT_CHARS);
  return { snapshot: `${snapshot.slice(0, cut > 0 ? cut : MAX_SNAPSHOT_CHARS)}\n${CUT_NOTE}`, truncated: true };
}

/** Each `[ref=…]` in a snapshot -> its line, trimmed, without the leading "- ", at most 200 characters. */
export function refLines(snapshot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of snapshot.split('\n')) {
    const m = /\[ref=([A-Za-z0-9]+)\]/.exec(line);
    if (m) out.set(m[1]!, line.trim().replace(/^- /, '').slice(0, 200));
  }
  return out;
}
