import { create } from 'zustand';
import { itemKey, parseViewTab, viewTabId, type ViewItem } from './items.js';

/** One chat's viewer panel (spec 2026-10-07-viewer), remembered on this device. */
export interface ChatViewer {
  open: boolean;
  mode: 'files' | 'item';
  history: ViewItem[];
  /** The item shown: an index into `history`, -1 for none. */
  index: number;
  /** The panel's share of the pane's width. */
  share: number;
}

export const DEFAULT_VIEWER: ChatViewer = { open: false, mode: 'files', history: [], index: -1, share: 0.45 };
export const VIEWER_STORAGE_KEY = 'grunt.viewers';
export const MAX_VIEWER_HISTORY = 30;
export const MAX_VIEWER_CHATS = 50;

const same = (a: ViewItem, b: ViewItem): boolean => itemKey(a) === itemKey(b);

function withItem(v: ChatViewer, item: ViewItem): ChatViewer {
  const current = v.history[v.index];
  if (current && same(current, item)) return { ...v, open: true, mode: 'item' };
  const history = [...v.history.slice(0, v.index + 1), item].slice(-MAX_VIEWER_HISTORY);
  return { ...v, open: true, mode: 'item', history, index: history.length - 1 };
}

function stepped(v: ChatViewer, delta: -1 | 1): ChatViewer {
  const index = v.index + delta;
  return index < 0 || index >= v.history.length ? v : { ...v, index, mode: 'item' };
}

function valid(v: unknown): v is ChatViewer {
  const x = v as ChatViewer;
  return (
    typeof x === 'object' && x !== null && typeof x.open === 'boolean' && (x.mode === 'files' || x.mode === 'item') &&
    Array.isArray(x.history) && x.history.every((i) => parseViewTab(viewTabId('x', i)) !== null) &&
    Number.isInteger(x.index) && x.index >= -1 && x.index < x.history.length && typeof x.share === 'number'
  );
}

function load(): Record<string, ChatViewer> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VIEWER_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, ChatViewer] => valid(e[1])));
  } catch {
    return {};
  }
}

function save(viewers: Record<string, ChatViewer>): void {
  try {
    window.localStorage.setItem(VIEWER_STORAGE_KEY, JSON.stringify(viewers));
  } catch {
    // storage blocked or full -- the panel still works for this session.
  }
}

/** `viewers` with `chatId` last (most recent) and only the newest MAX_VIEWER_CHATS kept. */
function trimmed(viewers: Record<string, ChatViewer>, chatId: string): Record<string, ChatViewer> {
  const mine = viewers[chatId]!;
  const rest = Object.entries(viewers).filter(([id]) => id !== chatId);
  return Object.fromEntries([...rest.slice(Math.max(0, rest.length - (MAX_VIEWER_CHATS - 1))), [chatId, mine]]);
}

export function viewerFor(viewers: Record<string, ChatViewer>, chatId: string): ChatViewer {
  return viewers[chatId] ?? DEFAULT_VIEWER;
}

interface ViewerStore {
  viewers: Record<string, ChatViewer>;
  /** Shows `item` in the chat's panel, opening it. */
  openItem(chatId: string, item: ViewItem): void;
  setOpen(chatId: string, open: boolean): void;
  setMode(chatId: string, mode: ChatViewer['mode']): void;
  step(chatId: string, delta: -1 | 1): void;
  setShare(chatId: string, share: number): void;
}

export const useViewerStore = create<ViewerStore>()((set) => {
  const update = (chatId: string, change: (v: ChatViewer) => ChatViewer): void =>
    set((s) => {
      const viewers = trimmed({ ...s.viewers, [chatId]: change(viewerFor(s.viewers, chatId)) }, chatId);
      save(viewers);
      return { viewers };
    });
  return {
    viewers: load(),
    openItem: (chatId, item) => update(chatId, (v) => withItem(v, item)),
    setOpen: (chatId, open) => update(chatId, (v) => ({ ...v, open })),
    setMode: (chatId, mode) => update(chatId, (v) => ({ ...v, mode })),
    step: (chatId, delta) => update(chatId, (v) => stepped(v, delta)),
    setShare: (chatId, share) => update(chatId, (v) => ({ ...v, share: Math.min(0.8, Math.max(0.2, share)) })),
  };
});
