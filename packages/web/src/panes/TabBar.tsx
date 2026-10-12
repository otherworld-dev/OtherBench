import { useMemo, useRef, useState, type DragEvent, type JSX, type KeyboardEvent } from 'react';
import { Menu } from '../components/Menu.js';
import { LAYOUTS, type Layout } from '../state/panes.js';
import { useGruntStore } from '../state/store.js';
import { CHAT_DRAG_MIME } from './sidebar/ChatRow.js';
import { itemName, parseViewTab } from '../viewer/items.js';

/** `dataTransfer` type a dragged tab carries; its value is the chat id. */
export const TAB_DRAG_MIME = 'application/x-grunt-tab';

function carries(e: DragEvent, type: string): boolean {
  return Array.from(e.dataTransfer.types).includes(type);
}

/** Small pictures of each layout for the picker. */
function LayoutIcon({ layout }: { layout: Layout }): JSX.Element {
  const cells: Record<Layout, [number, number, number, number][]> = {
    single: [[1, 1, 14, 10]],
    'columns-2': [[1, 1, 6.5, 10], [8.5, 1, 6.5, 10]],
    'rows-2': [[1, 1, 14, 4.5], [1, 6.5, 14, 4.5]],
    'columns-3': [[1, 1, 4, 10], [6, 1, 4, 10], [11, 1, 4, 10]],
    'main-right-2': [[1, 1, 8.5, 10], [10.5, 1, 4.5, 4.5], [10.5, 6.5, 4.5, 4.5]],
    'grid-4': [[1, 1, 6.5, 4.5], [8.5, 1, 6.5, 4.5], [1, 6.5, 6.5, 4.5], [8.5, 6.5, 6.5, 4.5]],
  };
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
      {cells[layout].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      ))}
    </svg>
  );
}

/**
 * Tabs across the top of the chat area (#824): chats the user opened as tabs
 * ("Open in new tab", or dragging a chat here), from any project, plus the
 * layout picker. A tab shows its chat in the focused pane, or focuses the
 * pane already showing it; in a multi-pane layout each visible tab is
 * numbered with its pane. ✕ only closes the tab. A dot marks a chat that is
 * replying or waiting for an approval, a question or a plan. Hidden while there are no tabs and
 * one pane.
 */
export function TabBar({ narrow }: { narrow: boolean }): JSX.Element | null {
  const chats = useGruntStore((s) => s.chats);
  const paneState = useGruntStore((s) => s.paneState);
  const activeChatId = useGruntStore((s) => s.activeChatId);
  const pending = useGruntStore((s) => s.appPendingApprovals);
  const running = useGruntStore((s) => s.appRunningTurns);
  const setActiveChatId = useGruntStore((s) => s.setActiveChatId);
  const openTab = useGruntStore((s) => s.openTab);
  const closeTab = useGruntStore((s) => s.closeTab);
  const moveTab = useGruntStore((s) => s.moveTab);
  const setLayout = useGruntStore((s) => s.setLayout);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  // The layout picker is one button with a dropdown, rather than a button per layout, to save room.
  const [layoutMenu, setLayoutMenu] = useState<{ x: number; y: number } | null>(null);
  const layoutButton = useRef<HTMLButtonElement>(null);
  const currentLayout = LAYOUTS.find((l) => l.id === paneState.layout) ?? LAYOUTS[0]!;

  const tabs = useMemo(
    () =>
      paneState.tabs.flatMap((id) => {
        const view = parseViewTab(id);
        if (view) return [{ id, title: itemName(view.item) }];
        const chat = chats.find((c) => c.id === id);
        return chat ? [{ id: chat.id, title: chat.title }] : [];
      }),
    [paneState.tabs, chats]
  );
  const waiting = useMemo(() => new Set(Object.values(pending).map((p) => p.chatId)), [pending]);
  const working = useMemo(() => new Set(Object.values(running)), [running]);
  const multi = !narrow && paneState.panes.length > 1;
  const paneOf = (chatId: string): number => (paneState.focusedPane >= 0 && chatId === activeChatId ? paneState.focusedPane : paneState.panes.indexOf(chatId));

  if (tabs.length === 0 && (narrow || paneState.layout === 'single')) return null;

  function select(id: string): void {
    setActiveChatId(id);
    setTimeout(() => tabRefs.current.get(id)?.focus(), 0);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const next = e.key === 'ArrowRight' ? tabs[index + 1] : e.key === 'ArrowLeft' ? tabs[index - 1] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : undefined;
    if (next) {
      e.preventDefault();
      select(next.id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      closeTab(tabs[index]!.id);
    }
  }

  /** A tab dropped here moves; a chat dragged from the sidebar opens as a tab here. */
  function onDrop(e: DragEvent, beforeId: string | null): void {
    const tabId = e.dataTransfer.getData(TAB_DRAG_MIME);
    const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME);
    setDropBefore(undefined);
    if (!tabId && !chatId) return;
    e.preventDefault();
    e.stopPropagation();
    const id = tabId || chatId;
    if (!paneState.tabs.includes(id)) openTab(id);
    moveTab(id, beforeId);
  }

  function onDragOver(e: DragEvent, beforeId: string | null): void {
    if (!carries(e, TAB_DRAG_MIME) && !carries(e, CHAT_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropBefore !== beforeId) setDropBefore(beforeId);
  }

  return (
    <div
      data-testid="tab-bar"
      className="flex items-center gap-1 border-b border-[var(--border)] bg-[var(--bg-raised)] px-2 pt-1.5"
      onDragOver={(e) => onDragOver(e, null)}
      onDragLeave={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setDropBefore(undefined);
      }}
      onDrop={(e) => onDrop(e, null)}
    >
      <div role="tablist" aria-label="Open chats" className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
        {tabs.map((t, index) => {
          const pane = paneOf(t.id);
          const active = t.id === activeChatId;
          const status = waiting.has(t.id) ? 'waiting' : working.has(t.id) ? 'working' : null;
          return (
            <div
              key={t.id}
              data-testid={`tab-${t.id}`}
              data-drop-before={dropBefore === t.id ? 'true' : undefined}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_DRAG_MIME, t.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => setDropBefore(undefined)}
              onDragOver={(e) => onDragOver(e, t.id)}
              onDrop={(e) => onDrop(e, t.id)}
              className={`group flex max-w-[14rem] shrink-0 items-center rounded-t border border-b-0 ${
                active ? 'border-[var(--border)] bg-[var(--bg)]' : 'border-transparent hover:bg-[var(--bg-sunken)]'
              } ${dropBefore === t.id ? 'shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
            >
              <button
                ref={(el) => {
                  if (el) tabRefs.current.set(t.id, el);
                  else tabRefs.current.delete(t.id);
                }}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active || (!tabs.some((x) => x.id === activeChatId) && index === 0) ? 0 : -1}
                onClick={() => select(t.id)}
                onKeyDown={(e) => onKeyDown(e, index)}
                title={t.title}
                className={`flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1 text-xs ${active ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}
              >
                {status && (
                  <span
                    data-testid={`tab-status-${t.id}`}
                    data-status={status}
                    role="img"
                    aria-label={status === 'waiting' ? 'waiting for you' : 'replying'}
                    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${status === 'waiting' ? 'bg-[var(--warn)]' : 'animate-pulse bg-[var(--accent)]'}`}
                  />
                )}
                <span className="truncate">{t.title}</span>
                {multi && pane !== -1 && (
                  <span data-testid={`tab-pane-${t.id}`} className="shrink-0 rounded bg-[var(--bg-sunken)] px-1 text-[0.65rem] tabular-nums" aria-label={`in pane ${pane + 1}`}>
                    {pane + 1}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={`Close tab ${t.title}`}
                title="Close tab (the chat stays in the sidebar)"
                onClick={() => closeTab(t.id)}
                className="mr-1 shrink-0 rounded px-1 text-xs text-[var(--text-muted)] opacity-60 hover:bg-[var(--bg-sunken)] hover:opacity-100 focus-visible:opacity-100"
              >
                ✕
              </button>
            </div>
          );
        })}
        {tabs.length === 0 && <span className="px-2 pb-1 text-xs text-[var(--text-faint)]">Right-click a chat and choose Open in new tab, or drag one here.</span>}
      </div>
      {!narrow && (
        <div className="mb-1 flex shrink-0 items-center">
          <button
            ref={layoutButton}
            type="button"
            aria-label={`Layout: ${currentLayout.label}`}
            aria-haspopup="menu"
            aria-expanded={layoutMenu !== null}
            title="Layout"
            // Keep the open menu's outside-click handler from closing it first, so the button toggles.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              if (layoutMenu) {
                setLayoutMenu(null);
                return;
              }
              const r = e.currentTarget.getBoundingClientRect();
              setLayoutMenu({ x: r.left, y: r.bottom });
            }}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
          >
            <LayoutIcon layout={currentLayout.id} />
            <span aria-hidden="true" className="text-xs leading-none">
              ▾
            </span>
          </button>
          {layoutMenu && (
            <Menu
              label="Layout"
              position={layoutMenu}
              items={LAYOUTS.map((l) => ({ id: l.id, label: l.label, checked: paneState.layout === l.id, onSelect: () => setLayout(l.id) }))}
              onClose={(reason) => {
                setLayoutMenu(null);
                // A click elsewhere keeps focus where the user put it.
                if (reason !== 'pointer') layoutButton.current?.focus();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
