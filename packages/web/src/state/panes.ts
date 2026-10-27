/**
 * Tabs and pane layouts (#824). Tabs are chats the user chose to keep at
 * hand ("Open in new tab"), from any project; the layout shows one, two or
 * three chats at once. The chat in the focused pane is the app's active chat,
 * so everything that opens a chat (the sidebar, a notification, quick chat's
 * Expand) fills the focused pane, or focuses the pane already showing it.
 * Pure functions over `PaneState`; the store holds it and persists it per
 * device.
 */

import { parseViewTab } from '../viewer/items.js';
import { appTabId, parseAppTab } from './appTab.js';
import { parseProjectTab, projectTabId } from './projectTab.js';

export type Layout = 'single' | 'columns-2' | 'rows-2' | 'columns-3' | 'main-right-2' | 'grid-4';

export const LAYOUTS: readonly { id: Layout; label: string; panes: number }[] = [
  { id: 'single', label: 'One chat', panes: 1 },
  { id: 'columns-2', label: 'Two side by side', panes: 2 },
  { id: 'rows-2', label: 'Two stacked', panes: 2 },
  { id: 'columns-3', label: 'Three side by side', panes: 3 },
  { id: 'main-right-2', label: 'One big, two stacked', panes: 3 },
  { id: 'grid-4', label: 'Four in a grid', panes: 4 },
];

/**
 * How a layout splits the chat area: a tree of splits whose leaves are pane
 * indexes. A 'row' split lays its children side by side, a 'column' split
 * stacks them. Each split has its own id, so its sizes are remembered on
 * their own (see `PaneState.sizes`).
 */
export type SplitNode = { pane: number } | { split: 'row' | 'column'; id: string; children: SplitNode[] };

export const LAYOUT_TREES: Record<Layout, SplitNode> = {
  single: { pane: 0 },
  'columns-2': { split: 'row', id: 'root', children: [{ pane: 0 }, { pane: 1 }] },
  'rows-2': { split: 'column', id: 'root', children: [{ pane: 0 }, { pane: 1 }] },
  'columns-3': { split: 'row', id: 'root', children: [{ pane: 0 }, { pane: 1 }, { pane: 2 }] },
  'main-right-2': { split: 'row', id: 'root', children: [{ pane: 0 }, { split: 'column', id: 'right', children: [{ pane: 1 }, { pane: 2 }] }] },
  'grid-4': {
    split: 'column',
    id: 'root',
    children: [
      { split: 'row', id: 'top', children: [{ pane: 0 }, { pane: 1 }] },
      { split: 'row', id: 'bottom', children: [{ pane: 2 }, { pane: 3 }] },
    ],
  },
};

/** The key a split's sizes are stored under. */
export const splitKey = (layout: Layout, id: string): string => `${layout}/${id}`;

/** A split's sizes before anyone drags it: even, except the big pane of "one big, two stacked". */
export function defaultSizes(layout: Layout, id: string, count: number): number[] {
  if (layout === 'main-right-2' && id === 'root') return [2, 1];
  return Array.from({ length: count }, () => 1);
}

/** The smallest share of a split one child can be dragged down to. */
export const MIN_SPLIT_SHARE = 0.15;

export interface PaneState {
  /** Chat ids open as tabs, in tab order. */
  tabs: string[];
  layout: Layout;
  /** The chat in each pane (null = empty), one entry per pane of `layout`. */
  panes: (string | null)[];
  focusedPane: number;
  /** Sizes of each split the user has dragged, by `splitKey`, as relative weights. */
  sizes: Record<string, number[]>;
  /** The focused pane fills the whole chat area for now. */
  maximised: boolean;
}

export const DEFAULT_PANE_STATE: PaneState = { tabs: [], layout: 'single', panes: [null], focusedPane: 0, sizes: {}, maximised: false };

/** localStorage key for the tabs, layout and what each pane shows. Per device. Chat mode's, and every layout saved before Code mode. */
export const PANE_STATE_STORAGE_KEY = 'otherbench.panes';
/**
 * Code mode's own tabs and layout (spec 2026-10-20-code-tab-design, "Code is a
 * whole-window mode": each mode keeps its own set of open tabs and pane
 * layout). The pane functions here are the same for both; only the key differs.
 */
export const CODE_PANE_STATE_STORAGE_KEY = PANE_STATE_STORAGE_KEY + '.code';

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
  return { ...state, layout, panes, focusedPane, maximised: false };
}

/** Remembers a split's sizes. Ignores a list of the wrong length or with a non-positive size. */
export function setSplitSizes(state: PaneState, key: string, sizes: number[]): PaneState {
  if (sizes.length < 2 || sizes.some((s) => !Number.isFinite(s) || s <= 0)) return state;
  return { ...state, sizes: { ...state.sizes, [key]: sizes } };
}

/** Maximises the focused pane, or puts it back. Only meaningful with more than one pane. */
export function toggleMaximised(state: PaneState): PaneState {
  if (state.panes.length < 2) return state.maximised ? { ...state, maximised: false } : state;
  return { ...state, maximised: !state.maximised };
}

/**
 * Moves the divider after child `index` of a split by `delta` (a share of the
 * whole split, positive = towards the end), keeping both neighbours at least
 * MIN_SPLIT_SHARE. Returns new weights summing to the same total.
 */
export function resizeSplit(sizes: number[], index: number, delta: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  const a = sizes[index];
  const b = sizes[index + 1];
  if (a === undefined || b === undefined || total <= 0) return sizes;
  const min = MIN_SPLIT_SHARE * total;
  const move = Math.max(min - a, Math.min(b - min, delta * total));
  const next = [...sizes];
  next[index] = a + move;
  next[index + 1] = b - move;
  return next;
}

/**
 * Adds `chatId` as a tab (if it isn't one) and shows it beside the chat on
 * show, never over it: one pane splits in two, and with more panes it takes
 * an empty one, else the one after the focused pane. Only what the user asks
 * to be a tab becomes one, so the chat on show (opened from the sidebar, say)
 * stays out of the tabs; covering it would lose it from view. A viewer popped
 * out of its chat still takes the chat's pane, which closing it hands back.
 */
export function openTab(state: PaneState, chatId: string): PaneState {
  const next = { ...state, tabs: state.tabs.includes(chatId) ? state.tabs : [...state.tabs, chatId] };
  const shown = state.panes[state.focusedPane] ?? null;
  if (shown === null || state.panes.includes(chatId) || parseViewTab(chatId) !== null) return showChat(next, chatId);
  if (state.panes.length === 1) return { ...next, layout: 'columns-2', panes: [shown, chatId], focusedPane: 1, maximised: false };
  const empty = state.panes.indexOf(null);
  const target = empty !== -1 ? empty : (state.focusedPane + 1) % state.panes.length;
  return { ...next, panes: state.panes.map((id, i) => (i === target ? chatId : id)), focusedPane: target, maximised: false };
}

/**
 * Removes the tab and takes it out of any pane showing it, so the pane
 * doesn't sit on a chat with no tab left to close it by. A viewer tab (Deck
 * #826) hands its pane back to the file's chat when no other pane shows that
 * chat. Otherwise the pane takes the next tab not already showing, or empties.
 * A project page or an app's home goes with its tab: its pane is emptied.
 */
export function closeTab(state: PaneState, chatId: string): PaneState {
  // A project page goes even without a tab (an old saved layout), or its pane would be stuck on it. An app's home the same.
  if (parseProjectTab(chatId) !== null) return forgetProject(state, parseProjectTab(chatId)!);
  if (parseAppTab(chatId) !== null) return forgetApp(state, parseAppTab(chatId)!);
  if (!state.tabs.includes(chatId)) return state;
  const tabs = state.tabs.filter((id) => id !== chatId);
  if (!state.panes.includes(chatId)) return { ...state, tabs };
  const view = parseViewTab(chatId);
  const panes = state.panes.map((id) => (id === chatId ? null : id));
  const waiting = view && !panes.includes(view.chatId) ? [view.chatId] : tabs.filter((id) => !panes.includes(id));
  return { ...state, tabs, panes: panes.map((id, i) => (state.panes[i] === chatId ? (waiting.shift() ?? null) : id)) };
}

/** A deleted chat leaves the tabs and every pane, with its viewer tabs. */
export function forgetChat(state: PaneState, chatId: string): PaneState {
  const gone = (id: string | null): boolean => id === chatId || (id !== null && parseViewTab(id)?.chatId === chatId);
  if (!state.tabs.some(gone) && !state.panes.some(gone)) return state;
  return { ...state, tabs: state.tabs.filter((id) => !gone(id)), panes: state.panes.map((id) => (gone(id) ? null : id)) };
}

/** A deleted project's page leaves the tabs and every pane. */
export function forgetProject(state: PaneState, projectId: string): PaneState {
  const tab = projectTabId(projectId);
  if (!state.tabs.includes(tab) && !state.panes.includes(tab)) return state;
  return { ...state, tabs: state.tabs.filter((id) => id !== tab), panes: state.panes.map((id) => (id === tab ? null : id)) };
}

/** A deleted app's home leaves the tabs and every pane, as `forgetProject`. Its chats are the caller's to forget. */
export function forgetApp(state: PaneState, appId: string): PaneState {
  const tab = appTabId(appId);
  if (!state.tabs.includes(tab) && !state.panes.includes(tab)) return state;
  return { ...state, tabs: state.tabs.filter((id) => id !== tab), panes: state.panes.map((id) => (id === tab ? null : id)) };
}

/** Moves the tab `chatId` so it sits before `beforeId` (null = the end). */
export function moveTab(state: PaneState, chatId: string, beforeId: string | null): PaneState {
  if (!state.tabs.includes(chatId) || chatId === beforeId) return state;
  const rest = state.tabs.filter((id) => id !== chatId);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  if (at === -1) return state;
  return { ...state, tabs: [...rest.slice(0, at), chatId, ...rest.slice(at)] };
}

/** The pane state saved under `key` (Chat mode's by default), repaired; the default for anything missing or unreadable. */
export function loadPaneState(key: string = PANE_STATE_STORAGE_KEY): PaneState {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return DEFAULT_PANE_STATE;
    const parsed = JSON.parse(raw) as Partial<PaneState>;
    const layout = LAYOUTS.some((l) => l.id === parsed.layout) ? (parsed.layout as Layout) : 'single';
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : []);
    const count = paneCount(layout);
    const stored = Array.isArray(parsed.panes) ? parsed.panes : [];
    const panes = Array.from({ length: count }, (_, i) => (typeof stored[i] === 'string' ? (stored[i] as string) : null));
    const focusedPane = typeof parsed.focusedPane === 'number' && parsed.focusedPane >= 0 && parsed.focusedPane < count ? parsed.focusedPane : 0;
    const sizes: Record<string, number[]> = {};
    if (parsed.sizes && typeof parsed.sizes === 'object' && !Array.isArray(parsed.sizes)) {
      for (const [key, value] of Object.entries(parsed.sizes)) {
        if (Array.isArray(value) && value.length >= 2 && value.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) sizes[key] = value as number[];
      }
    }
    const maximised = parsed.maximised === true && count > 1;
    return { tabs: [...new Set(ids(parsed.tabs))], layout, panes, focusedPane, sizes, maximised };
  } catch {
    return DEFAULT_PANE_STATE;
  }
}

export function savePaneState(state: PaneState, key: string = PANE_STATE_STORAGE_KEY): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // storage blocked or full -- the layout still applies for this session.
  }
}
