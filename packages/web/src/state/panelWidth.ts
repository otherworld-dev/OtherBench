import { useSyncExternalStore } from 'react';

/**
 * A side panel's width in rem (so it follows the text size), remembered per
 * device in localStorage and handed to the layout as a CSS variable on the
 * document root, so a drag restyles one column instead of re-rendering the
 * app. The sidebar and Code mode's right panel each have one.
 */
export interface PanelWidth {
  readonly min: number;
  readonly max: number;
  /** The panel never takes more than this share of the window, whatever was saved. */
  readonly maxShare: number;
  readonly defaultRem: number;
  /** `rem` clamped to the allowed range; anything that isn't a finite number is the default. */
  clamp(rem: number): number;
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

export function panelWidth(o: { key: string; cssVar: string; defaultRem: number; min: number; max: number; maxShare: number }): PanelWidth {
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

/** localStorage key: Code mode's right panel width in rem (spec 2026-10-21-code-terminal-design). Per device. */
export const CODE_PANEL_WIDTH_STORAGE_KEY = 'otherbench.codePanelWidth';

/** Code mode's right panel (Issues, Files, Chat, Terminal): 24rem to start, 18rem at least, at most 70% of the window. */
export const codePanelWidth = panelWidth({ key: CODE_PANEL_WIDTH_STORAGE_KEY, cssVar: '--code-panel-w', defaultRem: 24, min: 18, max: 120, maxShare: 0.7 });
