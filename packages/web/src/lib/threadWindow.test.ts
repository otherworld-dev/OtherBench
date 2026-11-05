import { describe, expect, it } from 'vitest';
import { clampWindow, windowFor } from './threadWindow.js';

describe('clampWindow', () => {
  it('keeps a window that fits', () => {
    expect(clampWindow({ start: 100, end: null }, 600, 40)).toEqual({ start: 100, end: null });
    expect(clampWindow({ start: 10, end: 50 }, 600, 40)).toEqual({ start: 10, end: 50 });
  });

  it('never starts so late that fewer than a window are drawn', () => {
    expect(clampWindow({ start: 590, end: null }, 600, 40)).toEqual({ start: 560, end: null });
    expect(clampWindow({ start: 30, end: 50 }, 600, 40)).toEqual({ start: 10, end: 50 });
    expect(clampWindow({ start: 5, end: null }, 12, 40)).toEqual({ start: 0, end: null });
  });

  it('runs to the end of the chat again once it reaches it', () => {
    expect(clampWindow({ start: 570, end: 600 }, 600, 40)).toEqual({ start: 560, end: null });
    expect(clampWindow({ start: 20, end: 80 }, 50, 40)).toEqual({ start: 10, end: null });
  });
});

describe('windowFor', () => {
  const tail = { start: 560, end: null };

  it('leaves the window alone when the message is drawn', () => {
    expect(windowFor(tail, 580, 600, 40)).toEqual(tail);
    expect(windowFor({ start: 10, end: 50 }, 49, 600, 40)).toEqual({ start: 10, end: 50 });
  });

  it('grows the window back to a message just before it, still running to the end', () => {
    expect(windowFor(tail, 530, 600, 40)).toEqual({ start: 530, end: null });
    expect(windowFor({ start: 100, end: 140 }, 70, 600, 40)).toEqual({ start: 70, end: 140 });
  });

  it('draws a message far back on its own, not everything from it to the end', () => {
    expect(windowFor(tail, 2, 600, 40)).toEqual({ start: 2, end: 42 });
  });

  it('grows a cut-loose window on to a message just after it', () => {
    expect(windowFor({ start: 2, end: 42 }, 50, 600, 40)).toEqual({ start: 2, end: 82 });
    expect(windowFor({ start: 2, end: 42 }, 81, 600, 40)).toEqual({ start: 2, end: 82 });
  });

  it('moves a cut-loose window to a message far after it', () => {
    expect(windowFor({ start: 2, end: 42 }, 300, 600, 40)).toEqual({ start: 300, end: 340 });
  });

  it('joins the end of the chat again for a message near it', () => {
    expect(windowFor({ start: 2, end: 42 }, 590, 600, 40)).toEqual({ start: 560, end: null });
    expect(windowFor({ start: 540, end: 580 }, 585, 600, 40)).toEqual({ start: 540, end: null });
  });

  it('draws a short chat whole', () => {
    expect(windowFor({ start: 0, end: null }, 3, 12, 40)).toEqual({ start: 0, end: null });
  });
});
