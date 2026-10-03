import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relativeTime.js';

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
