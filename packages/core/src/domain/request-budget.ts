/**
 * Deciding what a request may carry from REFERENCES ALONE, before a single byte
 * is read. Everything that can put stored bytes into a model request (the last
 * few tool images, a user's images and files) goes through `selectWithinBudget`:
 * each candidate comes with the size its row states, and only the survivors are
 * loaded. The real bytes are checked again after loading (`withinAfterLoad`), so
 * a row that lies about its size can't get past the caps either.
 */

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
