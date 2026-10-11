import { useSyncExternalStore } from 'react';

/** localStorage key: the sidebar's width in rem, so it follows the text size. Per device. */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'grunt.sidebarWidth';
export const SIDEBAR_WIDTH_DEFAULT = 16.25;
export const SIDEBAR_WIDTH_MIN = 12.5;
export const SIDEBAR_WIDTH_MAX = 30;
/** The sidebar never takes more than this share of the window (App's grid column), whatever was saved. */
export const SIDEBAR_WIDTH_MAX_SHARE = 0.4;

/** `rem` clamped to the allowed range; anything that isn't a finite number is the default. */
export function clampSidebarWidth(rem: number): number {
  if (!Number.isFinite(rem)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, rem));
}

/** The stored width, or the default for anything missing, unreadable or out of range. */
function load(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value >= SIDEBAR_WIDTH_MIN && value <= SIDEBAR_WIDTH_MAX ? value : SIDEBAR_WIDTH_DEFAULT;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

let width: number | null = null;
const listeners = new Set<() => void>();

/**
 * Hands the width to the layout as `--sidebar-w` on the document root, so a
 * drag restyles one grid column instead of re-rendering the whole app.
 */
function apply(rem: number): void {
  document.documentElement.style.setProperty('--sidebar-w', `${rem}rem`);
}

/** Applies the saved width; call once before first render. */
export function initSidebarWidth(): void {
  apply(getSidebarWidth());
}

/** The sidebar's width in rem right now. */
export function getSidebarWidth(): number {
  if (width === null) width = load();
  return width;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Sets the width (clamped). `save: false` is for live dragging; the drag's end saves. */
export function setSidebarWidth(rem: number, save = true): void {
  const next = clampSidebarWidth(rem);
  if (next !== width) {
    width = next;
    apply(next);
    listeners.forEach((l) => l());
  }
  if (!save) return;
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
  } catch {
    // storage blocked or full -- the width still applies for this session.
  }
}

/** The sidebar's width in rem; re-renders when it changes. */
export function useSidebarWidth(): number {
  return useSyncExternalStore(subscribe, getSidebarWidth);
}

/** Test hook: forget the cached width so the next read goes back to storage. */
export function resetSidebarWidthForTests(): void {
  width = null;
  listeners.clear();
}
