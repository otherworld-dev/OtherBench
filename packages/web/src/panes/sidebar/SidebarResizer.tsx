import { useRef, type JSX, type KeyboardEvent, type PointerEvent } from 'react';
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MAX_SHARE,
  SIDEBAR_WIDTH_MIN,
  getSidebarWidth,
  setSidebarWidth,
  useSidebarWidth,
} from '../../state/sidebarWidth.js';

/** How far one arrow-key press moves the edge, in rem. */
const KEY_STEP = 1;

/** Pixels per rem right now (the text size setting changes it). */
function remPx(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * The width on screen in rem: the saved one, unless the window is too narrow
 * for it and the 40% cap applies. Drags and key presses start from this, so
 * the edge moves straight away rather than after a dead zone.
 */
function shownWidth(saved: number, px: number): number {
  return Math.min(saved, (SIDEBAR_WIDTH_MAX_SHARE * window.innerWidth) / px);
}

/**
 * The sidebar's right edge: drag it, or focus it and use Left/Right, to
 * change the sidebar's width; double-click puts it back. The pane Splitter
 * isn't reused because it works in shares of a split, not an absolute width.
 */
export function SidebarResizer(): JSX.Element {
  const width = shownWidth(useSidebarWidth(), remPx());
  const drag = useRef<{ startX: number; startWidth: number; px: number } | null>(null);

  function onPointerDown(e: PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    const px = remPx();
    drag.current = { startX: e.clientX, startWidth: shownWidth(getSidebarWidth(), px), px };
    // Optional: older engines (and jsdom) have no pointer capture; dragging then just follows the pointer over the bar.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d) return;
    setSidebarWidth(d.startWidth + (e.clientX - d.startX) / d.px, false);
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setSidebarWidth(getSidebarWidth());
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setSidebarWidth(shownWidth(getSidebarWidth(), remPx()) + (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP));
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={Math.round(width * 100) / 100}
      title="Drag to resize; double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -right-0.5 z-20 w-1 cursor-col-resize touch-none bg-transparent outline-none hover:bg-[var(--accent)] focus-visible:bg-[var(--accent)]"
    />
  );
}
