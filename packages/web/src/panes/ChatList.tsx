import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { exportFilename } from '@grunt/core/domain/export.js';
import { compareProjects, PROJECT_NAME_MAX } from '@grunt/core/domain/projects.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { InlineNameInput } from '../components/InlineNameInput.js';
import { Menu } from '../components/Menu.js';
import { onDesktopEvent } from '../desktop/bridge.js';
import { saveFile } from '../lib/saveFile.js';
import { ApiError, api, type ChatPatchBody, type CreateChatBody, type PatchProjectBody } from '../state/api.js';
import { NO_PROJECT_KEY, setGroupCollapsed, useCollapsedGroups } from '../state/sidebarGroups.js';
import { useGruntStore } from '../state/store.js';
import { ChatRow, type DropPosition, type MenuSource } from './sidebar/ChatRow.js';
import { chatMenuItems, projectMenuItems } from './sidebar/menus.js';
import { buildSidebar, moveProjectPatches, moveTarget, placeChatPatches } from './sidebar/model.js';
import { ProjectFolderEditor, ProjectProfileEditor } from './sidebar/ProjectEditors.js';
import { ProjectGroup, type ProjectGroupProps } from './sidebar/ProjectGroup.js';

/** A sidebar error line: the server's own message when there is one. */
function errorText(err: unknown, action: string): string {
  return err instanceof ApiError ? `${action}: ${err.message}` : `${action} -- please try again.`;
}

/**
 * Focuses `selector` once React has committed (a moved row re-mounts under
 * its new group), unless focus has meanwhile gone into a menu, a dialog or a
 * text field -- another action took it on purpose.
 */
function focusLater(selector: string, fallback?: string): void {
  setTimeout(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[role="menu"], [role="alertdialog"], input, select, textarea')) return;
    const target = document.querySelector<HTMLElement>(selector) ?? (fallback ? document.querySelector<HTMLElement>(fallback) : null);
    target?.focus();
  }, 0);
}

/** The chat list itself: the stable place focus falls back to when the row it wanted is gone. */
const LIST_SELECTOR = '[data-chat-list]';

function chatRowSelector(chatId: string): string {
  return `[data-testid="chat-row-${chatId}"] [data-row-main]`;
}

/** localStorage key: whether the "Show archived" section is open. Per device. */
export const SHOW_ARCHIVED_STORAGE_KEY = 'grunt.showArchived';

function loadShowArchived(): boolean {
  try {
    return window.localStorage.getItem(SHOW_ARCHIVED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** A list of chats as the sidebar shows them: Pinned, or one project's group (null = No project). */
interface Section {
  chats: Chat[];
  pinned: boolean;
  projectId: string | null;
}

function headingSelector(projectId: string): string {
  return `[data-testid="group-heading-${projectId}"] [data-heading-main]`;
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
  const removeChat = useGruntStore((s) => s.removeChat);
  const removeProject = useGruntStore((s) => s.removeProject);
  const setProjects = useGruntStore((s) => s.setProjects);
  const collapsedGroups = useCollapsedGroups();

  const [query, setQuery] = useState('');
  const [searchChatIds, setSearchChatIds] = useState<ReadonlySet<string> | null>(null);
  const searchSeq = useRef(0);
  const [creating, setCreating] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [rowDrop, setRowDrop] = useState<{ chatId: string; position: DropPosition } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatMenu, setChatMenu] = useState<{ chatId: string; position: { x: number; y: number } } | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; position: { x: number; y: number } } | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<{ projectId: string; field: 'folder' | 'profile' } | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(loadShowArchived);
  const newProjectButton = useRef<HTMLButtonElement>(null);

  const searching = searchChatIds !== null;
  const sidebar = useMemo(() => buildSidebar(chats, projects, searchChatIds), [chats, projects, searchChatIds]);
  const orderedProjects = useMemo(() => [...projects].sort(compareProjects), [projects]);
  // Looked up on every render, so the menu and dialog act on the chat as it is now.
  const menuChat = chatMenu ? (chats.find((c) => c.id === chatMenu.chatId) ?? null) : null;
  const deletingChat = deletingChatId ? (chats.find((c) => c.id === deletingChatId) ?? null) : null;
  const menuProject = projectMenu ? (projects.find((p) => p.id === projectMenu.projectId) ?? null) : null;
  const deletingProject = deletingProjectId ? (projects.find((p) => p.id === deletingProjectId) ?? null) : null;

  // The chat under an open menu vanished (deleted or archived from elsewhere): close the menu, keep focus in the list.
  const menuChatGone = chatMenu !== null && menuChat === null;
  useEffect(() => {
    if (!menuChatGone) return;
    setChatMenu(null);
    focusLater(LIST_SELECTOR);
  }, [menuChatGone]);

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
    if (creating) return;
    let body: CreateChatBody;
    if (projectId !== undefined) {
      // The server copies the project's folder and default profile onto the
      // new chat, falling back to the app default profile (spec §2).
      body = { projectId };
    } else {
      const defaultProfile = profiles.find((p) => p.isDefault && p.archivedAt === null) ?? profiles.find((p) => p.archivedAt === null);
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

  /**
   * Files a chat under a project (null = No project), at the top of that
   * group. A pinned chat keeps its place under Pinned. A no-op when it's
   * already there.
   */
  async function moveChat(chatId: string, projectId: string | null): Promise<void> {
    const chat = useGruntStore.getState().chats.find((c) => c.id === chatId);
    if (!chat || chat.projectId === projectId) return;
    const group = sidebar.groups.find((g) => g.key === (projectId ?? NO_PROJECT_KEY))?.chats ?? [];
    const top = chat.pinned ? [] : placeChatPatches(group, chat, group[0]?.id ?? null).filter((p) => p.id === chat.id);
    const body: ChatPatchBody = { projectId, ...(top[0] ? { sortOrder: top[0].sortOrder } : {}) };
    if (await patchChat(chat, body, "Couldn't move the chat")) focusLater(chatRowSelector(chatId));
  }

  /**
   * Puts chat `chatId` in `section` just above `beforeId` (null = the bottom),
   * filing, pinning or unpinning it to match the section (#823). Usually one
   * PATCH; a renumbered section sends one per chat that changes.
   */
  async function placeChat(chatId: string, section: Section, beforeId: string | null): Promise<void> {
    const chat = useGruntStore.getState().chats.find((c) => c.id === chatId);
    if (!chat || chat.archivedAt !== null) return;
    const patches = placeChatPatches(section.chats, chat, beforeId);
    const own = patches.find((p) => p.id === chatId);
    const body: ChatPatchBody = {
      ...(own ? { sortOrder: own.sortOrder } : {}),
      ...(chat.pinned !== section.pinned ? { pinned: section.pinned } : {}),
      ...(!section.pinned && chat.projectId !== section.projectId ? { projectId: section.projectId } : {}),
    };
    if (Object.keys(body).length === 0) return;
    setError(null);
    try {
      upsertChat(await api.chats.patch(chatId, body));
      for (const p of patches) {
        if (p.id === chatId) continue;
        upsertChat(await api.chats.patch(p.id, { sortOrder: p.sortOrder }));
      }
    } catch (err) {
      console.error('[grunt-web] failed to reorder chats:', err);
      setError(errorText(err, "Couldn't move the chat"));
      // Part of the reorder may have landed: show the server's order, not a guess.
      try {
        useGruntStore.getState().setChats(await api.chats.list());
      } catch {
        // the error line above already says something went wrong.
      }
    }
    focusLater(chatRowSelector(chatId), LIST_SELECTOR);
  }

  /** The chat that a drop `position` relative to row `targetId` lands above, skipping the dragged chat itself. */
  function beforeIdFor(section: Section, targetId: string, position: DropPosition, movingId: string): string | null {
    if (position === 'before') return targetId;
    const rest = section.chats.filter((c) => c.id !== movingId);
    return rest[rest.findIndex((c) => c.id === targetId) + 1]?.id ?? null;
  }

  /** The section the sidebar shows `chat` in, or null when it isn't shown in one (archived). */
  function sectionOf(chat: Chat): Section | null {
    if (chat.archivedAt !== null) return null;
    if (chat.pinned) return { chats: sidebar.pinned, pinned: true, projectId: null };
    const group = sidebar.groups.find((g) => g.chats.some((c) => c.id === chat.id));
    return group ? { chats: group.chats, pinned: false, projectId: group.project?.id ?? null } : null;
  }

  /** The chat's place in its section, for the menu's Move up / Move down; null while searching or when archived. */
  function menuPosition(chat: Chat): { index: number; count: number } | null {
    const section = searching ? null : sectionOf(chat);
    return section ? { index: section.chats.findIndex((c) => c.id === chat.id), count: section.chats.length } : null;
  }

  async function reorderChat(chat: Chat, dir: -1 | 1): Promise<void> {
    const section = sectionOf(chat);
    const target = section ? moveTarget(section.chats, chat.id, dir) : undefined;
    if (section && target) await placeChat(chat.id, section, target.beforeId);
  }

  /** A new project named after the chat, with the chat moved into it, so its conversations can open as tabs (#824). */
  async function moveToNewProject(chat: Chat): Promise<void> {
    setError(null);
    try {
      const name = chat.title.trim().slice(0, PROJECT_NAME_MAX) || 'New project';
      const project = await api.projects.create({ name });
      upsertProject(project);
      await moveChat(chat.id, project.id);
    } catch (err) {
      console.error('[grunt-web] failed to create a project for the chat:', err);
      setError(errorText(err, "Couldn't create the project"));
    }
  }

  async function createProject(name: string): Promise<void> {
    setError(null);
    try {
      upsertProject(await api.projects.create({ name }));
    } catch (err) {
      console.error('[grunt-web] failed to create project:', err);
      setError(errorText(err, "Couldn't create the project"));
    } finally {
      closeNewProject();
    }
  }

  /** Closes the name field and puts focus back on its button -- unless the user already moved it somewhere on purpose. */
  function closeNewProject(): void {
    setNewProjectOpen(false);
    setTimeout(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) newProjectButton.current?.focus();
    }, 0);
  }

  /** The row to focus once `chatId`'s row is gone: the next one in the list, else the previous one. */
  function neighbourSelector(chatId: string): string {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="chat-row-"]'));
    const i = rows.findIndex((el) => el.getAttribute('data-testid') === `chat-row-${chatId}`);
    const neighbour = i === -1 ? undefined : (rows[i + 1] ?? rows[i - 1]);
    const id = neighbour?.getAttribute('data-testid')?.slice('chat-row-'.length);
    return id ? chatRowSelector(id) : LIST_SELECTOR;
  }

  function openChatMenu(chatId: string, position: { x: number; y: number }, source: MenuSource): void {
    setProjectMenu(null);
    if (source === 'button' && chatMenu?.chatId === chatId) {
      setChatMenu(null);
      focusLater(chatRowSelector(chatId), LIST_SELECTOR);
      return;
    }
    setChatMenu({ chatId, position });
  }

  async function renameChat(chat: Chat, title: string): Promise<void> {
    setRenamingChatId(null);
    if (await patchChat(chat, { title }, "Couldn't rename the chat")) focusLater(chatRowSelector(chat.id), LIST_SELECTOR);
  }

  async function setPinned(chat: Chat, pinned: boolean): Promise<void> {
    const action = pinned ? "Couldn't pin the chat" : "Couldn't unpin the chat";
    if (await patchChat(chat, { pinned }, action)) focusLater(chatRowSelector(chat.id), LIST_SELECTOR);
  }

  async function setMemoryExcluded(chat: Chat, excluded: boolean): Promise<void> {
    const action = excluded ? "Couldn't stop this chat adding to project memory" : "Couldn't let this chat add to project memory";
    if (await patchChat(chat, { memoryExcluded: excluded }, action)) focusLater(chatRowSelector(chat.id), LIST_SELECTOR);
  }

  async function exportChat(chat: Chat, format: 'markdown' | 'json'): Promise<void> {
    setError(null);
    try {
      saveFile(await api.chats.export(chat.id, format), exportFilename(chat.title, format === 'json' ? 'json' : 'md'));
    } catch (err) {
      console.error(`[grunt-web] failed to export chat ${chat.id}:`, err);
      setError(errorText(err, "Couldn't export the chat"));
    }
    focusLater(chatRowSelector(chat.id), LIST_SELECTOR);
  }

  /** Hides the chat from the sidebar (spec §3: reuses `archivedAt`). */
  async function archiveChat(chat: Chat): Promise<void> {
    const next = neighbourSelector(chat.id);
    const updated = await patchChat(chat, { archivedAt: Date.now() }, "Couldn't archive the chat");
    if (!updated) return;
    if (useGruntStore.getState().activeChatId === chat.id) setActiveChatId(null);
    focusLater(next, LIST_SELECTOR);
  }

  async function unarchiveChat(chat: Chat): Promise<void> {
    if (await patchChat(chat, { archivedAt: null }, "Couldn't unarchive the chat")) focusLater(chatRowSelector(chat.id), LIST_SELECTOR);
  }

  /** Rejects on failure, which keeps the confirmation dialog open with the message. */
  async function deleteChat(chatId: string): Promise<void> {
    const next = neighbourSelector(chatId);
    await api.chats.delete(chatId);
    removeChat(chatId);
    if (useGruntStore.getState().activeChatId === chatId) setActiveChatId(null);
    setDeletingChatId(null);
    focusLater(next, LIST_SELECTOR);
  }

  function openProjectMenu(projectId: string, position: { x: number; y: number }, source: MenuSource): void {
    setChatMenu(null);
    if (source === 'button' && projectMenu?.projectId === projectId) {
      setProjectMenu(null);
      focusLater(headingSelector(projectId), LIST_SELECTOR);
      return;
    }
    setProjectMenu({ projectId, position });
  }

  async function renameProject(projectId: string, name: string): Promise<void> {
    setRenamingProjectId(null);
    setError(null);
    try {
      upsertProject(await api.projects.patch(projectId, { name }));
    } catch (err) {
      console.error(`[grunt-web] failed to rename project ${projectId}:`, err);
      setError(errorText(err, "Couldn't rename the project"));
    }
    focusLater(headingSelector(projectId), LIST_SELECTOR);
  }

  /** For the folder / default-profile forms: rejects into the form, which shows the message and stays open. */
  async function saveProjectEdit(projectId: string, body: PatchProjectBody): Promise<void> {
    upsertProject(await api.projects.patch(projectId, body));
    setEditingProject(null);
    focusLater(headingSelector(projectId), LIST_SELECTOR);
  }

  function closeProjectEditor(projectId: string): void {
    setEditingProject(null);
    focusLater(headingSelector(projectId), LIST_SELECTOR);
  }

  async function moveProject(projectId: string, dir: -1 | 1): Promise<void> {
    setError(null);
    try {
      for (const { id, sortOrder } of moveProjectPatches(projects, projectId, dir)) {
        upsertProject(await api.projects.patch(id, { sortOrder }));
      }
    } catch (err) {
      console.error('[grunt-web] failed to reorder projects:', err);
      setError(errorText(err, "Couldn't reorder the projects"));
      // Part of the reorder may have landed: show the server's order, not a guess.
      try {
        setProjects(await api.projects.list());
      } catch {
        // the error line above already says something went wrong.
      }
    }
    focusLater(headingSelector(projectId), LIST_SELECTOR);
  }

  /** The heading to focus once `projectId`'s is gone: the next one, else the previous one. */
  function neighbourHeadingSelector(projectId: string): string {
    const heads = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="group-heading-"]'));
    const i = heads.findIndex((el) => el.getAttribute('data-testid') === `group-heading-${projectId}`);
    const neighbour = i === -1 ? undefined : (heads[i + 1] ?? heads[i - 1]);
    const key = neighbour?.getAttribute('data-testid')?.slice('group-heading-'.length);
    return key ? headingSelector(key) : LIST_SELECTOR;
  }

  /** Rejects on failure, which keeps the confirmation dialog open with the message. */
  async function deleteProject(projectId: string): Promise<void> {
    const next = neighbourHeadingSelector(projectId);
    try {
      await api.projects.delete(projectId);
    } catch (err) {
      // Already gone (deleted in another tab): same end state the user asked for.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    removeProject(projectId); // its chats move to No project here too, as on the server
    setDeletingProjectId(null);
    focusLater(next, LIST_SELECTOR);
  }

  /** The project-only props of a group heading. */
  function projectGroupProps(project: Project): Partial<ProjectGroupProps> {
    const editing = editingProject?.projectId === project.id ? editingProject.field : null;
    return {
      onNewChat: () => void createChat(project.id),
      newChatDisabled: creating || profiles.length === 0,
      menuOpen: projectMenu?.projectId === project.id,
      renaming: renamingProjectId === project.id,
      onOpenMenu: (position, source) => openProjectMenu(project.id, position, source),
      onRename: (name) => void renameProject(project.id, name),
      onRenameCancel: () => {
        setRenamingProjectId(null);
        focusLater(headingSelector(project.id), LIST_SELECTOR);
      },
      editor:
        editing === 'folder' ? (
          <ProjectFolderEditor project={project} onSave={(root) => saveProjectEdit(project.id, { workspaceRoot: root })} onCancel={() => closeProjectEditor(project.id)} />
        ) : editing === 'profile' ? (
          <ProjectProfileEditor
            project={project}
            profiles={profiles}
            onSave={(defaultProfileId) => saveProjectEdit(project.id, { defaultProfileId })}
            onCancel={() => closeProjectEditor(project.id)}
          />
        ) : undefined,
    };
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

  function toggleArchived(): void {
    const next = !showArchived;
    setShowArchived(next);
    try {
      window.localStorage.setItem(SHOW_ARCHIVED_STORAGE_KEY, String(next));
    } catch {
      // storage blocked or full -- the toggle still applies for this session.
    }
  }

  function renderRow(chat: Chat, section: Section | null): JSX.Element {
    return (
      <ChatRow
        key={chat.id}
        chat={chat}
        active={chat.id === activeChatId}
        onSelect={() => setActiveChatId(chat.id)}
        onDragEnd={() => {
          setDropTarget(null);
          setRowDrop(null);
        }}
        reorder={
          // Reordering against a filtered list would place chats relative to ones the user can't see.
          section && !searching
            ? {
                indicator: rowDrop?.chatId === chat.id ? rowDrop.position : null,
                onOver: (position) => setRowDrop({ chatId: chat.id, position }),
                onLeave: () => setRowDrop((current) => (current?.chatId === chat.id ? null : current)),
                onDrop: (draggedId, position) => {
                  if (draggedId === chat.id) return;
                  void placeChat(draggedId, section, beforeIdFor(section, chat.id, position, draggedId));
                },
              }
            : undefined
        }
        menuOpen={chatMenu?.chatId === chat.id}
        renaming={renamingChatId === chat.id}
        muted={section === null}
        onOpenMenu={(position, source) => openChatMenu(chat.id, position, source)}
        onRename={(title) => void renameChat(chat, title)}
        onRenameCancel={() => {
          setRenamingChatId(null);
          focusLater(chatRowSelector(chat.id), LIST_SELECTOR);
        }}
      />
    );
  }

  return (
    <nav aria-label="Chats" data-chat-list="" tabIndex={-1} className="flex h-full w-full flex-col border-r border-[var(--border)] bg-[var(--bg-raised)]">
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
            <ul className="space-y-0.5">{sidebar.pinned.map((c) => renderRow(c, { chats: sidebar.pinned, pinned: true, projectId: null }))}</ul>
          </div>
        )}

        {searching && sidebar.pinned.length === 0 && sidebar.groups.length === 0 && sidebar.archived.length === 0 && (
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
              {...(project ? projectGroupProps(project) : {})}
            >
              {group.chats.map((c) => renderRow(c, { chats: group.chats, pinned: false, projectId: project?.id ?? null }))}
            </ProjectGroup>
          );
        })}

        {sidebar.archived.length > 0 && (
          <div className="mb-3" data-testid="archived-section">
            <button
              type="button"
              aria-expanded={showArchived}
              onClick={toggleArchived}
              className="w-full rounded px-2 py-1 text-left text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase hover:bg-[var(--bg-sunken)]"
            >
              {showArchived ? 'Hide archived' : `Show archived (${sidebar.archived.length})`}
            </button>
            {showArchived && <ul className="space-y-0.5">{sidebar.archived.map((c) => renderRow(c, null))}</ul>}
          </div>
        )}

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
            onCancel={closeNewProject}
          />
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void createChat()}
            // aria-disabled, not disabled: a disabled button drops keyboard focus while a chat is being created.
            aria-disabled={creating || profiles.length === 0 || undefined}
            title={profiles.length === 0 ? 'Create a profile before starting a chat.' : undefined}
            className="flex-1 rounded bg-[var(--accent)] px-2 py-1.5 text-sm font-medium text-[var(--accent-text)] aria-disabled:opacity-50"
          >
            + New chat
          </button>
          <button
            ref={newProjectButton}
            type="button"
            onClick={() => {
              if (!newProjectOpen) setNewProjectOpen(true);
            }}
            aria-disabled={newProjectOpen || undefined}
            className="rounded border border-[var(--border)] px-2 py-1.5 text-sm hover:bg-[var(--bg-sunken)] aria-disabled:opacity-50"
          >
            + New project
          </button>
        </div>
      </div>

      {chatMenu && menuChat && (
        <Menu
          key={`chat:${menuChat.id}`}
          label="Chat actions"
          position={chatMenu.position}
          items={chatMenuItems(
            menuChat,
            orderedProjects,
            {
              rename: () => setRenamingChatId(menuChat.id),
              setPinned: (pinned) => void setPinned(menuChat, pinned),
              reorder: (dir) => void reorderChat(menuChat, dir),
              moveTo: (projectId) => void moveChat(menuChat.id, projectId),
              moveToNewProject: () => void moveToNewProject(menuChat),
              exportAs: (format) => void exportChat(menuChat, format),
              setMemoryExcluded: (excluded) => void setMemoryExcluded(menuChat, excluded),
              archive: () => void archiveChat(menuChat),
              unarchive: () => void unarchiveChat(menuChat),
              requestDelete: () => setDeletingChatId(menuChat.id),
            },
            menuPosition(menuChat)
          )}
          onClose={(reason) => {
            setChatMenu(null);
            // Esc, Tab or a scroll: back to the opener. A click elsewhere keeps focus where the user put it.
            if (reason === 'dismiss') focusLater(chatRowSelector(menuChat.id), LIST_SELECTOR);
          }}
        />
      )}

      {deletingChat && (
        <ConfirmDialog
          title={`Delete '${deletingChat.title}'? This can't be undone.`}
          confirmLabel="Delete"
          onConfirm={() => deleteChat(deletingChat.id)}
          onCancel={() => {
            setDeletingChatId(null);
            focusLater(chatRowSelector(deletingChat.id), LIST_SELECTOR);
          }}
        />
      )}

      {projectMenu && menuProject && (
        <Menu
          key={`project:${menuProject.id}`}
          label="Project actions"
          position={projectMenu.position}
          items={projectMenuItems(
            orderedProjects.findIndex((p) => p.id === menuProject.id),
            orderedProjects.length,
            {
              rename: () => setRenamingProjectId(menuProject.id),
              setFolder: () => setEditingProject({ projectId: menuProject.id, field: 'folder' }),
              setDefaultProfile: () => setEditingProject({ projectId: menuProject.id, field: 'profile' }),
              move: (dir) => void moveProject(menuProject.id, dir),
              requestDelete: () => setDeletingProjectId(menuProject.id),
            }
          )}
          onClose={(reason) => {
            setProjectMenu(null);
            if (reason === 'dismiss') focusLater(headingSelector(menuProject.id), LIST_SELECTOR);
          }}
        />
      )}

      {deletingProject && (
        <ConfirmDialog
          title={`Delete project '${deletingProject.name}'?`}
          message="Its chats move to No project."
          confirmLabel="Delete"
          onConfirm={() => deleteProject(deletingProject.id)}
          onCancel={() => {
            setDeletingProjectId(null);
            focusLater(headingSelector(deletingProject.id), LIST_SELECTOR);
          }}
        />
      )}
    </nav>
  );
}
