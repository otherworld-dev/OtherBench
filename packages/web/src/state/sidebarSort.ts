import { useSyncExternalStore } from 'react';
import { NO_PROJECT_KEY } from './sidebarGroups.js';

/** How a sidebar group orders its chats: by hand (drag, Move up/down), or by last activity with date headings. */
export type GroupSort = 'manual' | 'recent';

/** localStorage key: JSON object of group key -> GroupSort, for groups set away from their default. Per device, like collapse state. */
export const GROUP_SORT_STORAGE_KEY = 'grunt.groupSort';

/** No project is a dumping ground nobody orders by hand, so it starts by recent activity; projects start manual. */
export function defaultGroupSort(key: string): GroupSort {
  return key === NO_PROJECT_KEY ? 'recent' : 'manual';
}

let sorts: ReadonlyMap<string, GroupSort> | null = null;
const listeners = new Set<() => void>();

function load(): ReadonlyMap<string, GroupSort> {
  try {
    const raw = window.localStorage.getItem(GROUP_SORT_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter((e): e is [string, GroupSort] => e[1] === 'manual' || e[1] === 'recent'));
  } catch {
    return new Map();
  }
}

function getSnapshot(): ReadonlyMap<string, GroupSort> {
  if (sorts === null) sorts = load();
  return sorts;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A group's sort: its saved choice, else its default. */
export function groupSortOf(saved: ReadonlyMap<string, GroupSort>, key: string): GroupSort {
  return saved.get(key) ?? defaultGroupSort(key);
}

/** Sets one group's sort and saves it (a failed save only costs the next launch). */
export function setGroupSort(key: string, value: GroupSort): void {
  const current = getSnapshot();
  if (groupSortOf(current, key) === value) return;
  const next = new Map(current);
  // Only departures from the default are stored, so a default can change later without stale entries pinning it.
  if (value === defaultGroupSort(key)) next.delete(key);
  else next.set(key, value);
  sorts = next;
  try {
    window.localStorage.setItem(GROUP_SORT_STORAGE_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // storage blocked or full -- the sort still applies for this session.
  }
  listeners.forEach((l) => l());
}

/** The saved sorts (read each group's through `groupSortOf`); re-renders when one changes. */
export function useGroupSorts(): ReadonlyMap<string, GroupSort> {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Test hook: forget the cached map so the next read goes back to storage. */
export function resetGroupSortsForTests(): void {
  sorts = null;
  listeners.clear();
}
