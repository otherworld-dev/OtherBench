/**
 * Text that reaches a card, a banner or a summary from somewhere OtherBench doesn't
 * control (a web page, a window title, a program's path, what the model wants
 * to type). React escapes markup; these strip or spell out what escaping
 * can't: characters that hide, reorder or break up what is shown.
 *
 * Pure (no Node imports): the broker, the tools and the web all use it, and
 * there is one table, here.
 */

/**
 * Control characters, line breaks, and the bidi, zero-width, tag, variation-selector
 * and Hangul-filler marks that can make text read differently from what it is.
 * Written as code point ranges so no invisible character sits in this source.
 */
const RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];
for (const range of RANGES) Object.freeze(range);
export const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = Object.freeze(RANGES);

/** True for a code point in `HIDDEN_RANGES`. */
export function isHiddenCodePoint(codePoint: number): boolean {
  for (const [from, to] of HIDDEN_RANGES) {
    if (codePoint >= from && codePoint <= to) return true;
  }
  return false;
}

/** Half of a surrogate pair on its own: text no encoder can write down. */
function isLoneSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

/** Hidden characters that stand for a gap between words, so they read as one space instead of vanishing. */
function isBreak(codePoint: number): boolean {
  return (codePoint >= 0x0009 && codePoint <= 0x000d) || codePoint === 0x0085 || codePoint === 0x2028 || codePoint === 0x2029;
}

const ELLIPSIS = String.fromCodePoint(0x2026);

const spell = (codePoint: number): string => `<U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`;

/**
 * Lower case for A to Z only. Names OtherBench compares (a program's file name, a
 * key's name, a signer) are folded with this and nothing else, so the result
 * never depends on a runtime's Unicode tables and never makes two different
 * names one (as full lower-casing does for the Kelvin sign and `k`).
 */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Whether `text` is a string every character of which can be written down (no lone surrogate). */
export function isWellFormedText(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  for (const ch of text) {
    if (isLoneSurrogate(ch.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/** Whether `text` has a hidden character, a lone surrogate or U+FFFD (what a broken decode leaves behind). */
export function hasHiddenCharacter(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isHiddenCodePoint(cp) || isLoneSurrogate(cp) || cp === 0xfffd) return true;
  }
  return false;
}

/**
 * Untrusted text as one plain line of at most `max` characters: hidden
 * characters go, line breaks and runs of whitespace become one space, and a
 * longer line is cut (by code point, never through a surrogate pair) and ends
 * in an ellipsis. Anything that isn't a string is the empty line.
 */
export function cardLine(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  const limit = max === Number.POSITIVE_INFINITY ? max : Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  let line = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isBreak(cp)) line += ' ';
    else if (!isHiddenCodePoint(cp) && !isLoneSurrogate(cp)) line += ch;
  }
  line = line.replace(/\s+/g, ' ').trim();
  const points = Array.from(line);
  return points.length > limit ? `${points.slice(0, limit).join('').trimEnd()}${ELLIPSIS}` : line;
}

/**
 * Text the model will type, shown in full: line breaks and tabs stay, every other
 * hidden or bidi character (and a lone surrogate) is spelled out as `<U+202E>` so
 * the card says what will really be typed rather than hiding it or letting it
 * reorder the text.
 */
export function revealHidden(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out += ch === '\n' || ch === '\t' || !(isHiddenCodePoint(cp) || isLoneSurrogate(cp)) ? ch : spell(cp);
  }
  return out;
}

/** As `revealHidden`, for text that should be one line (a path, a key): line breaks, tabs and U+FFFD are spelled out too. */
export function revealAllHidden(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isHiddenCodePoint(cp) || isLoneSurrogate(cp) || cp === 0xfffd ? spell(cp) : ch;
  }
  return out;
}
