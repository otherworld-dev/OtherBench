import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codePanelWidth, CODE_PANEL_WIDTH_STORAGE_KEY } from '../state/codePanelWidth.js';
import { resetSidebarWidthForTests } from '../state/sidebarWidth.js';
import { PanelResizer } from './PanelResizer.js';

beforeEach(() => {
  window.localStorage.clear();
  codePanelWidth.resetForTests();
  resetSidebarWidthForTests();
  document.documentElement.style.fontSize = '16px';
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2000 });
});
afterEach(() => {
  cleanup();
  document.documentElement.style.fontSize = '';
});

const handle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize code panel' });

describe('PanelResizer on the left edge (the Code panel)', () => {
  it('reports the range and width', () => {
    render(<PanelResizer width={codePanelWidth} edge="left" label="Resize code panel" />);
    expect(handle()).toHaveAttribute('aria-valuemin', '18');
    expect(handle()).toHaveAttribute('aria-valuemax', '120');
    expect(handle()).toHaveAttribute('aria-valuenow', '24');
  });

  it('widens when dragged left, and saves when the drag ends', () => {
    render(<PanelResizer width={codePanelWidth} edge="left" label="Resize code panel" />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 840, pointerId: 1 }); // -160px = +10rem
    expect(codePanelWidth.get()).toBe(34);
    expect(window.localStorage.getItem(CODE_PANEL_WIDTH_STORAGE_KEY)).toBeNull();
    fireEvent.pointerUp(handle(), { clientX: 840, pointerId: 1 });
    expect(window.localStorage.getItem(CODE_PANEL_WIDTH_STORAGE_KEY)).toBe('34');
  });

  it('ArrowLeft widens and ArrowRight narrows', () => {
    render(<PanelResizer width={codePanelWidth} edge="left" label="Resize code panel" />);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(codePanelWidth.get()).toBe(25);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(codePanelWidth.get()).toBe(23);
  });

  it('double-click puts it back', () => {
    codePanelWidth.set(50);
    render(<PanelResizer width={codePanelWidth} edge="left" label="Resize code panel" />);
    fireEvent.doubleClick(handle());
    expect(codePanelWidth.get()).toBe(24);
  });

  it('works from the width on screen when the 70% cap applies', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2000 }); // cap: 1400px = 87.5rem
    codePanelWidth.set(100);
    render(<PanelResizer width={codePanelWidth} edge="left" label="Resize code panel" />);
    expect(handle()).toHaveAttribute('aria-valuenow', '87.5');
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(codePanelWidth.get()).toBe(86.5);
  });

  it('works from the width on screen when the sidebar and the chat area cap it', () => {
    // 1200 - 260px sidebar - 320px chat area = 620px = 38.75rem, under 70% (840px).
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    codePanelWidth.set(100);
    render(<PanelResizer width={codePanelWidth} edge="left" label="Resize code panel" />);
    expect(handle()).toHaveAttribute('aria-valuenow', '38.75');
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 516, pointerId: 1 }); // +16px = -1rem
    expect(codePanelWidth.get()).toBe(37.75);
  });
});
