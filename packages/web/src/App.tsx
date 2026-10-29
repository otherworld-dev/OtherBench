import { useEffect, useState, type JSX } from 'react';
import { CodePanel } from './code/CodePanel.js';
import { Toaster } from './components/Toaster.js';
import { ChartIcon, ClockIcon, DockIcon, GearIcon, SignOutIcon } from './components/icons.js';
import { dock, isIndicatorView, isQuickView } from './desktop/bridge.js';
import { useDocks } from './desktop/useDocks.js';
import { NARROW_BREAKPOINT, useMediaQuery } from './lib/useMediaQuery.js';
import { ChatList } from './panes/ChatList.js';
import { Inspector } from './panes/Inspector.js';
import { PaneGrid } from './panes/PaneGrid.js';
import { SidebarResizer } from './panes/sidebar/SidebarResizer.js';
import { PanelResizer } from './panes/PanelResizer.js';
import { codePanelWidth } from './state/panelWidth.js';
import { useTerminalShortcuts } from './code/terminal/useTerminalShortcuts.js';
import { TabBar } from './panes/TabBar.js';
import { api } from './state/api.js';
import { useAuthStore } from './state/auth.js';
import { useOtherBenchStore, WINDOW_ROLE } from './state/store.js';
import { useTextSizeShortcuts } from './state/textSize.js';
import { useDesktopShell } from './desktop/useDesktopShell.js';
import { useOpenArgs } from './desktop/useOpenArgs.js';
import { useTrayStatus } from './desktop/useTrayStatus.js';
import { useUpdateActivity } from './desktop/useUpdateActivity.js';
import { useUpdateHint } from './desktop/useUpdateHint.js';
import { useAppEvents } from './state/useAppEvents.js';
import { OverviewView } from './overview/OverviewView.js';
import { useOverview } from './overview/useOverview.js';
import { useMarkRead } from './state/useMarkRead.js';
import { usePaneShortcuts } from './state/usePaneShortcuts.js';
import { AppView } from './views/AppView.js';
import { IndicatorView } from './views/IndicatorView.js';
import { QuickChat } from './views/QuickChat.js';
import { ProjectView } from './views/ProjectView.js';
import { SettingsView } from './views/SettingsView.js';
import { SchedulesView } from './views/SchedulesView.js';
import { UsageView } from './views/UsageView.js';

/**
 * The quick-chat window gets its own small view (`?view=quick`), and so do
 * the computer-use indicator bar (`?view=indicator`) and an undocked Overview
 * (`?view=overview`); everything else is the main app, an undocked Code
 * window included (locked to Code mode by the store).
 */
export function App(): JSX.Element {
  if (isIndicatorView()) return <IndicatorView />;
  if (isQuickView()) return <QuickChat />;
  return WINDOW_ROLE === 'overview' ? <OverviewWindow /> : <MainApp />;
}

/**
 * Initial reference-data + chat-list load. Individual failures are logged,
 * not thrown -- a transient failure here shouldn't blank the whole shell;
 * panes render their own empty states off whatever did load. But if ALL
 * of them fail, that's not "nothing configured yet", it's "can't reach the
 * server at all", and `unreachable` says so for the banner instead of
 * silently rendering the fresh-install empty state. `loaded` is set once the
 * load has settled, so launch arguments act with the profiles loaded.
 */
function useInitialLoad(): { unreachable: boolean; loaded: boolean } {
  const setConnections = useOtherBenchStore((s) => s.setConnections);
  const setModels = useOtherBenchStore((s) => s.setModels);
  const setProfiles = useOtherBenchStore((s) => s.setProfiles);
  const setChats = useOtherBenchStore((s) => s.setChats);
  const setProjects = useOtherBenchStore((s) => s.setProjects);
  const setApps = useOtherBenchStore((s) => s.setApps);
  const setAppFolders = useOtherBenchStore((s) => s.setAppFolders);

  // A single failed fetch alongside others that succeeded is left alone
  // (console.error only) since that's a partial/transient hiccup, not "there
  // is no server to talk to" -- see task 19/20 brief.
  const [unreachable, setUnreachable] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void Promise.allSettled([
      api.connections.list().then(setConnections),
      api.models.list().then(setModels),
      api.profiles.list().then(setProfiles),
      api.chats.list().then(setChats),
      api.projects.list().then(setProjects),
      api.apps.list().then(setApps),
      api.appFolders.list().then(setAppFolders),
    ]).then((results) => {
      if (cancelled) return;
      const labels = ['connections', 'models', 'profiles', 'chats', 'projects', 'apps', 'app folders'] as const;
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.error(`[otherbench-web] failed to load ${labels[i]}:`, r.reason);
      });
      setUnreachable(results.every((r) => r.status === 'rejected'));
      setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [setConnections, setModels, setProfiles, setChats, setProjects, setApps, setAppFolders]);

  return { unreachable, loaded };
}

/**
 * The Overview in a window of its own (desktop/windows.ts): just the Overview, kept current from the
 * event stream like the main window's. What it opens goes to the window that holds it.
 */
function OverviewWindow(): JSX.Element {
  useInitialLoad();
  useAppEvents();
  useOverview();
  useDocks();
  useTextSizeShortcuts();
  return (
    <div className="h-screen overflow-hidden">
      <Toaster />
      <OverviewView
        action={
          <button
            type="button"
            data-testid="dock-toggle"
            onClick={() => dock('overview').catch((err: unknown) => console.error('[otherbench-web] failed to dock the Overview:', err))}
            aria-label="Put the Overview back in the main window"
            title="Put the Overview back in the main window"
            className="btn px-1.5 py-0.5"
          >
            <DockIcon />
          </button>
        }
      />
    </div>
  );
}

function MainApp(): JSX.Element {
  const chats = useOtherBenchStore((s) => s.chats);
  const profiles = useOtherBenchStore((s) => s.profiles);
  const activeChatId = useOtherBenchStore((s) => s.activeChatId);
  const inspectorCollapsed = useOtherBenchStore((s) => s.inspectorCollapsed);
  const setInspectorCollapsed = useOtherBenchStore((s) => s.setInspectorCollapsed);
  const projectPage = useOtherBenchStore((s) => s.projectPage);
  const closeProjectPage = useOtherBenchStore((s) => s.closeProjectPage);
  const appPage = useOtherBenchStore((s) => s.appPage);
  const closeAppPage = useOtherBenchStore((s) => s.closeAppPage);
  const schedulesPage = useOtherBenchStore((s) => s.schedulesPage);
  const openSchedules = useOtherBenchStore((s) => s.openSchedules);
  const closeSchedules = useOtherBenchStore((s) => s.closeSchedules);

  const mode = useOtherBenchStore((s) => s.mode);
  const overviewOpen = useOtherBenchStore((s) => s.overviewOpen);

  // Sign-in mode only (spec 2026-10-12-remote-access §5); never in the desktop app.
  const signedInRemotely = useAuthStore((s) => s.mode === 'login');
  const signOut = useAuthStore((s) => s.signOut);

  const isNarrow = useMediaQuery(NARROW_BREAKPOINT);
  // Separate from `inspectorCollapsed` (the docked-mode show/hide
  // preference): whether the narrow-mode overlay is currently open. In the
  // store so each pane's header can open it; ephemeral, and starts closed
  // regardless of the docked preference, or the inspector would pop over the
  // thread the instant the window narrows.
  const narrowOverlayOpen = useOtherBenchStore((s) => s.inspectorOverlayOpen);
  const setNarrowOverlayOpen = useOtherBenchStore((s) => s.setInspectorOverlayOpen);
  // Task 28: the global usage/pricing settings view -- a full-screen
  // overlay, ephemeral like the narrow inspector overlay above (there is no
  // "docked" mode for it, and no reason to remember it across reloads).
  const [usageViewOpen, setUsageViewOpen] = useState(false);
  // Connections/models/profiles settings -- same ephemeral full-screen
  // overlay pattern as usageViewOpen above (see SettingsView's doc comment).
  const [settingsViewOpen, setSettingsViewOpen] = useState(false);

  const { unreachable, loaded } = useInitialLoad();

  useAppEvents();
  useOverview();
  useDocks();
  useTrayStatus();
  useUpdateActivity();
  useUpdateHint();
  useOpenArgs(loaded);
  useDesktopShell();
  useTextSizeShortcuts();
  usePaneShortcuts(isNarrow);
  useTerminalShortcuts();
  useMarkRead(isNarrow);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const activeProfile = activeChat ? (profiles.find((p) => p.id === activeChat.profileId) ?? null) : null;

  return (
    <div
      className="grid h-screen grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
      // --sidebar-w comes from state/sidebarWidth.ts; never more than 40% of the window (SIDEBAR_WIDTH_MAX_SHARE),
      // whatever was saved on a bigger screen.
      style={{ gridTemplateColumns: 'min(var(--sidebar-w, 16.25rem), 40vw) minmax(0, 1fr)' }}
      data-narrow={isNarrow || undefined}
    >
      <Toaster />
      {unreachable && (
        <div
          role="alert"
          data-testid="server-unreachable-banner"
          className="col-span-2 row-start-1 flex items-center justify-between gap-3 border-b border-[var(--danger)] bg-[var(--bg-raised)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <span>
            Can&rsquo;t reach the OtherBench server. It may not be running -- start <code>otherbench serve</code> and reload this page.
          </span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn btn-danger shrink-0 px-2 py-1"
          >
            Retry
          </button>
        </div>
      )}

      <div className="relative row-start-2 h-full min-h-0 min-w-0">
        {/* Settings and Usage are app-level overlays, so App owns them; they just render in the sidebar's footer. */}
        <ChatList
          wrapFooter={signedInRemotely}
          footer={
            <>
              <button type="button" onClick={() => setSettingsViewOpen(true)} aria-label="Settings" title="Settings" className="btn px-2 py-1.5">
                <GearIcon />
              </button>
              <button type="button" onClick={() => setUsageViewOpen(true)} aria-label="Usage" title="Usage" className="btn px-2 py-1.5">
                <ChartIcon />
              </button>
              <button type="button" onClick={() => openSchedules()} aria-label="Scheduled tasks" title="Scheduled tasks" className="btn px-2 py-1.5">
                <ClockIcon />
              </button>
              {signedInRemotely && (
                <button type="button" onClick={() => void signOut()} aria-label="Sign out" title="Sign out" className="btn px-2 py-1.5">
                  <SignOutIcon />
                </button>
              )}
            </>
          }
        />
        <SidebarResizer />
      </div>

      <div className="relative row-start-2 grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)]">
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {overviewOpen ? (
            <OverviewView />
          ) : (
            <>
              <TabBar narrow={isNarrow} />
              <PaneGrid narrow={isNarrow} />
            </>
          )}
        </div>

        {/* Code mode's right column is the Code panel (spec 2026-10-20-code-tab-design): Issues and Files
            follow the focused pane's app, so it is useful with no chat open (an app home), and its Chat tab
            holds this same Inspector. It shares the Inspector's collapsed preference: one right column. */}
        {!isNarrow && !overviewOpen && mode === 'code' && (
          // Its width is the user's (spec 2026-10-21-code-terminal-design): dragged on its left edge, at most 70% of the window.
          <div className="relative h-full min-h-0 min-w-0" style={{ width: inspectorCollapsed ? undefined : 'min(var(--code-panel-w, 24rem), 70vw)' }}>
            {!inspectorCollapsed && <PanelResizer width={codePanelWidth} edge="left" label="Resize code panel" />}
            <CodePanel collapsed={inspectorCollapsed} onToggleCollapsed={() => setInspectorCollapsed(!inspectorCollapsed)} />
          </div>
        )}

        {/* Wide layout: the inspector is a genuine third column, collapsible to a slim strip. */}
        {!isNarrow && !overviewOpen && mode === 'chat' && (
          <div className="h-full min-h-0 min-w-0" style={{ width: inspectorCollapsed || !activeChat ? undefined : '20rem' }}>
            {/* With no chat there is nothing to inspect: the slim strip, whatever the saved choice. */}
            <Inspector
              chat={activeChat}
              profile={activeProfile}
              collapsed={inspectorCollapsed || !activeChat}
              disabled={!activeChat}
              onToggleCollapsed={() => setInspectorCollapsed(!inspectorCollapsed)}
            />
          </div>
        )}

        {/* Narrow layout (<1100px, task 19 brief): two panes -- the inspector is
            reachable via the header toggle as an overlay, never a docked column,
            but never simply omitted either (it holds facts that cause harm when
            hidden -- see Inspector's doc comment). */}
        {isNarrow && !overviewOpen && narrowOverlayOpen && (
          <>
            <button
              type="button"
              aria-label="Close inspector overlay"
              onClick={() => setNarrowOverlayOpen(false)}
              className="absolute inset-0 z-10 bg-black/30"
            />
            <div className={`absolute inset-y-0 right-0 z-20 shadow-lg ${mode === 'code' ? 'w-96 max-w-full' : 'w-80'}`}>
              {mode === 'code' ? (
                <CodePanel collapsed={false} onToggleCollapsed={() => setNarrowOverlayOpen(false)} />
              ) : (
                <Inspector chat={activeChat} profile={activeProfile} collapsed={false} onToggleCollapsed={() => setNarrowOverlayOpen(false)} />
              )}
            </div>
          </>
        )}
      </div>

      {usageViewOpen && <UsageView onClose={() => setUsageViewOpen(false)} />}
      {settingsViewOpen && <SettingsView onClose={() => setSettingsViewOpen(false)} />}
      {schedulesPage && (
        <SchedulesView
          key={schedulesPage.prefill ? `${schedulesPage.prefill.kind}:${schedulesPage.prefill.kind === 'chat' ? schedulesPage.prefill.chatId : schedulesPage.prefill.projectId}` : 'list'}
          {...(schedulesPage.prefill ? { prefill: schedulesPage.prefill } : {})}
          onClose={closeSchedules}
        />
      )}
      {projectPage && (
        <ProjectView key={projectPage.mode === 'edit' ? projectPage.projectId : 'new'} page={projectPage} onClose={closeProjectPage} />
      )}
      {appPage && <AppView key={appPage.mode === 'edit' ? appPage.appId : 'new'} page={appPage} onClose={closeAppPage} />}
    </div>
  );
}
