import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_AREA_MIN_REM, CODE_PANEL_CSS_WIDTH, codePanelWidth, CODE_PANEL_WIDTH_STORAGE_KEY } from './codePanelWidth.js';
import { resetSidebarWidthForTests, setSidebarWidth } from './sidebarWidth.js';

beforeEach(() => {
  window.localStorage.clear();
  codePanelWidth.resetForTests();
  resetSidebarWidthForTests();
});
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('codePanelWidth', () => {
  it('defaults to 24rem with nothing stored, and keeps 70% of the window as its cap', () => {
    expect(codePanelWidth.get()).toBe(24);
    expect(codePanelWidth).toMatchObject({ min: 18, max: 120, maxShare: 0.7, defaultRem: 24 });
  });

  it('clamps to 18..120 and saves', () => {
    codePanelWidth.set(5);
    expect(codePanelWidth.get()).toBe(18);
    codePanelWidth.set(500);
    expect(codePanelWidth.get()).toBe(120);
    codePanelWidth.set(40);
    expect(window.localStorage.getItem(CODE_PANEL_WIDTH_STORAGE_KEY)).toBe('40');
    codePanelWidth.resetForTests();
    expect(codePanelWidth.get()).toBe(40);
  });

  it.each(['', 'wide', '3', '999'])('falls back to the default for a stored %j', (raw) => {
    window.localStorage.setItem(CODE_PANEL_WIDTH_STORAGE_KEY, raw);
    expect(codePanelWidth.get()).toBe(24);
  });

  it('a live drag is not saved', () => {
    codePanelWidth.set(30, false);
    expect(codePanelWidth.get()).toBe(30);
    expect(window.localStorage.getItem(CODE_PANEL_WIDTH_STORAGE_KEY)).toBeNull();
  });

  it('applies itself as --code-panel-w', () => {
    codePanelWidth.set(33);
    expect(document.documentElement.style.getPropertyValue('--code-panel-w')).toBe('33rem');
  });
});

describe('the most the Code panel can show', () => {
  it('is 70% of a wide window', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 3200 }); // 70% = 2240px = 140rem
    expect(codePanelWidth.shownMax(16)).toBe(140);
  });

  it('leaves the sidebar and a minimum chat area on a narrower window', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    setSidebarWidth(20, false); // 320px
    // 1200 - 320 - 20rem (320px) = 560px = 35rem, under 70% (840px).
    expect(codePanelWidth.shownMax(16)).toBe((1200 - 320 - CHAT_AREA_MIN_REM * 16) / 16);
  });

  it('counts the sidebar at its own 40% cap, not its saved width', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    setSidebarWidth(30, false); // 480px saved, but the sidebar shows at most 440px
    expect(codePanelWidth.shownMax(16)).toBe((1100 - 440 - CHAT_AREA_MIN_REM * 16) / 16);
  });

  it('follows the text size', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    setSidebarWidth(20, false);
    // At 20px a rem: 1200 - 400 - 400 = 400px = 20rem.
    expect(codePanelWidth.shownMax(20)).toBe(20);
  });

  it('is never negative', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 });
    expect(codePanelWidth.shownMax(16)).toBe(0);
  });

  it('the layout caps the column the same way, so a window resize applies it too', () => {
    expect(CODE_PANEL_CSS_WIDTH).toBe(
      `min(var(--code-panel-w, 24rem), 70vw, calc(100vw - min(var(--sidebar-w, 16.25rem), 40vw) - ${CHAT_AREA_MIN_REM}rem))`,
    );
  });
});
