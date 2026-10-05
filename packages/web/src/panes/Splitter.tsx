import { useRef, type JSX, type KeyboardEvent, type PointerEvent } from 'react';
import { resizeSplit } from '../state/panes.js';

/** How far one arrow-key press moves a divider, as a share of the split. */
const KEY_STEP = 0.05;

export interface SplitterProps {
  /** 'row' = the panes sit side by side, so the divider is a vertical bar dragged left and right. */
  direction: 'row' | 'column';
  sizes: number[];
  /** The divider sits after child `index`. */
  index: number;
  /** Called while dragging and on keyboard moves, with the new sizes. */
  onResize: (sizes: number[]) => void;
  /** Called when a drag ends, to remember the sizes. */
  onCommit: (sizes: number[]) => void;
  /** Double-click: back to the layout's starting sizes. */
  onReset: () => void;
}

/**
 * The bar between two panes (#824). Drag it, or focus it and use the arrow
 * keys; double-click puts the split back to how it started. Each pane keeps
 * at least MIN_SPLIT_SHARE of the split.
 */
export function Splitter({ direction, sizes, index, onResize, onCommit, onReset }: SplitterProps): JSX.Element {
  const drag = useRef<{ start: number; length: number; sizes: number[] } | null>(null);
  const latest = useRef(sizes);
  latest.current = sizes;
  const total = sizes.reduce((a, b) => a + b, 0);
  const before = sizes.slice(0, index + 1).reduce((a, b) => a + b, 0);
  const vertical = direction === 'row';

  function onPointerDown(e: PointerEvent<HTMLDivElement>): void {
    const container = e.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    drag.current = { start: vertical ? e.clientX : e.clientY, length: vertical ? rect.width : rect.height, sizes };
    // Optional: older engines (and jsdom) have no pointer capture; dragging then just follows the pointer over the bar.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d || d.length <= 0) return;
    const moved = ((vertical ? e.clientX : e.clientY) - d.start) / d.length;
    onResize(resizeSplit(d.sizes, index, moved));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onCommit(latest.current);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const back = vertical ? 'ArrowLeft' : 'ArrowUp';
    const forward = vertical ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const next = resizeSplit(sizes, index, e.key === forward ? KEY_STEP : -KEY_STEP);
    onResize(next);
    onCommit(next);
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={total > 0 ? Math.round((before / total) * 100) : 50}
      data-testid={`splitter-${index}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      title="Drag to resize; double-click to even out"
      className={`shrink-0 touch-none bg-transparent outline-none hover:bg-[var(--accent)] focus-visible:bg-[var(--accent)] ${
        vertical ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      }`}
    />
  );
}
