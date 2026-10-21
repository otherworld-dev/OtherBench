import { beforeEach, describe, expect, it } from 'vitest';
import { codePanelWidth, CODE_PANEL_WIDTH_STORAGE_KEY } from './panelWidth.js';

beforeEach(() => {
  window.localStorage.clear();
  codePanelWidth.resetForTests();
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
