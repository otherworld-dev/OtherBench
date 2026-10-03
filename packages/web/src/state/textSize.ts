import { useEffect, useSyncExternalStore } from 'react';

/** Selectable text sizes, as a percentage of the browser's base font size. */
export const TEXT_SIZE_STEPS = [85, 100, 115, 130, 150] as const;
export const DEFAULT_TEXT_SIZE = 100;
export const TEXT_SIZE_STORAGE_KEY = 'grunt.textSize';

/** Reads the saved size; anything missing, unreadable or off-step falls back to 100. */
export function loadTextSize(): number {
  try {
    const n = Number(window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY));
    return (TEXT_SIZE_STEPS as readonly number[]).includes(n) ? n : DEFAULT_TEXT_SIZE;
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

/** Scales the whole UI: Tailwind 4 utilities are rem-based, so the root font size drives everything. */
export function applyTextSize(pct: number): void {
  document.documentElement.style.fontSize = `${pct}%`;
}

/** The next step up (`1`) or down (`-1`) from `current`, clamped at the ends. */
export function stepTextSize(current: number, dir: 1 | -1): number {
  // An off-step value snaps to the nearest step first, so stepping never skips one.
  let idx = 0;
  TEXT_SIZE_STEPS.forEach((s, i) => {
    if (Math.abs(s - current) < Math.abs(TEXT_SIZE_STEPS[idx]! - current)) idx = i;
  });
  return TEXT_SIZE_STEPS[Math.min(TEXT_SIZE_STEPS.length - 1, Math.max(0, idx + dir))]!;
}

let current = DEFAULT_TEXT_SIZE;
let initialised = false;
const listeners = new Set<() => void>();

function ensureInitialised(): void {
  if (initialised) return;
  initialised = true;
  current = loadTextSize();
}

/** Applies the saved size; call once before first render so there is no flash of the wrong size. */
export function initTextSize(): void {
  initialised = true;
  current = loadTextSize();
  applyTextSize(current);
}

/** Sets, applies and persists the size (a persistence failure only costs the next launch). */
export function setTextSize(pct: number): void {
  ensureInitialised();
  current = pct;
  applyTextSize(pct);
  try {
    window.localStorage.setItem(TEXT_SIZE_STORAGE_KEY, String(pct));
  } catch {
    // storage blocked or full -- the size still applies for this session.
  }
  listeners.forEach((l) => l());
}

function getSnapshot(): number {
  ensureInitialised();
  return current;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Current text size plus its setter, shared by the Settings select and the keyboard shortcuts. */
export function useTextSize(): [number, (pct: number) => void] {
  return [useSyncExternalStore(subscribe, getSnapshot), setTextSize];
}

/** Ctrl/Cmd + `=`/`+` steps up, `-` steps down, `0` resets. Browser/webview zoom is suppressed. */
export function useTextSizeShortcuts(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      let next: number;
      if (e.key === '=' || e.key === '+') next = stepTextSize(getSnapshot(), 1);
      else if (e.key === '-') next = stepTextSize(getSnapshot(), -1);
      else if (e.key === '0') next = DEFAULT_TEXT_SIZE;
      else return;
      e.preventDefault();
      setTextSize(next);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Test hook: forget the cached value so the next read goes back to storage. */
export function resetTextSizeForTests(): void {
  initialised = false;
  current = DEFAULT_TEXT_SIZE;
  listeners.clear();
}
