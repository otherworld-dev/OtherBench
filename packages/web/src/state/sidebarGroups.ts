import { useSyncExternalStore } from 'react';

/** localStorage key: JSON array of collapsed sidebar group keys. Per device, by design (spec "Collapse state"). */
export const COLLAPSED_GROUPS_STORAGE_KEY = 'otherbench.collapsedGroups';

/** The group key of "No project". Project ids are UUIDs, so it can't collide. */
export const NO_PROJECT_KEY = '__no_project__';

/**
 * Code mode's group key for chats whose app isn't loaded (spec 2026-10-20-code-tab-design): they are app chats,
 * so they stay out of Chat mode, and sit together at the end of the Code sidebar. App ids are UUIDs too.
 */
export const UNKNOWN_APP_KEY = '__unknown_app__';

/** DOM id of a sidebar group's wrapper, for scrolling to it. */
export function groupDomId(key: string): string {
  return `project-group-${key}`;
}

let collapsed: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function load(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function getSnapshot(): ReadonlySet<string> {
  if (collapsed === null) collapsed = load();
  return collapsed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Collapses or expands one group and saves the set (a failed save only costs the next launch). */
export function setGroupCollapsed(key: string, value: boolean): void {
  const current = getSnapshot();
  if (current.has(key) === value) return;
  const next = new Set(current);
  if (value) next.add(key);
  else next.delete(key);
  collapsed = next;
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // storage blocked or full -- the collapse still applies for this session.
  }
  listeners.forEach((l) => l());
}

/** The keys of the collapsed groups; re-renders when one changes. */
export function useCollapsedGroups(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Expands a group and scrolls the sidebar to it (the Inspector's project link). */
export function revealSidebarGroup(key: string): void {
  setGroupCollapsed(key, false);
  document.getElementById(groupDomId(key))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  // Keyboard users land on the heading they asked for (its button is always rendered, collapsed or not).
  document.getElementById(groupDomId(key))?.querySelector<HTMLElement>('[data-heading-main]')?.focus();
}

/** Test hook: forget the cached set so the next read goes back to storage. */
export function resetSidebarGroupsForTests(): void {
  collapsed = null;
  listeners.clear();
}
