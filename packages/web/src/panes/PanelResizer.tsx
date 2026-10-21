import { useRef, type JSX, type KeyboardEvent, type PointerEvent } from 'react';
import type { PanelWidth } from '../state/panelWidth.js';

/** How far one arrow-key press moves the edge, in rem. */
const KEY_STEP = 1;

/** Pixels per rem right now (the text size setting changes it). */
function remPx(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * A side panel's edge: drag it, or focus it and use Left/Right, to change the
 * panel's width; double-click puts it back. `edge` is which side of the panel
 * it sits on: the sidebar's is on its right (dragging right widens it), Code
 * mode's right panel's is on its left (dragging left widens it). Drags and key
 * presses start from the width on screen, which the window share caps, so the
 * edge moves straight away rather than after a dead zone. The pane Splitter
 * isn't reused because it works in shares of a split, not an absolute width.
 */
export function PanelResizer({ width, edge, label }: { width: PanelWidth; edge: 'left' | 'right'; label: string }): JSX.Element {
  const shown = (saved: number, px: number): number => Math.min(saved, (width.maxShare * window.innerWidth) / px);
  const now = shown(width.use(), remPx());
  const drag = useRef<{ startX: number; startWidth: number; px: number } | null>(null);
  // Moving the pointer towards the panel's outside widens it.
  const sign = edge === 'right' ? 1 : -1;

  function onPointerDown(e: PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    const px = remPx();
    drag.current = { startX: e.clientX, startWidth: shown(width.get(), px), px };
    // Optional: older engines (and jsdom) have no pointer capture; dragging then just follows the pointer over the bar.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d) return;
    width.set(d.startWidth + (sign * (e.clientX - d.startX)) / d.px, false);
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    width.set(width.get());
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    width.set(shown(width.get(), remPx()) + sign * (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP));
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={width.min}
      aria-valuemax={width.max}
      aria-valuenow={Math.round(now * 100) / 100}
      title="Drag to resize; double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => width.set(width.defaultRem)}
      onKeyDown={onKeyDown}
      className={`absolute inset-y-0 ${edge === 'right' ? '-right-0.5' : '-left-0.5'} z-20 w-1 cursor-col-resize touch-none bg-transparent outline-none hover:bg-[var(--accent)] focus-visible:bg-[var(--accent)]`}
    />
  );
}
