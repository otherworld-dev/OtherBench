/**
 * Deciding what a request may carry from REFERENCES ALONE, before a single byte
 * is read. Everything that can put stored bytes into a model request (the last
 * few tool images, a user's images and files) goes through `selectWithinBudget`:
 * each candidate comes with the size its row states, and only the survivors are
 * loaded. The real bytes are checked again after loading (`withinAfterLoad`), so
 * a row that lies about its size can't get past the caps either.
 */

import { cardLine } from './card-text.js';

/** All the attached files and images one request may carry together (tool images included). */
export const MAX_REQUEST_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** How many distinct attachments of a user's one request may carry; the newest are kept. */
export const MAX_REQUEST_ATTACHMENTS = 20;

/** Why a candidate was not picked, or `'load'` when it was. */
export type Verdict = 'load' | 'unknown' | 'too-large' | 'over-budget';

export interface Pick {
  /** Whatever the caller keys its candidates by (unique). */
  key: string;
  /** The size the row states; `null` = not available here (nothing is loaded); `undefined` = not known (picked by count, checked after loading). */
  size: number | null | undefined;
}

export interface BudgetLimits {
  /** At most this many are picked. */
  maxCount: number;
  /** None over this many bytes. */
  maxEach: number;
  /** All picked together within this many bytes. */
  maxTotal: number;
}

/**
 * `picks`, NEWEST FIRST, decided against the limits: a candidate is picked when
 * its size is known to be available, within `maxEach`, within what is left of
 * `maxTotal` and while fewer than `maxCount` are picked. Pure: no loader, no
 * clock. The newest are the ones kept when something has to give.
 */
export function selectWithinBudget(picks: Pick[], limits: BudgetLimits): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  let count = 0;
  let total = 0;
  for (const pick of picks) {
    if (pick.size === null) {
      out.set(pick.key, 'unknown');
      continue;
    }
    const size = pick.size ?? 0;
    if (!Number.isFinite(size) || size < 0 || size > limits.maxEach) {
      out.set(pick.key, 'too-large');
      continue;
    }
    if (count >= limits.maxCount || total + size > limits.maxTotal) {
      out.set(pick.key, 'over-budget');
      continue;
    }
    count += 1;
    total += size;
    out.set(pick.key, 'load');
  }
  return out;
}

/**
 * Why an attachment of the user's is not in a request, in the words the note
 * uses. `'not-image'` is an image part whose bytes are not a raster Grunt
 * sends; the rest are the selector's own verdicts. One table, so every engine
 * says the same thing to the model and to the user.
 */
export const OMISSION_REASONS = {
  'too-large': 'too large to send',
  'over-budget': 'this request already carries as much attached data as it can',
  unknown: 'it is not available in this chat',
  'not-image': 'not a PNG, JPEG, GIF or WebP image',
} as const;
export type Omission = keyof typeof OMISSION_REASONS;

/** The longest file name a note carries. */
const NOTE_NAME_MAX = 80;

/**
 * A file name as it may appear inside a note: one line, no control or hidden
 * character, at most 80 characters (`cardLine`), and without the quote and
 * square brackets the note itself is written with, so a name can't end the
 * note early or pass for one. Empty when there is nothing left to show.
 */
function noteName(filename: unknown): string {
  return cardLine(filename, NOTE_NAME_MAX).replace(/"/g, "'").replace(/\[/g, '(').replace(/\]/g, ')');
}

/**
 * The text that stands in a request where an attachment was left out. A file
 * left out for a cap (`'too-large'`, `'over-budget'`) is named when the part
 * gave a usable name, so the model can tell the user which one; the other
 * reasons never name it.
 */
export function omissionNote(why: Omission, filename?: unknown): string {
  const kind = why === 'not-image' ? 'image' : 'attachment';
  const name = why === 'too-large' || why === 'over-budget' ? noteName(filename) : '';
  return name.length > 0 ? `[${kind} "${name}" omitted: ${OMISSION_REASONS[why]}]` : `[${kind} omitted: ${OMISSION_REASONS[why]}]`;
}

export const ATTACHMENT_TOO_LARGE_NOTE = omissionNote('too-large');
export const ATTACHMENT_BUDGET_NOTE = omissionNote('over-budget');
export const ATTACHMENT_UNAVAILABLE_NOTE = omissionNote('unknown');
export const IMAGE_UNSUPPORTED_NOTE = omissionNote('not-image');

/** What has really been loaded so far, for the check after loading. */
export interface Loaded {
  bytes: number;
}

/**
 * Whether a loaded file still fits: within `maxEach` and, with what is already
 * `loaded`, within `maxTotal`. When it does, it is counted. This is the second
 * look at the real size, for a row that stated a smaller one.
 */
export function withinAfterLoad(length: number, loaded: Loaded, limits: BudgetLimits): boolean {
  if (length > limits.maxEach || loaded.bytes + length > limits.maxTotal) return false;
  loaded.bytes += length;
  return true;
}
