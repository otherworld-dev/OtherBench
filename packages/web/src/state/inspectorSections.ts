import { useSyncExternalStore } from 'react';

/**
 * localStorage key: JSON object of Inspector section title -> open. Only an
 * explicit open or close is stored; a section with no entry follows its own
 * default. Per device, like the sidebar's collapsed groups.
 */
export const INSPECTOR_SECTIONS_STORAGE_KEY = 'otherbench.inspectorSections';

let choices: Readonly<Record<string, boolean>> | null = null;
const listeners = new Set<() => void>();

function load(): Readonly<Record<string, boolean>> {
  try {
    const raw = window.localStorage.getItem(INSPECTOR_SECTIONS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'));
  } catch {
    return {};
  }
}

function getSnapshot(): Readonly<Record<string, boolean>> {
  if (choices === null) choices = load();
  return choices;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Records a section opened or closed by hand (a failed save only costs the next launch). */
export function setSectionOpen(title: string, open: boolean): void {
  choices = { ...getSnapshot(), [title]: open };
  try {
    window.localStorage.setItem(INSPECTOR_SECTIONS_STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // storage blocked or full -- the choice still applies for this session.
  }
  listeners.forEach((l) => l());
}

/** The section's stored choice, or undefined when it has none; re-renders when it changes. */
export function useSectionChoice(title: string): boolean | undefined {
  return useSyncExternalStore(subscribe, () => getSnapshot()[title]);
}

export function resetInspectorSectionsForTests(): void {
  choices = null;
}
