import { act, cleanup, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TEXT_SIZE_STEPS,
  applyTextSize,
  loadTextSize,
  resetTextSizeForTests,
  setTextSize,
  stepTextSize,
  useTextSize,
  useTextSizeShortcuts,
} from './textSize.js';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.fontSize = '';
  resetTextSizeForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('textSize module', () => {
  it('offers the five steps', () => {
    expect([...TEXT_SIZE_STEPS]).toEqual([85, 100, 115, 130, 150]);
  });

  it('steps up and down, clamping at the ends', () => {
    expect(stepTextSize(100, 1)).toBe(115);
    expect(stepTextSize(100, -1)).toBe(85);
    expect(stepTextSize(150, 1)).toBe(150);
    expect(stepTextSize(85, -1)).toBe(85);
  });

  it('loads 100 when nothing, garbage or an off-step value is stored', () => {
    expect(loadTextSize()).toBe(100);
    window.localStorage.setItem('otherbench.textSize', 'banana');
    expect(loadTextSize()).toBe(100);
    window.localStorage.setItem('otherbench.textSize', '111');
    expect(loadTextSize()).toBe(100);
    window.localStorage.setItem('otherbench.textSize', '130');
    expect(loadTextSize()).toBe(130);
  });

  it('falls back to 100 when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadTextSize()).toBe(100);
  });

  it('applies the size to the root font size', () => {
    applyTextSize(115);
    expect(document.documentElement.style.fontSize).toBe('115%');
  });

  it('persists on set, and survives a storage write failure', () => {
    setTextSize(130);
    expect(window.localStorage.getItem('otherbench.textSize')).toBe('130');
    expect(document.documentElement.style.fontSize).toBe('130%');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    expect(() => setTextSize(85)).not.toThrow();
    expect(document.documentElement.style.fontSize).toBe('85%');
  });
});

function Probe(): JSX.Element {
  useTextSizeShortcuts();
  const [size] = useTextSize();
  return <div data-testid="size">{size}</div>;
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(ev);
  });
  return ev;
}

describe('text size shortcuts', () => {
  it('Ctrl+= / Ctrl++ step up, Ctrl+- steps down, Ctrl+0 resets, all with preventDefault', () => {
    render(<Probe />);
    expect(screen.getByTestId('size').textContent).toBe('100');
    expect(press({ key: '=', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(screen.getByTestId('size').textContent).toBe('115');
    press({ key: '+', ctrlKey: true });
    expect(screen.getByTestId('size').textContent).toBe('130');
    press({ key: '-', metaKey: true });
    expect(screen.getByTestId('size').textContent).toBe('115');
    expect(press({ key: '0', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(screen.getByTestId('size').textContent).toBe('100');
    expect(document.documentElement.style.fontSize).toBe('100%');
  });

  it('clamps at the ends', () => {
    render(<Probe />);
    for (let i = 0; i < 8; i++) press({ key: '=', ctrlKey: true });
    expect(screen.getByTestId('size').textContent).toBe('150');
    for (let i = 0; i < 8; i++) press({ key: '-', ctrlKey: true });
    expect(screen.getByTestId('size').textContent).toBe('85');
  });

  it('ignores keys without Ctrl/Cmd', () => {
    render(<Probe />);
    const ev = press({ key: '=' });
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.getByTestId('size').textContent).toBe('100');
  });
});
