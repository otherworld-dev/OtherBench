import { describe, expect, it } from 'vitest';
import { MAIN_ACCOUNT, accountSlug, claudeBackend, isClaudeLogin, type ClaudeAccountRef } from '../src/types/claude-accounts.js';
import { continuePrompt, limitFromUsage, pickClaudeAccount, pickOtherAccount } from '../src/domain/claude-accounts.js';
import type { PlanUsage } from '../src/types/usage.js';

const MAIN = MAIN_ACCOUNT;
const VH: ClaudeAccountRef = { slug: 'vh', name: 'VH', configDir: '/cfg/vh' };
const accounts = [MAIN, VH];
const now = 1_000_000;
const free = () => null;
const limited = (until: Record<string, number>) => (slug: string) => until[slug] ?? null;

describe('accountSlug', () => {
  it('lower-cases, collapses runs of other characters and trims dashes', () => {
    expect(accountSlug('My VH!')).toBe('my-vh');
    expect(accountSlug('  Main ')).toBe('main');
  });
});

describe('claudeBackend / isClaudeLogin', () => {
  it('names the login backend', () => {
    expect(claudeBackend(MAIN_ACCOUNT)).toBe('claude');
    expect(claudeBackend(undefined)).toBe('claude');
    expect(claudeBackend(null)).toBe('claude');
    expect(claudeBackend(VH)).toBe('claude:vh');
  });
  it('recognises login backends', () => {
    expect(isClaudeLogin('claude')).toBe(true);
    expect(isClaudeLogin('claude:vh')).toBe(true);
    expect(isClaudeLogin('http://localhost:11434')).toBe(false);
  });
});

describe('pickClaudeAccount', () => {
  it('uses main when nothing is limited', () => {
    expect(pickClaudeAccount({ chosen: null, accounts, limitedUntil: free, now })).toEqual({ kind: 'ok', account: MAIN, pin: false });
  });
  it('pins to another account when main is limited', () => {
    expect(pickClaudeAccount({ chosen: null, accounts, limitedUntil: limited({ main: now + 1000 }), now })).toEqual({ kind: 'ok', account: VH, pin: true });
  });
  it('ignores an expired limit', () => {
    expect(pickClaudeAccount({ chosen: null, accounts, limitedUntil: limited({ main: now - 1 }), now })).toEqual({ kind: 'ok', account: MAIN, pin: false });
  });
  it('falls back to main when every account is limited', () => {
    expect(pickClaudeAccount({ chosen: null, accounts, limitedUntil: limited({ main: now + 1000, vh: now + 1000 }), now })).toEqual({ kind: 'ok', account: MAIN, pin: false });
  });
  it('never second-guesses an explicit choice', () => {
    expect(pickClaudeAccount({ chosen: 'vh', accounts, limitedUntil: limited({ vh: now + 1000 }), now })).toEqual({ kind: 'ok', account: VH, pin: false });
  });
  it('reports a chosen account that no longer exists', () => {
    expect(pickClaudeAccount({ chosen: 'gone', accounts, limitedUntil: free, now })).toEqual({ kind: 'missing', slug: 'gone' });
  });
});

describe('pickOtherAccount', () => {
  it('returns a free other account', () => {
    expect(pickOtherAccount({ current: 'main', accounts, limitedUntil: free, now })).toEqual(VH);
    expect(pickOtherAccount({ current: 'vh', accounts, limitedUntil: free, now })).toEqual(MAIN);
  });
  it('returns null when the others are limited', () => {
    expect(pickOtherAccount({ current: 'main', accounts, limitedUntil: limited({ vh: now + 1000 }), now })).toBeNull();
  });
});

describe('limitFromUsage', () => {
  const usage = (windows: { id: string; percent: number; resetsAt: number | null }[]): PlanUsage => ({
    windows: windows.map((w) => ({ ...w, label: w.id })),
    fetchedAt: 5000,
  });
  it('holds until a full five-hour window resets', () => {
    expect(limitFromUsage(usage([{ id: 'five_hour', percent: 100, resetsAt: 9000 }]))).toBe(9000);
  });
  it('ignores per-model windows', () => {
    expect(limitFromUsage(usage([{ id: 'seven_day_opus', percent: 100, resetsAt: 9000 }]))).toBeNull();
  });
  it('takes the later of two full windows', () => {
    expect(limitFromUsage(usage([{ id: 'five_hour', percent: 100, resetsAt: 9000 }, { id: 'seven_day', percent: 100, resetsAt: 20000 }]))).toBe(20000);
  });
  it('is null when nothing is full', () => {
    expect(limitFromUsage(usage([{ id: 'five_hour', percent: 99, resetsAt: 9000 }, { id: 'seven_day', percent: 10, resetsAt: 20000 }]))).toBeNull();
  });
  it('falls back from fetchedAt when a full window has no reset time', () => {
    expect(limitFromUsage(usage([{ id: 'five_hour', percent: 100, resetsAt: null }]))).toBe(5000 + 5 * 3600_000);
    expect(limitFromUsage(usage([{ id: 'seven_day', percent: 100, resetsAt: null }]))).toBe(5000 + 7 * 86_400_000);
  });
});

describe('continuePrompt', () => {
  it('names both accounts and says not to start over', () => {
    const p = continuePrompt('Main', 'VH');
    expect(p).toContain('Main');
    expect(p).toContain('VH');
    expect(p).toContain("Don't start over");
  });
});
