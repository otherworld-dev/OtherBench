import { useSyncExternalStore } from 'react';

/**
 * A side panel's width in rem (so it follows the text size), remembered per
 * device in localStorage and handed to the layout as a CSS variable on the
 * document root, so a drag restyles one column instead of re-rendering the
 * app. The sidebar (sidebarWidth.ts) and Code mode's right panel (codePanelWidth.ts) each have one.
 */
export interface PanelWidth {
  readonly min: number;
  readonly max: number;
  /** The panel never takes more than this share of the window, whatever was saved. */
  readonly maxShare: number;
  readonly defaultRem: number;
  /** `rem` clamped to the allowed range; anything that isn't a finite number is the default. */
  clamp(rem: number): number;
  /**
   * The most the panel can show right now, in rem at `remPx` pixels each: its share of the window, less what
   * the rest of the layout keeps (`reservePx`). The layout's CSS applies the same cap; this is for drags.
   */
  shownMax(remPx: number): number;
  /** The width in rem right now. */
  get(): number;
  /** Sets the width (clamped). `save: false` is for live dragging; the drag's end saves. */
  set(rem: number, save?: boolean): void;
  /** The width in rem; re-renders when it changes. */
  use(): number;
  /** Applies the saved width; call once before first render. */
  init(): void;
  /** Test hook: forget the cached width so the next read goes back to storage. */
  resetForTests(): void;
}

export function panelWidth(o: {
  key: string;
  cssVar: string;
  defaultRem: number;
  min: number;
  max: number;
  maxShare: number;
  /** Pixels of the window the rest of the layout keeps, at `remPx` pixels a rem. None if omitted. */
  reservePx?: (remPx: number) => number;
}): PanelWidth {
  let width: number | null = null;
  const listeners = new Set<() => void>();
  const clamp = (rem: number): number => (Number.isFinite(rem) ? Math.min(o.max, Math.max(o.min, rem)) : o.defaultRem);
  const load = (): number => {
    try {
      const raw = window.localStorage.getItem(o.key);
      const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
      return Number.isFinite(value) && value >= o.min && value <= o.max ? value : o.defaultRem;
    } catch {
      return o.defaultRem;
    }
  };
  const apply = (rem: number): void => document.documentElement.style.setProperty(o.cssVar, `${rem}rem`);
  const get = (): number => {
    if (width === null) width = load();
    return width;
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    min: o.min,
    max: o.max,
    maxShare: o.maxShare,
    defaultRem: o.defaultRem,
    clamp,
    shownMax(remPx) {
      const room = window.innerWidth - (o.reservePx?.(remPx) ?? 0);
      return Math.max(0, Math.min(o.maxShare * window.innerWidth, room) / remPx);
    },
    get,
    set(rem, save = true) {
      const next = clamp(rem);
      if (next !== width) {
        width = next;
        apply(next);
        listeners.forEach((l) => l());
      }
      if (!save) return;
      try {
        window.localStorage.setItem(o.key, String(next));
      } catch {
        // storage blocked or full -- the width still applies for this session.
      }
    },
    use: () => useSyncExternalStore(subscribe, get),
    init: () => apply(get()),
    resetForTests() {
      width = null;
      listeners.clear();
    },
  };
}
