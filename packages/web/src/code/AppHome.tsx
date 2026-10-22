import { useMemo, useState, type JSX } from 'react';
import { projectDisplayNameById } from '@otherbench/core/domain/projects.js';
import type { App } from '@otherbench/core/ports/store.js';
import { StartBox } from '../components/StartBox.js';
import { StatusDot } from '../components/StatusDot.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { NARROW_BREAKPOINT, useMediaQuery } from '../lib/useMediaQuery.js';
import { buildCodeSidebar } from '../panes/sidebar/model.js';
import { ApiError, api } from '../state/api.js';
import { appTabId } from '../state/appTab.js';
import { chatStatus, useChatActivity } from '../state/chatStatus.js';
import { useOtherBenchStore } from '../state/store.js';
import { IssuesTab } from './IssuesTab.js';
import { NO_GITHUB_REPO } from './CodeError.js';

const HEADING = 'label-caps mb-1.5 text-[var(--text-muted)]';
const EMPTY = 'text-sm text-[var(--text-faint)]';

/**
 * An app's home page, open as an `app:` tab in Code mode (spec
 * 2026-10-20-code-tab-design, "Code is a whole-window mode": an app with no
 * chats opens on its home, with its issues and a "New chat" button, like
 * `ProjectHome`). What the app is, a box that starts a chat with its first
 * message sent, its chats, and its open issues, each of which can start a
 * chat too. Editing stays in the app form.
 */
export function AppHome({ appId }: { appId: string }): JSX.Element {
  const app = useOtherBenchStore((s) => s.apps.find((a) => a.id === appId) ?? null);
  const appsLoaded = useOtherBenchStore((s) => s.appsLoaded);
  const closeTab = useOtherBenchStore((s) => s.closeTab);
  // A restored tab renders before the app list arrives: that isn't a deleted app.
  if (!app && !appsLoaded) return <p className={`p-6 ${EMPTY}`}>Loading…</p>;
  if (!app) {
    return (
      <div data-testid="app-home" className="h-full min-h-0 overflow-y-auto bg-[var(--bg)] p-6">
        <p className="text-sm text-[var(--text-muted)]">This app no longer exists. It may have been deleted in another tab or on another machine.</p>
        <button type="button" onClick={() => closeTab(appTabId(appId))} className="btn mt-3 px-2.5 py-1">
          Close
        </button>
      </div>
    );
  }
  return <AppHomeBody app={app} />;
}

function AppHomeBody({ app }: { app: App }): JSX.Element {
  const openAppPage = useOtherBenchStore((s) => s.openAppPage);
  const projects = useOtherBenchStore((s) => s.projects);
  const projectsLoaded = useOtherBenchStore((s) => s.projectsLoaded);
  // A narrow window has no docked Code panel, and an app home has no chat strip with its toggle: this opens the overlay.
  const isNarrow = useMediaQuery(NARROW_BREAKPOINT);
  const overlayOpen = useOtherBenchStore((s) => s.inspectorOverlayOpen);
  const setOverlayOpen = useOtherBenchStore((s) => s.setInspectorOverlayOpen);
  const linked = app.linkedProjectId === null ? null : (projectDisplayNameById(projects, app.linkedProjectId) ?? (projectsLoaded ? 'Missing project' : 'Loading…'));
  // One column, top down: what the app is, a box to start from, its chats, then its issues at full width.
  return (
    <div data-testid="app-home" className="h-full min-h-0 overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-medium">{app.name}</h2>
            {/* The details on one line, each its own item so a long folder wraps without pushing the rest off. */}
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-[var(--text-muted)]">
              <span data-testid="app-home-folder" className="break-all font-mono text-[var(--text)]">
                {app.workspaceRoot ?? <span className="font-sans text-[var(--text-muted)]">This app&apos;s folder isn&apos;t on this machine</span>}
              </span>
              <span aria-hidden="true">·</span>
              <span data-testid="app-home-repo" className="break-all">
                {app.githubRepo ?? NO_GITHUB_REPO}
              </span>
              <span aria-hidden="true">·</span>
              <span data-testid="app-home-project" className="[overflow-wrap:anywhere]">
                {linked === null ? 'No chat project' : `Chat project: ${linked}`}
              </span>
            </p>
          </div>
          {isNarrow && (
            <button type="button" onClick={() => setOverlayOpen(!overlayOpen)} aria-expanded={overlayOpen} className="btn shrink-0 px-2.5 py-1">
              Panel
            </button>
          )}
          <button type="button" onClick={() => openAppPage({ mode: 'edit', appId: app.id })} className="btn shrink-0 px-2.5 py-1">
            Edit…
          </button>
        </div>
        <StartBox
          target={{ pendingKey: `app:${app.id}`, name: app.name, tabId: appTabId(app.id), owns: (c) => c.appId === app.id, create: { appId: app.id } }}
          placeholder="What do you want to work on?"
          submitLabel="Start"
        />
        <AppChats app={app} />
        <section data-testid="app-home-issues" aria-label="Open issues" className="min-w-0">
          <h3 className={HEADING}>Issues</h3>
          {/* Its own view, apart from the Code panel's Issues beside it; keyed, so another app's home starts from its own. */}
          <IssuesTab key={app.id} app={app} owner={`${appTabId(app.id)}#home`} />
        </section>
      </div>
    </div>
  );
}

/**
 * The sidebar's "+ New chat" for this app, from its home: the server gives
 * the chat the app's folder and default profile. The chat goes in the store
 * before it is opened (controller ruling), and gets a tab as every new chat
 * does, so the home stays a tab beside it.
 */
function NewChat({ app }: { app: App }): JSX.Element {
  const upsertChat = useOtherBenchStore((s) => s.upsertChat);
  const setActiveChatId = useOtherBenchStore((s) => s.setActiveChatId);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const chat = await api.chats.create({ appId: app.id });
      upsertChat(chat);
      setActiveChatId(chat.id);
    } catch (err) {
      console.error(`[otherbench-web] failed to create a chat in app ${app.id}:`, err);
      setError(err instanceof ApiError ? err.message : "Couldn't create the chat. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <button type="button" data-testid="app-home-new-chat" disabled={creating} onClick={() => void create()} className="btn shrink-0 px-2 py-0.5 text-xs">
        + New chat
      </button>
      {error && (
        <p role="alert" className="basis-full text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </>
  );
}

function AppChats({ app }: { app: App }): JSX.Element {
  const chats = useOtherBenchStore((s) => s.chats);
  const apps = useOtherBenchStore((s) => s.apps);
  const setActiveChatId = useOtherBenchStore((s) => s.setActiveChatId);
  const { waiting, working, background } = useChatActivity();
  // The Code sidebar's own grouping, so the page and the sidebar always agree on order.
  const listed = useMemo(() => buildCodeSidebar(chats, apps, null).groups.find((g) => g.app?.id === app.id)?.chats ?? [], [chats, apps, app.id]);

  return (
    <section data-testid="app-home-chats" aria-label="Chats" className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <h3 className="label-caps min-w-0 flex-1 text-[var(--text-muted)]">Chats</h3>
        <NewChat app={app} />
      </div>
      {listed.length === 0 ? (
        <p className={EMPTY}>No chats yet</p>
      ) : (
        <ul className="space-y-0.5">
          {listed.map((c) => {
            const status = chatStatus(c, waiting, working, background);
            return (
              <li key={c.id} data-chat-id={c.id} className="flex items-center rounded-sm hover:bg-[var(--bg-sunken)]">
                <button type="button" onClick={() => setActiveChatId(c.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm">
                  <span className={`min-w-0 flex-1 truncate ${status === 'ready' ? 'font-medium' : ''}`}>{c.title}</span>
                  <span className="shrink-0 text-xs text-[var(--text-faint)]">{formatRelativeTime(c.updatedAt)}</span>
                </button>
                {/* Beside the button, not in it, so a screen reader reads the status (as in ChatRow). */}
                {status && <StatusDot status={status} testId={`app-home-chat-status-${c.id}`} className="mx-2" />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
