import type { ClaudeAccountRef } from '../types/claude-accounts.js';
import { MAIN_ACCOUNT_SLUG } from '../types/claude-accounts.js';
import type { PlanUsage } from '../types/usage.js';

/** Until when (ms epoch) an account is held as out of usage; null = it has room. */
export type LimitedUntil = (slug: string) => number | null;

export type AccountPick =
  | { kind: 'ok'; account: ClaudeAccountRef; pin: boolean }
  | { kind: 'missing'; slug: string };

const FIVE_HOURS = 5 * 3600_000;
const SEVEN_DAYS = 7 * 86_400_000;

function hasRoom(limitedUntil: LimitedUntil, slug: string, now: number): boolean {
  const until = limitedUntil(slug);
  return until === null || until <= now;
}

/**
 * Which account a new chat turn runs on. An explicit choice is used as is (never second-guessed); no choice means
 * main, unless main is limited, in which case the first account with room, and `pin` says to remember that choice.
 * When every account is limited the turn runs on main and fails with the normal limit error.
 */
export function pickClaudeAccount(input: { chosen: string | null; accounts: ClaudeAccountRef[]; limitedUntil: LimitedUntil; now: number }): AccountPick {
  const { chosen, accounts, limitedUntil, now } = input;
  if (chosen !== null) {
    const account = accounts.find((a) => a.slug === chosen);
    return account ? { kind: 'ok', account, pin: false } : { kind: 'missing', slug: chosen };
  }
  const main = accounts.find((a) => a.slug === MAIN_ACCOUNT_SLUG) ?? accounts[0];
  if (!main) return { kind: 'missing', slug: MAIN_ACCOUNT_SLUG };
  if (hasRoom(limitedUntil, main.slug, now)) return { kind: 'ok', account: main, pin: false };
  const other = accounts.find((a) => a.slug !== main.slug && hasRoom(limitedUntil, a.slug, now));
  return other ? { kind: 'ok', account: other, pin: true } : { kind: 'ok', account: main, pin: false };
}

/** The first account other than `current` that has room, or null. */
export function pickOtherAccount(input: { current: string; accounts: ClaudeAccountRef[]; limitedUntil: LimitedUntil; now: number }): ClaudeAccountRef | null {
  const { current, accounts, limitedUntil, now } = input;
  return accounts.find((a) => a.slug !== current && hasRoom(limitedUntil, a.slug, now)) ?? null;
}

/**
 * When to hold an account until, from a plan-usage reading: the later reset of its full 5-hour and weekly windows,
 * or null if neither is full. Per-model windows are ignored. A full window with no reset time counts from `fetchedAt`.
 */
export function limitFromUsage(usage: PlanUsage): number | null {
  let until: number | null = null;
  for (const w of usage.windows) {
    if (w.percent < 100) continue;
    let fallback: number;
    if (w.id === 'five_hour') fallback = FIVE_HOURS;
    else if (w.id === 'seven_day') fallback = SEVEN_DAYS;
    else continue;
    const t = w.resetsAt ?? usage.fetchedAt + fallback;
    if (until === null || t > until) until = t;
  }
  return until;
}

/** The message that resumes a reply cut off by a usage limit, on the account switched to. */
export function continuePrompt(from: string, to: string): string {
  return `[OtherBench] Your last reply was cut off because the Claude account "${from}" hit its usage limit. You're now running on "${to}". Carry on with the same task from where that reply stopped. Don't start over: check what's already been done (files changed, commands run) first.`;
}
