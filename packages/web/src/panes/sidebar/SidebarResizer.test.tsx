import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_STORAGE_KEY, getSidebarWidth, resetSidebarWidthForTests, setSidebarWidth } from '../../state/sidebarWidth.js';
import { SidebarResizer } from './SidebarResizer.js';

beforeEach(() => {
  window.localStorage.clear();
  resetSidebarWidthForTests();
  document.documentElement.style.fontSize = '16px';
});
afterEach(() => {
  cleanup();
  document.documentElement.style.fontSize = '';
});

const handle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize sidebar' });

describe('SidebarResizer', () => {
  it('is a focusable vertical separator reporting the width in rem', () => {
    render(<SidebarResizer />);
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle()).toHaveAttribute('tabindex', '0');
    expect(handle()).toHaveAttribute('aria-valuemin', '12.5');
    expect(handle()).toHaveAttribute('aria-valuemax', '30');
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_WIDTH_DEFAULT));
  });

  it('moves 1rem per arrow key and saves', () => {
    render(<SidebarResizer />);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(getSidebarWidth()).toBe(17.25);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(getSidebarWidth()).toBe(15.25);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('15.25');
    expect(handle()).toHaveAttribute('aria-valuenow', '15.25');
  });

  it('follows a drag live and saves only when it ends', () => {
    render(<SidebarResizer />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 260, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 324, pointerId: 1 }); // +64px = +4rem at 16px
    expect(getSidebarWidth()).toBe(20.25);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull();
    fireEvent.pointerUp(handle(), { clientX: 324, pointerId: 1 });
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('20.25');
  });

  it('double-click resets to the default', () => {
    setSidebarWidth(25);
    render(<SidebarResizer />);
    fireEvent.doubleClick(handle());
    expect(getSidebarWidth()).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(SIDEBAR_WIDTH_DEFAULT));
  });
});
