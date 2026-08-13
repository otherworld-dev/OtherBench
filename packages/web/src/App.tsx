import { useEffect, useState, type JSX } from 'react';
import { useMediaQuery } from './lib/useMediaQuery.js';
import { ChatList } from './panes/ChatList.js';
import { Inspector } from './panes/Inspector.js';
import { Thread } from './panes/Thread.js';
import { api } from './state/api.js';
import { useGruntStore } from './state/store.js';
import { useChatSync } from './state/useChatSync.js';
import { SettingsView } from './views/SettingsView.js';
import { UsageView } from './views/UsageView.js';

/** Below this width the inspector can no longer sit as a third docked column -- it collapses (task 19 brief). */
const NARROW_BREAKPOINT = '(max-width: 1099.98px)';

const STREAM_STATUS_LABEL: Record<string, string> = {
  idle: '',
  connecting: 'Connecting…',
  open: '',
  reconnecting: 'Reconnecting…',
};

export function App(): JSX.Element {
  const chats = useGruntStore((s) => s.chats);
  const profiles = useGruntStore((s) => s.profiles);
  const activeChatId = useGruntStore((s) => s.activeChatId);
  const inspectorCollapsed = useGruntStore((s) => s.inspectorCollapsed);
  const setInspectorCollapsed = useGruntStore((s) => s.setInspectorCollapsed);
  const streamStatus = useGruntStore((s) => s.streamStatus);

  const setConnections = useGruntStore((s) => s.setConnections);
  const setModels = useGruntStore((s) => s.setModels);
  const setProfiles = useGruntStore((s) => s.setProfiles);
  const setChats = useGruntStore((s) => s.setChats);

  const isNarrow = useMediaQuery(NARROW_BREAKPOINT);
  // Separate from `inspectorCollapsed` (the docked-mode show/hide
  // preference, which lives in the store so it's stable across chat
  // switches): whether the narrow-mode overlay is currently open. Purely
  // ephemeral view state, and must default closed regardless of the docked
  // preference's value, or the inspector would pop over the thread the
  // instant the window narrows.
  const [narrowOverlayOpen, setNarrowOverlayOpen] = useState(false);
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

  // Initial reference-data + chat-list load. Individual failures are logged,
  // not thrown -- a transient failure here shouldn't blank the whole shell;
  // panes render their own empty states off whatever did load. But if ALL
  // FOUR fail, that's not "nothing configured yet", it's "can't reach the
  // server at all", and the banner above says so explicitly instead of
  // silently rendering the fresh-install empty state.
  useEffect(() => {
    let cancelled = false;

    void Promise.allSettled([
      api.connections.list().then(setConnections),
      api.models.list().then(setModels),
      api.profiles.list().then(setProfiles),
      api.chats.list().then(setChats),
    ]).then((results) => {
      if (cancelled) return;
      const labels = ['connections', 'models', 'profiles', 'chats'] as const;
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.error(`[grunt-web] failed to load ${labels[i]}:`, r.reason);
      });
      setUnreachable(results.every((r) => r.status === 'rejected'));
    });

    return () => {
      cancelled = true;
    };
  }, [setConnections, setModels, setProfiles, setChats]);

  useChatSync(activeChatId);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const activeProfile = activeChat ? (profiles.find((p) => p.id === activeChat.profileId) ?? null) : null;

  return (
    <div className="grid h-screen grid-cols-[260px_1fr] grid-rows-[auto_auto_1fr]" data-narrow={isNarrow || undefined}>
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
            className="shrink-0 rounded border border-[var(--danger)] px-2 py-1 text-xs font-medium"
          >
            Retry
          </button>
        </div>
      )}

      <header className="col-span-2 row-start-2 flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">Grunt</span>
          {activeChat && <span className="text-sm text-[var(--text-muted)]">{activeChat.title}</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
          {activeChatId && <span data-testid="stream-status">{STREAM_STATUS_LABEL[streamStatus] ?? streamStatus}</span>}
          <button type="button" onClick={() => setSettingsViewOpen(true)} className="rounded border border-[var(--border)] px-2 py-1">
            Settings
          </button>
          <button type="button" onClick={() => setUsageViewOpen(true)} className="rounded border border-[var(--border)] px-2 py-1">
            Usage
          </button>
          {isNarrow && (
            <button
              type="button"
              onClick={() => setNarrowOverlayOpen((open) => !open)}
              aria-expanded={narrowOverlayOpen}
              className="rounded border border-[var(--border)] px-2 py-1"
            >
              Inspector
            </button>
          )}
        </div>
      </header>

      <div className="row-start-3 h-full min-h-0">
        <ChatList />
      </div>

      <div className="relative row-start-3 grid h-full min-h-0 grid-cols-[1fr_auto]">
        <Thread chat={activeChat} />

        {/* Wide layout: the inspector is a genuine third column, collapsible to a slim strip. */}
        {!isNarrow && (
          <div className="h-full" style={{ width: inspectorCollapsed ? undefined : 320 }}>
            <Inspector
              chat={activeChat}
              profile={activeProfile}
              collapsed={inspectorCollapsed}
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
            <div className="absolute inset-y-0 right-0 z-20 w-[320px] shadow-lg">
              <Inspector chat={activeChat} profile={activeProfile} collapsed={false} onToggleCollapsed={() => setNarrowOverlayOpen(false)} />
            </div>
          </>
        )}
      </div>

      {usageViewOpen && <UsageView onClose={() => setUsageViewOpen(false)} />}
      {settingsViewOpen && <SettingsView onClose={() => setSettingsViewOpen(false)} />}
    </div>
  );
}
