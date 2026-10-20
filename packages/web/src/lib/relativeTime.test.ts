import { describe, expect, it } from 'vitest';
import { formatAge, formatRelativeTime, formatStamp } from './relativeTime.js';

describe('formatStamp', () => {
  const now = new Date(2026, 9, 21, 15, 30).getTime();
  const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  it('is the clock alone for a time today', () => {
    const at = new Date(2026, 9, 21, 9, 5).getTime();
    expect(formatStamp(at, now)).toBe(clock(at));
  });

  it('adds the day and month for an earlier day this year', () => {
    const at = new Date(2026, 9, 20, 23, 59).getTime();
    expect(formatStamp(at, now)).toBe(`${new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock(at)}`);
  });

  it('adds the year for a time in another year', () => {
    const at = new Date(2025, 0, 2, 8, 0).getTime();
    expect(formatStamp(at, now)).toBe(`${new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} ${clock(at)}`);
  });
});

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000;

  it('says "just now" under a minute, and for a time in the future', () => {
    expect(formatRelativeTime(now - 59_000, now)).toBe('just now');
    expect(formatRelativeTime(now + 5_000, now)).toBe('just now');
  });

  it('counts whole minutes, then whole hours', () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe('1 min ago');
    expect(formatRelativeTime(now - (59 * 60_000 + 59_000), now)).toBe('59 min ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
  });

  it('falls back to the date after a day', () => {
    expect(formatRelativeTime(now - 25 * 3_600_000, now)).toBe(new Date(now - 25 * 3_600_000).toLocaleString());
  });
});

describe('formatAge', () => {
  const now = 1_700_000_000_000;
  const day = 24 * 3_600_000;

  it('says "now" under a minute, and for a time in the future', () => {
    expect(formatAge(now - 59_000, now)).toBe('now');
    expect(formatAge(now + 5_000, now)).toBe('now');
  });

  it('counts whole minutes, hours and days', () => {
    expect(formatAge(now - 60_000, now)).toBe('1m');
    expect(formatAge(now - 59 * 60_000, now)).toBe('59m');
    expect(formatAge(now - 3_600_000, now)).toBe('1h');
    expect(formatAge(now - 23 * 3_600_000, now)).toBe('23h');
    expect(formatAge(now - day, now)).toBe('1d');
    expect(formatAge(now - 6 * day, now)).toBe('6d');
  });

  it('then weeks, months and years', () => {
    expect(formatAge(now - 7 * day, now)).toBe('1w');
    expect(formatAge(now - 29 * day, now)).toBe('4w');
    expect(formatAge(now - 30 * day, now)).toBe('1mo');
    expect(formatAge(now - 364 * day, now)).toBe('12mo');
    expect(formatAge(now - 365 * day, now)).toBe('1y');
    expect(formatAge(now - 3 * 365 * day, now)).toBe('3y');
  });
});
