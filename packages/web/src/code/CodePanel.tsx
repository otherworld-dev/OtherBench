import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { Menu } from '../components/Menu.js';
import { Inspector } from '../panes/Inspector.js';
import { useOtherBenchStore, type CodePanelTab } from '../state/store.js';
import { DeckTab } from './DeckTab.js';
import { FilesTab } from './FilesTab.js';
import { IssuesTab } from './IssuesTab.js';
import { LinksTab } from './LinksTab.js';
import { panelApp, viewOwner } from './panelOwner.js';
import { useTerminalStatus } from './terminal/status.js';
import { TerminalTab } from './terminal/TerminalTab.js';
import { visibleTabs } from './visibleTabs.js';
import { WikiTab } from './WikiTab.js';

const BASE_TABS: { id: CodePanelTab; label: string }[] = [
  { id: 'issues', label: 'Issues' },
  { id: 'deck', label: 'Deck' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'links', label: 'Links' },
  { id: 'files', label: 'Files' },
  { id: 'chat', label: 'Chat' },
];
/** Only where this server has terminals (spec 2026-10-21-code-terminal-design): a local server with a PTY. Terminal sits before Chat. */
const WITH_TERMINAL: { id: CodePanelTab; label: string }[] = [...BASE_TABS.slice(0, -1), { id: 'terminal', label: 'Terminal' }, ...BASE_TABS.slice(-1)];
/** Width kept for the "»" button, and the gap between tabs, when working out how many tabs fit. */
const OVERFLOW_BUTTON_PX = 32;
const TAB_GAP_PX = 2;

/**
 * Code mode's right column (spec 2026-10-20-code-tab-design, layout A and
 * "Code is a whole-window mode"): Issues, Files, and Chat, which holds the
 * Inspector so nothing it shows is lost ("Calls I made"). It follows the
 * focused pane's app: the app chat's `appId`, or the app tab's id, so with two
 * app chats side by side the focused one wins. With neither (an empty pane)
 * there is no app to show. The Issues tab is the focused chat's own
 * (`IssuesTab`'s `owner`). The tab is remembered per browser
 * (`codePanelTab`). App.tsx renders this in place of the Inspector in Code
 * mode, docked or as the narrow overlay, and it collapses to a strip the same
 * way.
 */
export function CodePanel({ collapsed, onToggleCollapsed }: { collapsed: boolean; onToggleCollapsed: () => void }): JSX.Element {
  const activeChatId = useOtherBenchStore((s) => s.activeChatId);
  const chats = useOtherBenchStore((s) => s.chats);
  const apps = useOtherBenchStore((s) => s.apps);
  const profiles = useOtherBenchStore((s) => s.profiles);
  const savedTab = useOtherBenchStore((s) => s.codePanelTab);
  const setTab = useOtherBenchStore((s) => s.setCodePanelTab);
  const terminals = useTerminalStatus()?.available === true;
  const TABS = terminals ? WITH_TERMINAL : BASE_TABS;
  // A saved Terminal tab on a server without terminals (or before that's known) shows Issues.
  const tab: CodePanelTab = savedTab === 'terminal' && !terminals ? 'issues' : savedTab;
  const tabRefs = useRef(new Map<CodePanelTab, HTMLButtonElement>());
  const baseId = useId();
  const stripRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [fits, setFits] = useState(Number.POSITIVE_INFINITY);
  const [morePos, setMorePos] = useState<{ x: number; y: number } | null>(null);
  const tabKey = TABS.map((t) => t.id).join();

  // How many tabs fit: the strip's width against the tabs' natural widths (an
  // invisible row measures them). Without ResizeObserver (jsdom) all fit.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (collapsed || !strip || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const widths = Array.from(measureRef.current?.children ?? [], (el) => (el as HTMLElement).offsetWidth);
      if (widths.length === 0 || widths.every((w) => w === 0)) return;
      const total = widths.reduce((a, w) => a + w + TAB_GAP_PX, -TAB_GAP_PX);
      if (total <= strip.clientWidth) return setFits(widths.length);
      let room = strip.clientWidth - OVERFLOW_BUTTON_PX;
      let n = 0;
      for (const w of widths) {
        if (room < w) break;
        room -= w + TAB_GAP_PX;
        n++;
      }
      setFits(Math.max(1, n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [collapsed, tabKey]);

  // The menu is anchored to the button; close it if the strip changes under it.
  useEffect(() => setMorePos(null), [fits]);

  const { chat, appId, app } = panelApp(activeChatId, chats, apps);
  const profile = chat ? (profiles.find((p) => p.id === chat.profileId) ?? null) : null;

  const { shown, overflow } = visibleTabs(TABS, tab, fits);

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
    const next = e.key === 'ArrowRight' ? shown[(index + 1) % shown.length] : e.key === 'ArrowLeft' ? shown[(index + shown.length - 1) % shown.length] : e.key === 'Home' ? shown[0] : e.key === 'End' ? shown.at(-1) : undefined;
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
  } else if (tab === 'terminal') {
    // Its own layout: the strip and a screen that fills the panel. Keyed by app, so each app's tab starts fresh.
    body = <TerminalTab key={app.id} app={app} />;
  } else {
    // Each chat keeps its own Issues view (an issue open while it's worked on); an app home has one too.
    const issuesOwner = viewOwner(app, chat);
    body = (
      <div className="h-full min-h-0 overflow-y-auto p-3">
        {tab === 'issues' ? (
          <IssuesTab key={issuesOwner} app={app} owner={issuesOwner} />
        ) : tab === 'deck' ? (
          <DeckTab key={issuesOwner} app={app} owner={issuesOwner} />
        ) : tab === 'wiki' ? (
          <WikiTab key={issuesOwner} app={app} owner={issuesOwner} />
        ) : tab === 'links' ? (
          <LinksTab key={app.id} app={app} />
        ) : (
          <FilesTab key={app.id} app={app} chatId={chat?.appId === app.id ? chat.id : null} />
        )}
      </div>
    );
  }

  return (
    <aside aria-label="Code panel" data-testid="code-panel" className="flex h-full w-full min-w-0 flex-col border-l border-[var(--border)] bg-[var(--bg-raised)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 pt-1.5">
        {/* overflow-hidden: the invisible measuring row below is as wide as every tab, and must never make the strip scroll. */}
        <div ref={stripRef} className="relative flex min-w-0 flex-1 items-end gap-0.5 overflow-hidden">
          <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex gap-0.5 whitespace-nowrap">
            {TABS.map((t) => (
              <span key={t.id} className="border px-2 py-1 text-xs">
                {t.label}
              </span>
            ))}
          </div>
          <div role="tablist" aria-label="Panel" className="flex min-w-0 items-end gap-0.5">
          {shown.map((t, i) => (
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
              className={`rounded-t border border-b-0 px-2 py-1 text-xs ${tab === t.id ? 'border-[var(--border)] bg-[var(--bg)] text-[var(--text)]' : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]'}`}
            >
              {t.label}
            </button>
          ))}
          </div>
          {overflow.length > 0 && (
            <button
              ref={moreRef}
              type="button"
              aria-label="More tabs"
              aria-haspopup="menu"
              aria-expanded={morePos !== null}
              onClick={() => {
                const rect = moreRef.current?.getBoundingClientRect();
                setMorePos(rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 });
              }}
              className="shrink-0 rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]"
            >
              »
            </button>
          )}
        </div>
        {/* At most a quarter of the header, so a long name can't push the tabs into More tabs; the full name is its title. */}
        {app && (
          <span data-testid="code-panel-app-name" className="mb-1 min-w-0 max-w-[25%] truncate text-xs text-[var(--text-muted)]" title={app.name}>
            {app.name}
          </span>
        )}
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
      {morePos && overflow.length > 0 && (
        <Menu
          label="More tabs"
          position={morePos}
          items={overflow.map((t) => ({ id: t.id, label: t.label, onSelect: () => setTab(t.id) }))}
          onClose={(reason) => {
            setMorePos(null);
            if (reason === 'dismiss') moreRef.current?.focus();
          }}
        />
      )}
      <div id={`${baseId}-body`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`} className="min-h-0 flex-1">
        {body}
      </div>
    </aside>
  );
}
