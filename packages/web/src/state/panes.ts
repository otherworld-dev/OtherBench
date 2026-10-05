/**
 * Tabs and pane layouts (#824). Tabs are chats the user chose to keep at
 * hand ("Open in new tab"), from any project; the layout shows one, two or
 * three chats at once. The chat in the focused pane is the app's active chat,
 * so everything that opens a chat (the sidebar, a notification, quick chat's
 * Expand) fills the focused pane, or focuses the pane already showing it.
 * Pure functions over `PaneState`; the store holds it and persists it per
 * device.
 */

export type Layout = 'single' | 'columns-2' | 'rows-2' | 'columns-3';

export const LAYOUTS: readonly { id: Layout; label: string; panes: number }[] = [
  { id: 'single', label: 'One chat', panes: 1 },
  { id: 'columns-2', label: 'Two side by side', panes: 2 },
  { id: 'rows-2', label: 'Two stacked', panes: 2 },
  { id: 'columns-3', label: 'Three side by side', panes: 3 },
];

export interface PaneState {
  /** Chat ids open as tabs, in tab order. */
  tabs: string[];
  layout: Layout;
  /** The chat in each pane (null = empty), one entry per pane of `layout`. */
  panes: (string | null)[];
  focusedPane: number;
}

export const DEFAULT_PANE_STATE: PaneState = { tabs: [], layout: 'single', panes: [null], focusedPane: 0 };

/** localStorage key for the tabs, layout and what each pane shows. Per device. */
export const PANE_STATE_STORAGE_KEY = 'grunt.panes';

export function paneCount(layout: Layout): number {
  return LAYOUTS.find((l) => l.id === layout)?.panes ?? 1;
}

/** Shows `chatId` in the focused pane, or focuses the pane already showing it. */
export function showChat(state: PaneState, chatId: string | null): PaneState {
  if (chatId !== null) {
    const at = state.panes.indexOf(chatId);
    if (at !== -1) return at === state.focusedPane ? state : { ...state, focusedPane: at };
  }
  const panes = [...state.panes];
  panes[state.focusedPane] = chatId;
  return { ...state, panes };
}

export function focusPane(state: PaneState, index: number): PaneState {
  if (index < 0 || index >= state.panes.length || index === state.focusedPane) return state;
  return { ...state, focusedPane: index };
}

/**
 * Switches layout. Panes keep their places; a pane that no longer exists
 * hands its chat to the last remaining pane if it was the focused one, and
 * new panes fill with the next tabs that aren't already showing.
 */
export function setLayout(state: PaneState, layout: Layout): PaneState {
  const count = paneCount(layout);
  const panes = state.panes.slice(0, count);
  while (panes.length < count) panes.push(null);
  let focusedPane = state.focusedPane;
  if (focusedPane >= count) {
    panes[count - 1] = state.panes[focusedPane] ?? null;
    focusedPane = count - 1;
  }
  const waiting = state.tabs.filter((id) => !panes.includes(id));
  for (let i = 0; i < panes.length; i++) if (panes[i] === null && waiting.length > 0) panes[i] = waiting.shift()!;
  return { ...state, layout, panes, focusedPane };
}

/** Adds `chatId` as a tab (if it isn't one) and shows it. */
export function openTab(state: PaneState, chatId: string): PaneState {
  const tabs = state.tabs.includes(chatId) ? state.tabs : [...state.tabs, chatId];
  return showChat({ ...state, tabs }, chatId);
}

/** Removes the tab. Any pane showing the chat keeps showing it. */
export function closeTab(state: PaneState, chatId: string): PaneState {
  if (!state.tabs.includes(chatId)) return state;
  return { ...state, tabs: state.tabs.filter((id) => id !== chatId) };
}

/** A deleted chat leaves the tabs and every pane. */
export function forgetChat(state: PaneState, chatId: string): PaneState {
  if (!state.tabs.includes(chatId) && !state.panes.includes(chatId)) return state;
  return { ...state, tabs: state.tabs.filter((id) => id !== chatId), panes: state.panes.map((id) => (id === chatId ? null : id)) };
}

/** Moves the tab `chatId` so it sits before `beforeId` (null = the end). */
export function moveTab(state: PaneState, chatId: string, beforeId: string | null): PaneState {
  if (!state.tabs.includes(chatId) || chatId === beforeId) return state;
  const rest = state.tabs.filter((id) => id !== chatId);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  if (at === -1) return state;
  return { ...state, tabs: [...rest.slice(0, at), chatId, ...rest.slice(at)] };
}

export function loadPaneState(): PaneState {
  try {
    const raw = window.localStorage.getItem(PANE_STATE_STORAGE_KEY);
    if (!raw) return DEFAULT_PANE_STATE;
    const parsed = JSON.parse(raw) as Partial<PaneState>;
    const layout = LAYOUTS.some((l) => l.id === parsed.layout) ? (parsed.layout as Layout) : 'single';
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : []);
    const count = paneCount(layout);
    const stored = Array.isArray(parsed.panes) ? parsed.panes : [];
    const panes = Array.from({ length: count }, (_, i) => (typeof stored[i] === 'string' ? (stored[i] as string) : null));
    const focusedPane = typeof parsed.focusedPane === 'number' && parsed.focusedPane >= 0 && parsed.focusedPane < count ? parsed.focusedPane : 0;
    return { tabs: [...new Set(ids(parsed.tabs))], layout, panes, focusedPane };
  } catch {
    return DEFAULT_PANE_STATE;
  }
}

export function savePaneState(state: PaneState): void {
  try {
    window.localStorage.setItem(PANE_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage blocked or full -- the layout still applies for this session.
  }
}
