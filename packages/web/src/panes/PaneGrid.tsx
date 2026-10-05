import { useState, type DragEvent, type JSX } from 'react';
import type { Layout } from '../state/panes.js';
import { useGruntStore } from '../state/store.js';
import { useChatSync } from '../state/useChatSync.js';
import { CHAT_DRAG_MIME } from './sidebar/ChatRow.js';
import { TAB_DRAG_MIME } from './TabBar.js';
import { Thread } from './Thread.js';

const GRID: Record<Layout, string> = {
  single: 'grid-cols-1 grid-rows-1',
  'columns-2': 'grid-cols-2 grid-rows-1',
  'rows-2': 'grid-cols-1 grid-rows-2',
  'columns-3': 'grid-cols-3 grid-rows-1',
};

/** One pane: its own live connection to its chat, and a full thread with its own message box. */
function Pane({ index, chatId, focused, multi }: { index: number; chatId: string | null; focused: boolean; multi: boolean }): JSX.Element {
  const chat = useGruntStore((s) => (chatId ? (s.chats.find((c) => c.id === chatId) ?? null) : null));
  const focusPane = useGruntStore((s) => s.focusPane);
  const setActiveChatId = useGruntStore((s) => s.setActiveChatId);
  const [dropActive, setDropActive] = useState(false);
  useChatSync(chatId, focused);

  const carriesChat = (e: DragEvent): boolean => {
    const types = Array.from(e.dataTransfer.types);
    return types.includes(CHAT_DRAG_MIME) || types.includes(TAB_DRAG_MIME);
  };

  return (
    <div
      data-testid={`pane-${index}`}
      data-focused={focused ? 'true' : undefined}
      // Clicking or tabbing anywhere into a pane makes its chat the active one.
      onMouseDownCapture={() => focusPane(index)}
      onFocusCapture={() => focusPane(index)}
      onDragOver={(e) => {
        if (!multi || !carriesChat(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dropActive) setDropActive(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setDropActive(false);
      }}
      onDrop={(e) => {
        setDropActive(false);
        const id = e.dataTransfer.getData(TAB_DRAG_MIME) || e.dataTransfer.getData(CHAT_DRAG_MIME);
        if (!multi || !id) return;
        e.preventDefault();
        focusPane(index);
        setActiveChatId(id);
      }}
      className={`flex min-h-0 min-w-0 flex-col ${multi ? 'border border-[var(--border)]' : ''} ${
        multi && focused ? 'border-[var(--accent)]' : ''
      } ${dropActive ? 'ring-2 ring-inset ring-[var(--accent)]' : ''}`}
    >
      {multi && (
        <div className={`truncate border-b border-[var(--border)] px-3 py-1 text-xs ${focused ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>
          <span className="mr-1.5 tabular-nums text-[var(--text-faint)]">{index + 1}</span>
          {chat?.title ?? 'Empty -- pick a chat or drag one here'}
        </div>
      )}
      <Thread chat={chat} />
    </div>
  );
}

/**
 * The chat area (#824): one, two or three panes in the chosen layout, each a
 * full chat. The focused pane's chat is the active one, so the Inspector and
 * the sidebar highlight follow it. A narrow window always shows just the
 * focused pane.
 */
export function PaneGrid({ narrow }: { narrow: boolean }): JSX.Element {
  const paneState = useGruntStore((s) => s.paneState);
  const activeChatId = useGruntStore((s) => s.activeChatId);
  const layout: Layout = narrow ? 'single' : paneState.layout;
  const indices = narrow ? [paneState.focusedPane] : paneState.panes.map((_, i) => i);
  const multi = indices.length > 1;

  return (
    <main className={`grid h-full min-h-0 min-w-0 flex-1 gap-1 ${multi ? 'p-1' : ''} ${GRID[layout]}`}>
      {indices.map((i) => (
        <Pane key={i} index={i} chatId={i === paneState.focusedPane ? activeChatId : (paneState.panes[i] ?? null)} focused={i === paneState.focusedPane} multi={multi} />
      ))}
    </main>
  );
}
