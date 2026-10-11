import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  getSidebarWidth,
  initSidebarWidth,
  resetSidebarWidthForTests,
  setSidebarWidth,
} from './sidebarWidth.js';

beforeEach(() => {
  window.localStorage.clear();
  resetSidebarWidthForTests();
});
afterEach(() => vi.restoreAllMocks());

describe('sidebarWidth', () => {
  it('defaults to 16.25rem with nothing stored', () => {
    expect(getSidebarWidth()).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it('reads a stored width in range', () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '20');
    expect(getSidebarWidth()).toBe(20);
  });

  it.each(['', 'wide', '5', '99', 'NaN'])('falls back to the default for a stored %j', (raw) => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, raw);
    expect(getSidebarWidth()).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it('clamps to the range', () => {
    expect(clampSidebarWidth(1)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it('saves on set, but not for a live (unsaved) set', () => {
    setSidebarWidth(22, false);
    expect(getSidebarWidth()).toBe(22);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull();
    setSidebarWidth(24);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('24');
  });

  it('puts the width on the document root as --sidebar-w', () => {
    setSidebarWidth(22);
    expect(document.documentElement.style.getPropertyValue('--sidebar-w')).toBe('22rem');
  });

  it('applies the saved width at start-up', () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '19');
    resetSidebarWidthForTests();
    initSidebarWidth();
    expect(document.documentElement.style.getPropertyValue('--sidebar-w')).toBe('19rem');
  });

  it('still applies the width when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getSidebarWidth()).toBe(SIDEBAR_WIDTH_DEFAULT);
    setSidebarWidth(18);
    expect(getSidebarWidth()).toBe(18);
  });
});
