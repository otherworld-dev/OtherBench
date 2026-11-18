import { useSyncExternalStore } from 'react';

/**
 * localStorage key: whether opening a top-level project in the Chat sidebar folds every other one, so only one
 * parent project's chats show at a time. Per device, like the collapse state it drives. On unless switched off
 * ("false"), in Settings → Appearance.
 */
export const ONE_PROJECT_OPEN_STORAGE_KEY = 'otherbench.oneProjectOpen';

let current: boolean | null = null;
const listeners = new Set<() => void>();

function load(): boolean {
  try {
    return window.localStorage.getItem(ONE_PROJECT_OPEN_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function getSnapshot(): boolean {
  if (current === null) current = load();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Switches the setting and saves it (a failed save only costs the next launch). */
export function setOneProjectOpen(value: boolean): void {
  current = value;
  try {
    window.localStorage.setItem(ONE_PROJECT_OPEN_STORAGE_KEY, String(value));
  } catch {
    // storage blocked or full -- the setting still applies for this session.
  }
  listeners.forEach((l) => l());
}

/** Whether only one top-level project stays open at a time, plus its setter. */
export function useOneProjectOpen(): [boolean, (value: boolean) => void] {
  return [useSyncExternalStore(subscribe, getSnapshot), setOneProjectOpen];
}

/** Test hook: forget the cached value so the next read goes back to storage. */
export function resetOneProjectOpenForTests(): void {
  current = null;
  listeners.clear();
}
