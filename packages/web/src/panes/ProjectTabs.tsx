import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import { ApiError, api } from '../state/api.js';
import { closeTab, openTab, useOpenTabs } from '../state/projectTabs.js';
import { useGruntStore } from '../state/store.js';
import { byOrder } from './sidebar/model.js';

/**
 * Tabs across the top of a project chat (#824): the project's chats that are
 * open on this device, in sidebar order. Opening a chat opens its tab; ✕ only
 * closes the tab (the chat stays in the sidebar); + starts a new chat in the
 * project, which picks up its folder and default profile. A dot marks a tab
 * whose chat is replying, or waiting for an approval. Nothing shows for a
 * chat outside any project.
 */
export function ProjectTabs({ chat }: { chat: Chat }): JSX.Element | null {
  const projects = useGruntStore((s) => s.projects);
  const chats = useGruntStore((s) => s.chats);
  const pending = useGruntStore((s) => s.appPendingApprovals);
  const running = useGruntStore((s) => s.appRunningTurns);
  const setActiveChatId = useGruntStore((s) => s.setActiveChatId);
  const upsertChat = useGruntStore((s) => s.upsertChat);
  const open = useOpenTabs();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const project = chat.projectId ? (projects.find((p) => p.id === chat.projectId) ?? null) : null;

  // The chat on screen always has a tab.
  useEffect(() => {
    if (project) openTab(project.id, chat.id);
  }, [project, chat.id]);

  const tabs = useMemo(() => {
    if (!project) return [];
    const ids = new Set(open[project.id] ?? []);
    ids.add(chat.id);
    return chats.filter((c) => c.projectId === project.id && c.archivedAt === null && ids.has(c.id)).sort(byOrder);
  }, [project, open, chats, chat.id]);

  const waiting = useMemo(() => new Set(Object.values(pending).map((p) => p.chatId)), [pending]);
  const working = useMemo(() => new Set(Object.values(running)), [running]);

  if (!project) return null;

  function select(id: string): void {
    setActiveChatId(id);
    setTimeout(() => tabRefs.current.get(id)?.focus(), 0);
  }

  function close(id: string): void {
    const i = tabs.findIndex((t) => t.id === id);
    closeTab(project!.id, id);
    if (id !== chat.id) return;
    const neighbour = tabs[i + 1] ?? tabs[i - 1];
    if (neighbour) select(neighbour.id);
    else setActiveChatId(null);
  }

  async function newChat(): Promise<void> {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.chats.create({ projectId: project!.id });
      upsertChat(created);
      openTab(project!.id, created.id);
      setActiveChatId(created.id);
    } catch (err) {
      console.error('[grunt-web] failed to create a chat from the tab strip:', err);
      setError(err instanceof ApiError ? `Couldn't start a chat: ${err.message}` : "Couldn't start a chat -- please try again.");
    } finally {
      setCreating(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const next = e.key === 'ArrowRight' ? tabs[index + 1] : e.key === 'ArrowLeft' ? tabs[index - 1] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : undefined;
    if (next) {
      e.preventDefault();
      select(next.id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      close(tabs[index]!.id);
    }
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-raised)] px-2 pt-1.5" data-testid="project-tabs">
      <div role="tablist" aria-label={`${project.name} chats`} className="flex min-w-0 items-end gap-0.5">
        {tabs.map((t, index) => {
          const active = t.id === chat.id;
          const status = waiting.has(t.id) ? 'waiting' : working.has(t.id) ? 'working' : null;
          return (
            <div
              key={t.id}
              data-testid={`project-tab-${t.id}`}
              className={`group flex max-w-[14rem] items-center rounded-t border border-b-0 ${
                active ? 'border-[var(--border)] bg-[var(--bg)]' : 'border-transparent hover:bg-[var(--bg-sunken)]'
              }`}
            >
              <button
                ref={(el) => {
                  if (el) tabRefs.current.set(t.id, el);
                  else tabRefs.current.delete(t.id);
                }}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
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
                    aria-label={status === 'waiting' ? 'waiting for approval' : 'replying'}
                    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${status === 'waiting' ? 'bg-[var(--warning,#d29922)]' : 'animate-pulse bg-[var(--accent)]'}`}
                  />
                )}
                <span className="truncate">{t.title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close tab ${t.title}`}
                title="Close tab (the chat stays in the sidebar)"
                onClick={() => close(t.id)}
                className="mr-1 shrink-0 rounded px-1 text-xs text-[var(--text-muted)] opacity-60 hover:bg-[var(--bg-sunken)] hover:opacity-100 focus-visible:opacity-100"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label={`New chat in ${project.name}`}
        title={`New chat in ${project.name}`}
        aria-disabled={creating || undefined}
        onClick={creating ? undefined : () => void newChat()}
        className="mb-0.5 shrink-0 rounded px-2 py-0.5 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] aria-disabled:opacity-40"
      >
        +
      </button>
      {error && (
        <p role="alert" className="ml-2 truncate text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
