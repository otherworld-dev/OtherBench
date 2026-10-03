import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { PROJECT_NAME_MAX } from '@grunt/core/domain/projects.js';
import type { Chat } from '@grunt/core/ports/store.js';
import { InlineNameInput } from '../components/InlineNameInput.js';
import { onDesktopEvent } from '../desktop/bridge.js';
import { ApiError, api, type ChatPatchBody, type CreateChatBody } from '../state/api.js';
import { NO_PROJECT_KEY, setGroupCollapsed, useCollapsedGroups } from '../state/sidebarGroups.js';
import { useGruntStore } from '../state/store.js';
import { ChatRow } from './sidebar/ChatRow.js';
import { buildSidebar } from './sidebar/model.js';
import { ProjectGroup } from './sidebar/ProjectGroup.js';

/** A sidebar error line: the server's own message when there is one. */
function errorText(err: unknown, action: string): string {
  return err instanceof ApiError ? `${action}: ${err.message}` : `${action} -- please try again.`;
}

/**
 * Focuses `selector` once React has committed (a moved row re-mounts under
 * its new group), unless focus has meanwhile gone into a menu, a dialog or a
 * text field -- another action took it on purpose.
 */
function focusLater(selector: string): void {
  setTimeout(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[role="menu"], [role="alertdialog"], input, select, textarea')) return;
    document.querySelector<HTMLElement>(selector)?.focus();
  }, 0);
}

function chatRowSelector(chatId: string): string {
  return `[data-testid="chat-row-${chatId}"] [data-row-main]`;
}

/**
 * Left pane (spec 2026-10-03-projects-design §3): search, then Pinned, each
 * project, and No project, with "+ New chat" and "+ New project" at the
 * bottom. Search hits `GET /api/search` (FTS over message text) and filters
 * every group to the matching chats; groups with no match hide, and
 * collapsed groups show expanded, while a search is active.
 */
export function ChatList(): JSX.Element {
  const chats = useGruntStore((s) => s.chats);
  const projects = useGruntStore((s) => s.projects);
  const profiles = useGruntStore((s) => s.profiles);
  const activeChatId = useGruntStore((s) => s.activeChatId);
  const setActiveChatId = useGruntStore((s) => s.setActiveChatId);
  const upsertChat = useGruntStore((s) => s.upsertChat);
  const upsertProject = useGruntStore((s) => s.upsertProject);
  const collapsedGroups = useCollapsedGroups();

  const [query, setQuery] = useState('');
  const [searchChatIds, setSearchChatIds] = useState<ReadonlySet<string> | null>(null);
  const searchSeq = useRef(0);
  const [creating, setCreating] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const searching = searchChatIds !== null;
  const sidebar = useMemo(() => buildSidebar(chats, projects, searchChatIds), [chats, projects, searchChatIds]);

  async function runSearch(q: string): Promise<void> {
    setQuery(q);
    const seq = ++searchSeq.current;
    if (q.trim().length === 0) {
      setSearchChatIds(null);
      return;
    }
    try {
      const results = await api.search(q);
      // A newer keystroke, or clearing the box, supersedes this response.
      if (seq !== searchSeq.current) return;
      setSearchChatIds(new Set(results.map((r) => r.chatId)));
    } catch (err) {
      console.error('[grunt-web] search failed:', err);
    }
  }

  async function createChat(projectId?: string): Promise<void> {
    let body: CreateChatBody;
    if (projectId !== undefined) {
      // The server copies the project's folder and default profile onto the
      // new chat, falling back to the app default profile (spec §2).
      body = { projectId };
    } else {
      const defaultProfile = profiles.find((p) => p.isDefault) ?? profiles[0];
      if (!defaultProfile) return;
      body = { profileId: defaultProfile.id };
    }
    // A chat created into a collapsed group would be invisible.
    setGroupCollapsed(projectId ?? NO_PROJECT_KEY, false);
    setCreating(true);
    setError(null);
    try {
      const chat = await api.chats.create(body);
      upsertChat(chat);
      setActiveChatId(chat.id);
    } catch (err) {
      console.error('[grunt-web] failed to create chat:', err);
      setError(errorText(err, "Couldn't create the chat"));
    } finally {
      setCreating(false);
    }
  }

  async function patchChat(chat: Chat, body: ChatPatchBody, action: string): Promise<Chat | null> {
    setError(null);
    try {
      const updated = await api.chats.patch(chat.id, body);
      upsertChat(updated);
      return updated;
    } catch (err) {
      console.error(`[grunt-web] failed to update chat ${chat.id}:`, err);
      setError(errorText(err, action));
      return null;
    }
  }

  /** Files a chat under a project (null = No project). A no-op when it's already there. */
  async function moveChat(chatId: string, projectId: string | null): Promise<void> {
    const chat = useGruntStore.getState().chats.find((c) => c.id === chatId);
    if (!chat || chat.projectId === projectId) return;
    if (await patchChat(chat, { projectId }, "Couldn't move the chat")) focusLater(chatRowSelector(chatId));
  }

  async function createProject(name: string): Promise<void> {
    setError(null);
    try {
      upsertProject(await api.projects.create({ name }));
    } catch (err) {
      console.error('[grunt-web] failed to create project:', err);
      setError(errorText(err, "Couldn't create the project"));
    } finally {
      setNewProjectOpen(false);
    }
  }

  // The tray menu's "New chat" does exactly what the button does. The ref
  // keeps the one subscription pointed at the latest `createChat`, which
  // closes over the current profiles.
  const createChatRef = useRef(createChat);
  createChatRef.current = createChat;
  useEffect(() => {
    let off: (() => void) | null = null;
    let disposed = false;
    void onDesktopEvent('tray-new-chat', () => void createChatRef.current()).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  function renderRow(chat: Chat): JSX.Element {
    return (
      <ChatRow key={chat.id} chat={chat} active={chat.id === activeChatId} onSelect={() => setActiveChatId(chat.id)} onDragEnd={() => setDropTarget(null)} />
    );
  }

  return (
    <nav aria-label="Chats" className="flex h-full w-full flex-col border-r border-[var(--border)] bg-[var(--bg-raised)]">
      <div className="border-b border-[var(--border)] p-3">
        <input
          type="search"
          value={query}
          onChange={(e) => void runSearch(e.target.value)}
          placeholder="Search chats..."
          aria-label="Search chats"
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-raised)]"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2" data-testid="chat-list-scroll">
        {sidebar.pinned.length > 0 && (
          <div className="mb-3" data-testid="group-pinned">
            <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">Pinned</h2>
            <ul className="space-y-0.5">{sidebar.pinned.map(renderRow)}</ul>
          </div>
        )}

        {searching && sidebar.pinned.length === 0 && sidebar.groups.length === 0 && (
          <p className="px-2 py-4 text-sm text-[var(--text-faint)]">No chats match your search.</p>
        )}

        {sidebar.groups.map((group) => {
          const project = group.project;
          return (
            <ProjectGroup
              key={group.key}
              groupKey={group.key}
              name={project?.name ?? 'No project'}
              count={group.total}
              empty={group.total === 0}
              collapsed={!searching && collapsedGroups.has(group.key)}
              dropActive={dropTarget === group.key}
              onToggle={() => setGroupCollapsed(group.key, !collapsedGroups.has(group.key))}
              onDragTarget={(on) => setDropTarget((current) => (on ? group.key : current === group.key ? null : current))}
              onDropChat={(chatId) => void moveChat(chatId, project?.id ?? null)}
              {...(project ? { onNewChat: () => void createChat(project.id), newChatDisabled: creating || profiles.length === 0 } : {})}
            >
              {group.chats.map(renderRow)}
            </ProjectGroup>
          );
        })}

        {error && (
          <p role="alert" className="px-2 py-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-[var(--border)] p-2">
        {newProjectOpen && (
          <InlineNameInput
            initial=""
            label="Project name"
            maxLength={PROJECT_NAME_MAX}
            onCommit={(name) => void createProject(name)}
            onCancel={() => setNewProjectOpen(false)}
          />
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void createChat()}
            disabled={creating || profiles.length === 0}
            title={profiles.length === 0 ? 'Create a profile before starting a chat.' : undefined}
            className="flex-1 rounded bg-[var(--accent)] px-2 py-1.5 text-sm font-medium text-[var(--accent-text)] disabled:opacity-50"
          >
            + New chat
          </button>
          <button
            type="button"
            onClick={() => setNewProjectOpen(true)}
            disabled={newProjectOpen}
            className="rounded border border-[var(--border)] px-2 py-1.5 text-sm hover:bg-[var(--bg-sunken)] disabled:opacity-50"
          >
            + New project
          </button>
        </div>
      </div>
    </nav>
  );
}
