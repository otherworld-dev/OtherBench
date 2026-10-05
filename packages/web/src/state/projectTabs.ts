import { useSyncExternalStore } from 'react';

/** localStorage key: which chats are open as tabs in each project (#824). Per device, like the window they're open in. */
export const PROJECT_TABS_STORAGE_KEY = 'grunt.projectTabs';

/** Open chat ids per project id. */
export type OpenTabs = Readonly<Record<string, readonly string[]>>;

let open: OpenTabs | null = null;
const listeners = new Set<() => void>();

function load(): OpenTabs {
  try {
    const raw = window.localStorage.getItem(PROJECT_TABS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [projectId, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids)) out[projectId] = ids.filter((id): id is string => typeof id === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

function getSnapshot(): OpenTabs {
  if (open === null) open = load();
  return open;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function write(next: OpenTabs): void {
  open = next;
  try {
    window.localStorage.setItem(PROJECT_TABS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage blocked or full -- the tabs still apply for this session.
  }
  listeners.forEach((l) => l());
}

/** Opens `chatId` as a tab in `projectId`. A no-op when it's already open. */
export function openTab(projectId: string, chatId: string): void {
  const current = getSnapshot();
  const ids = current[projectId] ?? [];
  if (ids.includes(chatId)) return;
  write({ ...current, [projectId]: [...ids, chatId] });
}

/** Closes `chatId`'s tab in `projectId`. The chat itself is untouched. */
export function closeTab(projectId: string, chatId: string): void {
  const current = getSnapshot();
  const ids = current[projectId] ?? [];
  if (!ids.includes(chatId)) return;
  write({ ...current, [projectId]: ids.filter((id) => id !== chatId) });
}

export function useOpenTabs(): OpenTabs {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function resetProjectTabsForTests(): void {
  open = null;
  listeners.clear();
}
