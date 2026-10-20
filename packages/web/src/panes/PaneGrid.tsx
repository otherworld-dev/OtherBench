import { Fragment, useState, type DragEvent, type JSX } from 'react';
import { projectDisplayNameById } from '@otherbench/core/domain/projects.js';
import { AppHome } from '../code/AppHome.js';
import { parseAppTab } from '../state/appTab.js';
import { defaultSizes, LAYOUT_TREES, splitKey, type Layout, type SplitNode } from '../state/panes.js';
import { isChatTab, parseProjectTab } from '../state/projectTab.js';
import { useOtherBenchStore } from '../state/store.js';
import { useChatSync } from '../state/useChatSync.js';
import { CHAT_DRAG_MIME } from './sidebar/ChatRow.js';
import { Splitter } from './Splitter.js';
import { TAB_DRAG_MIME } from './TabBar.js';
import { Thread } from './Thread.js';
import { isViewTab, itemName, parseViewTab } from '../viewer/items.js';
import { ViewerTab } from '../viewer/ViewerTab.js';
import { ProjectHome } from '../views/ProjectHome.js';

interface PaneProps {
  index: number;
  chatId: string | null;
  focused: boolean;
  /** The layout has more than one pane: show a header, accept drops. */
  multi: boolean;
  maximised: boolean;
}

/** One pane: its own live connection to its chat, and a full thread with its own message box. */
function Pane({ index, chatId, focused, multi, maximised }: PaneProps): JSX.Element {
  // A viewer item popped out into its own tab (Deck #826), or a project's home page, holds the pane instead of a chat.
  const view = isViewTab(chatId) ? parseViewTab(chatId) : null;
  const projectId = parseProjectTab(chatId);
  const projectName = useOtherBenchStore((s) =>
    projectId === null ? null : (projectDisplayNameById(s.projects, projectId) ?? (s.projectsLoaded ? 'Missing project' : 'Loading…'))
  );
  // An app's home (spec 2026-10-20-code-tab-design), named the same way.
  const appId = parseAppTab(chatId);
  const appName = useOtherBenchStore((s) => (appId === null ? null : (s.apps.find((a) => a.id === appId)?.name ?? (s.appsLoaded ? 'Missing app' : 'Loading…'))));
  const chat = useOtherBenchStore((s) => (isChatTab(chatId) ? (s.chats.find((c) => c.id === chatId) ?? null) : null));
  const focusPane = useOtherBenchStore((s) => s.focusPane);
  const setActiveChatId = useOtherBenchStore((s) => s.setActiveChatId);
  const toggleMaximised = useOtherBenchStore((s) => s.toggleMaximised);
  const [dropActive, setDropActive] = useState(false);
  useChatSync(isChatTab(chatId) ? chatId : null, focused);

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
      className={`flex h-full min-h-0 w-full min-w-0 flex-col ${multi ? 'border border-[var(--border)]' : ''} ${
        multi && focused ? 'border-[var(--accent)]' : ''
      } ${dropActive ? 'ring-2 ring-inset ring-[var(--accent)]' : ''}`}
    >
      {multi && (
        <div
          onDoubleClick={toggleMaximised}
          className={`flex items-center gap-1.5 border-b border-[var(--border)] px-3 py-1 text-xs ${focused ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}
        >
          <span className="tabular-nums text-[var(--text-faint)]">{index + 1}</span>
          <span className="min-w-0 flex-1 truncate">{view ? itemName(view.item) : (projectName ?? appName ?? chat?.title ?? 'Empty -- pick a chat or drag one here')}</span>
          <button
            type="button"
            aria-label={maximised ? 'Restore pane' : 'Maximise pane'}
            aria-pressed={maximised}
            title={maximised ? 'Restore the layout (Ctrl+Shift+Enter)' : 'Fill the chat area with this pane (Ctrl+Shift+Enter)'}
            onClick={() => {
              focusPane(index);
              toggleMaximised();
            }}
            className="shrink-0 rounded px-1 text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
          >
            <span aria-hidden="true">{maximised ? '⤡' : '⤢'}</span>
          </button>
        </div>
      )}
      {isViewTab(chatId) ? <ViewerTab tabId={chatId} /> : projectId !== null ? (
        <ProjectHome projectId={projectId} />
      ) : appId !== null ? (
        <AppHome appId={appId} />
      ) : (
        <Thread chat={chat} />
      )}
    </div>
  );
}

function containsPane(node: SplitNode, index: number): boolean {
  return 'split' in node ? node.children.some((c) => containsPane(c, index)) : node.pane === index;
}

interface SplitProps {
  layout: Layout;
  node: SplitNode;
  renderPane: (index: number) => JSX.Element;
  /** Show only this pane (maximised, or a narrow window); the rest stay mounted but hidden, so nothing reconnects or loses a draft. */
  only: number | null;
}

/** A split from the layout tree: its children side by side or stacked, with a draggable divider between each pair. */
function Split({ layout, node, renderPane, only }: SplitProps): JSX.Element {
  const stored = useOtherBenchStore((s) => ('split' in node ? s.paneState.sizes[splitKey(layout, node.id)] : undefined));
  const setSplitSizes = useOtherBenchStore((s) => s.setSplitSizes);
  const [dragging, setDragging] = useState<number[] | null>(null);
  if (!('split' in node)) return renderPane(node.pane);

  const key = splitKey(layout, node.id);
  const start = defaultSizes(layout, node.id, node.children.length);
  const sizes = dragging ?? (stored && stored.length === node.children.length ? stored : start);

  return (
    <div className={`flex h-full min-h-0 w-full min-w-0 ${node.split === 'row' ? 'flex-row' : 'flex-col'}`} data-split={node.id}>
      {node.children.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && only === null && (
            <Splitter
              direction={node.split}
              sizes={sizes}
              index={i - 1}
              onResize={setDragging}
              onCommit={(next) => {
                setDragging(null);
                setSplitSizes(key, next);
              }}
              onReset={() => {
                setDragging(null);
                setSplitSizes(key, start);
              }}
            />
          )}
          <div
            className="min-h-0 min-w-0"
            style={only !== null && !containsPane(child, only) ? { display: 'none' } : { flex: only === null ? `${sizes[i] ?? 1} 1 0` : '1 1 0' }}
          >
            <Split layout={layout} node={child} renderPane={renderPane} only={only} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The chat area (#824): the chosen layout's panes, each a full chat, split by
 * draggable dividers whose sizes are remembered per layout. The focused pane's
 * chat is the active one, so the Inspector and the sidebar highlight follow
 * it. A maximised pane, or a narrow window, shows just the focused pane.
 */
export function PaneGrid({ narrow }: { narrow: boolean }): JSX.Element {
  const paneState = useOtherBenchStore((s) => s.paneState);
  const activeChatId = useOtherBenchStore((s) => s.activeChatId);
  const multi = !narrow && paneState.panes.length > 1;
  const solo = narrow || paneState.maximised;

  const renderPane = (i: number): JSX.Element => (
    <Pane
      key={i}
      index={i}
      chatId={i === paneState.focusedPane ? activeChatId : (paneState.panes[i] ?? null)}
      focused={i === paneState.focusedPane}
      multi={multi}
      maximised={multi && paneState.maximised}
    />
  );

  return (
    <main className={`flex h-full min-h-0 min-w-0 flex-1 ${multi && !solo ? 'p-1' : ''}`}>
      <Split layout={paneState.layout} node={LAYOUT_TREES[paneState.layout]} renderPane={renderPane} only={solo ? paneState.focusedPane : null} />
    </main>
  );
}
