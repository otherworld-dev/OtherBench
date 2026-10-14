import { useEffect, useState, type JSX } from 'react';
import { Toaster } from './components/Toaster.js';
import { ChartIcon, ClockIcon, GearIcon, SignOutIcon } from './components/icons.js';
import { isIndicatorView, isQuickView } from './desktop/bridge.js';
import { NARROW_BREAKPOINT, useMediaQuery } from './lib/useMediaQuery.js';
import { ChatList } from './panes/ChatList.js';
import { Inspector } from './panes/Inspector.js';
import { PaneGrid } from './panes/PaneGrid.js';
import { SidebarResizer } from './panes/sidebar/SidebarResizer.js';
import { TabBar } from './panes/TabBar.js';
import { api } from './state/api.js';
import { useAuthStore } from './state/auth.js';
import { useGruntStore } from './state/store.js';
import { useTextSizeShortcuts } from './state/textSize.js';
import { useDesktopShell } from './desktop/useDesktopShell.js';
import { useOpenArgs } from './desktop/useOpenArgs.js';
import { useTrayStatus } from './desktop/useTrayStatus.js';
import { useAppEvents } from './state/useAppEvents.js';
import { useMarkRead } from './state/useMarkRead.js';
import { usePaneShortcuts } from './state/usePaneShortcuts.js';
import { IndicatorView } from './views/IndicatorView.js';
import { QuickChat } from './views/QuickChat.js';
import { ProjectView } from './views/ProjectView.js';
import { SettingsView } from './views/SettingsView.js';
import { SchedulesView } from './views/SchedulesView.js';
import { UsageView } from './views/UsageView.js';

/**
 * The quick-chat window gets its own small view (`?view=quick`), and so does
 * the computer-use indicator bar (`?view=indicator`); everything else is the
 * main app.
 */
export function App(): JSX.Element {
  if (isIndicatorView()) return <IndicatorView />;
  return isQuickView() ? <QuickChat /> : <MainApp />;
}

function MainApp(): JSX.Element {
  const chats = useGruntStore((s) => s.chats);
  const profiles = useGruntStore((s) => s.profiles);
  const activeChatId = useGruntStore((s) => s.activeChatId);
  const inspectorCollapsed = useGruntStore((s) => s.inspectorCollapsed);
  const setInspectorCollapsed = useGruntStore((s) => s.setInspectorCollapsed);
  const projectPage = useGruntStore((s) => s.projectPage);
  const closeProjectPage = useGruntStore((s) => s.closeProjectPage);
  const schedulesPage = useGruntStore((s) => s.schedulesPage);
  const openSchedules = useGruntStore((s) => s.openSchedules);
  const closeSchedules = useGruntStore((s) => s.closeSchedules);

  const setConnections = useGruntStore((s) => s.setConnections);
  const setModels = useGruntStore((s) => s.setModels);
  const setProfiles = useGruntStore((s) => s.setProfiles);
  const setChats = useGruntStore((s) => s.setChats);
  const setProjects = useGruntStore((s) => s.setProjects);

  // Sign-in mode only (spec 2026-10-12-remote-access §5); never in the desktop app.
  const signedInRemotely = useAuthStore((s) => s.mode === 'login');
  const signOut = useAuthStore((s) => s.signOut);

  const isNarrow = useMediaQuery(NARROW_BREAKPOINT);
  // Separate from `inspectorCollapsed` (the docked-mode show/hide
  // preference): whether the narrow-mode overlay is currently open. In the
  // store so each pane's header can open it; ephemeral, and starts closed
  // regardless of the docked preference, or the inspector would pop over the
  // thread the instant the window narrows.
  const narrowOverlayOpen = useGruntStore((s) => s.inspectorOverlayOpen);
  const setNarrowOverlayOpen = useGruntStore((s) => s.setInspectorOverlayOpen);
  // Task 28: the global usage/pricing settings view -- a full-screen
  // overlay, ephemeral like the narrow inspector overlay above (there is no
  // "docked" mode for it, and no reason to remember it across reloads).
  const [usageViewOpen, setUsageViewOpen] = useState(false);
  // Connections/models/profiles settings -- same ephemeral full-screen
  // overlay pattern as usageViewOpen above (see SettingsView's doc comment).
  const [settingsViewOpen, setSettingsViewOpen] = useState(false);

  // Set only when EVERY bootstrap fetch below fails -- a cold load with the
  // server unreachable renders otherwise-identically to a genuinely fresh
  // install ("No chats yet...", "+ New chat" disabled): both are just empty
  // arrays sitting in the store. A single failed fetch alongside others that
  // succeeded is left alone (console.error only, as before) since that's a
  // partial/transient hiccup, not "there is no server to talk to" -- see
  // task 19/20 brief.
  const [unreachable, setUnreachable] = useState(false);
  // Set once the first load has settled, so launch arguments act with the profiles loaded.
  const [loaded, setLoaded] = useState(false);

  // Initial reference-data + chat-list load. Individual failures are logged,
  // not thrown -- a transient failure here shouldn't blank the whole shell;
  // panes render their own empty states off whatever did load. But if ALL
  // of them fail, that's not "nothing configured yet", it's "can't reach the
  // server at all", and the banner above says so explicitly instead of
  // silently rendering the fresh-install empty state.
  useEffect(() => {
    let cancelled = false;

    void Promise.allSettled([
      api.connections.list().then(setConnections),
      api.models.list().then(setModels),
      api.profiles.list().then(setProfiles),
      api.chats.list().then(setChats),
      api.projects.list().then(setProjects),
    ]).then((results) => {
      if (cancelled) return;
      const labels = ['connections', 'models', 'profiles', 'chats', 'projects'] as const;
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.error(`[grunt-web] failed to load ${labels[i]}:`, r.reason);
      });
      setUnreachable(results.every((r) => r.status === 'rejected'));
      setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [setConnections, setModels, setProfiles, setChats, setProjects]);

  useAppEvents();
  useTrayStatus();
  useOpenArgs(loaded);
  useDesktopShell();
  useTextSizeShortcuts();
  usePaneShortcuts(isNarrow);
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
            Can&rsquo;t reach the Grunt server. It may not be running -- start <code>grunt serve</code> and reload this page.
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
          <TabBar narrow={isNarrow} />
          <PaneGrid narrow={isNarrow} />
        </div>

        {/* Wide layout: the inspector is a genuine third column, collapsible to a slim strip. */}
        {!isNarrow && (
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
        {isNarrow && narrowOverlayOpen && (
          <>
            <button
              type="button"
              aria-label="Close inspector overlay"
              onClick={() => setNarrowOverlayOpen(false)}
              className="absolute inset-0 z-10 bg-black/30"
            />
            <div className="absolute inset-y-0 right-0 z-20 w-80 shadow-lg">
              <Inspector chat={activeChat} profile={activeProfile} collapsed={false} onToggleCollapsed={() => setNarrowOverlayOpen(false)} />
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
    </div>
  );
}
