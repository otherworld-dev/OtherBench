import { useEffect, useState, type JSX } from 'react';
import { useMediaQuery } from './lib/useMediaQuery.js';
import { ChatList } from './panes/ChatList.js';
import { Inspector } from './panes/Inspector.js';
import { Thread } from './panes/Thread.js';
import { api } from './state/api.js';
import { useGruntStore } from './state/store.js';
import { useChatSync } from './state/useChatSync.js';

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

  // Initial reference-data + chat-list load. Errors are logged, not thrown --
  // a transient failure here shouldn't blank the whole shell; panes render
  // their own empty states off whatever did load.
  useEffect(() => {
    void api.connections
      .list()
      .then(setConnections)
      .catch((err: unknown) => console.error('[grunt-web] failed to load connections:', err));
    void api.models
      .list()
      .then(setModels)
      .catch((err: unknown) => console.error('[grunt-web] failed to load models:', err));
    void api.profiles
      .list()
      .then(setProfiles)
      .catch((err: unknown) => console.error('[grunt-web] failed to load profiles:', err));
    void api.chats
      .list()
      .then(setChats)
      .catch((err: unknown) => console.error('[grunt-web] failed to load chats:', err));
  }, [setConnections, setModels, setProfiles, setChats]);

  useChatSync(activeChatId);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const activeProfile = activeChat ? (profiles.find((p) => p.id === activeChat.profileId) ?? null) : null;

  return (
    <div className="grid h-screen grid-cols-[260px_1fr] grid-rows-[auto_1fr]" data-narrow={isNarrow || undefined}>
      <header className="col-span-2 flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">Grunt</span>
          {activeChat && <span className="text-sm text-[var(--text-muted)]">{activeChat.title}</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
          {activeChatId && <span data-testid="stream-status">{STREAM_STATUS_LABEL[streamStatus] ?? streamStatus}</span>}
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

      <div className="row-start-2 h-full min-h-0">
        <ChatList />
      </div>

      <div className="relative row-start-2 grid h-full min-h-0 grid-cols-[1fr_auto]">
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
    </div>
  );
}
