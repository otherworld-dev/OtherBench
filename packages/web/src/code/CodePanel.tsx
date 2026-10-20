import { useId, useRef, type JSX, type KeyboardEvent } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import { Inspector } from '../panes/Inspector.js';
import { parseAppTab } from '../state/appTab.js';
import { isChatTab } from '../state/projectTab.js';
import { useOtherBenchStore, type CodePanelTab } from '../state/store.js';
import { isViewTab, parseViewTab } from '../viewer/items.js';
import { FilesTab } from './FilesTab.js';
import { IssuesTab } from './IssuesTab.js';

const TABS: { id: CodePanelTab; label: string }[] = [
  { id: 'issues', label: 'Issues' },
  { id: 'files', label: 'Files' },
  { id: 'chat', label: 'Chat' },
];

/**
 * The chat the focused pane is about: the chat itself, or the chat a popped-out
 * viewer tab belongs to (its file is that chat's), else none (an app home, an
 * empty pane).
 */
function focusedChat(activeId: string | null, chats: Chat[]): Chat | null {
  const id = isViewTab(activeId) ? (parseViewTab(activeId)?.chatId ?? null) : isChatTab(activeId) ? activeId : null;
  return id === null ? null : (chats.find((c) => c.id === id) ?? null);
}

/**
 * Code mode's right column (spec 2026-10-20-code-tab-design, layout A and
 * "Code is a whole-window mode"): Issues, Files, and Chat, which holds the
 * Inspector so nothing it shows is lost ("Calls I made"). It follows the
 * focused pane's app: the app chat's `appId`, or the app tab's id, so with two
 * app chats side by side the focused one wins. With neither (an empty pane)
 * there is no app to show. The tab is remembered per browser
 * (`codePanelTab`). App.tsx renders this in place of the Inspector in Code
 * mode, docked or as the narrow overlay, and it collapses to a strip the same
 * way.
 */
export function CodePanel({ collapsed, onToggleCollapsed }: { collapsed: boolean; onToggleCollapsed: () => void }): JSX.Element {
  const activeChatId = useOtherBenchStore((s) => s.activeChatId);
  const chats = useOtherBenchStore((s) => s.chats);
  const apps = useOtherBenchStore((s) => s.apps);
  const profiles = useOtherBenchStore((s) => s.profiles);
  const tab = useOtherBenchStore((s) => s.codePanelTab);
  const setTab = useOtherBenchStore((s) => s.setCodePanelTab);
  const tabRefs = useRef(new Map<CodePanelTab, HTMLButtonElement>());
  const baseId = useId();

  const chat = focusedChat(activeChatId, chats);
  const appId = chat?.appId ?? parseAppTab(activeChatId);
  const app = appId === null ? null : (apps.find((a) => a.id === appId) ?? null);
  const profile = chat ? (profiles.find((p) => p.id === chat.profileId) ?? null) : null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="Expand code panel"
        aria-expanded={false}
        className="flex h-full w-9 flex-col items-center justify-center gap-2 border-l border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <span className="[writing-mode:vertical-rl] text-xs tracking-wide">{TABS.find((t) => t.id === tab)?.label ?? 'Issues'}</span>
      </button>
    );
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const next = e.key === 'ArrowRight' ? TABS[(index + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(index + TABS.length - 1) % TABS.length] : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS.at(-1) : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next.id);
    tabRefs.current.get(next.id)?.focus();
  }

  let body: JSX.Element;
  if (tab === 'chat') {
    // The Inspector brings its own header; its ✕ collapses this whole panel, as it collapses itself in Chat mode.
    body = <Inspector chat={chat} profile={profile} collapsed={false} onToggleCollapsed={onToggleCollapsed} />;
  } else if (!app) {
    body = (
      <p data-testid="code-panel-empty" className="p-4 text-sm text-[var(--text-faint)]">
        {appId !== null ? "This chat's app isn't loaded." : 'Pick an app or a chat'}
      </p>
    );
  } else {
    body = (
      <div className="h-full min-h-0 overflow-y-auto p-3">
        {tab === 'issues' ? <IssuesTab key={app.id} app={app} /> : <FilesTab key={app.id} app={app} chatId={chat?.appId === app.id ? chat.id : null} />}
      </div>
    );
  }

  return (
    <aside aria-label="Code panel" data-testid="code-panel" className="flex h-full w-full min-w-0 flex-col border-l border-[var(--border)] bg-[var(--bg-raised)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 pt-1.5">
        <div role="tablist" aria-label="Panel" className="flex min-w-0 flex-1 items-end gap-0.5">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                if (el) tabRefs.current.set(t.id, el);
                else tabRefs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              data-testid={`code-panel-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${baseId}-body`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`rounded-t border border-b-0 px-2.5 py-1 text-xs ${tab === t.id ? 'border-[var(--border)] bg-[var(--bg)] text-[var(--text)]' : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {app && <span className="mb-1 min-w-0 truncate text-xs text-[var(--text-muted)]" title={app.name}>{app.name}</span>}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Collapse code panel"
          aria-expanded={true}
          className="mb-1 shrink-0 text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          ✕
        </button>
      </div>
      <div id={`${baseId}-body`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`} className="min-h-0 flex-1">
        {body}
      </div>
    </aside>
  );
}
