import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { APP_FOLDER_NAME_MAX, APP_NAME_MAX, compareAppFolders } from '@otherbench/core/domain/apps.js';
import { exportFilename } from '@otherbench/core/domain/export.js';
import { compareProjects, PROJECT_NAME_MAX, projectDisplayName, projectLookup, projectParentOf } from '@otherbench/core/domain/projects.js';
import type { App, AppFolder, Chat, Project } from '@otherbench/core/ports/store.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { FolderPlusIcon, PinIcon } from '../components/icons.js';
import { Menu } from '../components/Menu.js';
import { onDesktopEvent } from '../desktop/bridge.js';
import { saveFile } from '../lib/saveFile.js';
import { NARROW_BREAKPOINT, useMediaQuery } from '../lib/useMediaQuery.js';
import { useNow } from '../lib/useNow.js';
import { ApiError, api, type ChatPatchBody, type CreateChatBody } from '../state/api.js';
import { appTabId } from '../state/appTab.js';
import { setChatPinned } from '../state/chatActions.js';
import { chatStatus, groupStatus, groupStatusSummary, useChatActivity, useReadingChatIds, type ChatStatus } from '../state/chatStatus.js';
import { modeOfChat, type Mode } from '../state/mode.js';
import { projectTabId } from '../state/projectTab.js';
import { NO_PROJECT_KEY, setGroupCollapsed, useCollapsedGroups } from '../state/sidebarGroups.js';
import { groupSortOf, setGroupSort, useGroupSorts } from '../state/sidebarSort.js';
import { OverviewJumpList } from '../overview/OverviewJumpList.js';
import { selectOverviewTotal, useOtherBenchStore } from '../state/store.js';
import { CHAT_DRAG_MIME, ChatRow, type DropPosition, type MenuSource } from './sidebar/ChatRow.js';
import { appMenuItems, chatMenuItems, folderMenuItems, groupSortItem, projectMenuItems } from './sidebar/menus.js';
import {
  AGE_BUCKET_LABELS,
  allGroups,
  bucketRuns,
  appSiblings,
  buildCodeSidebar,
  buildSidebar,
  capRows,
  fileAppPatches,
  folderKey,
  GROUP_ROW_CAP,
  moveAppPatches,
  moveFolderPatches,
  moveProjectPatches,
  moveTarget,
  placeChatPatches,
  placeAppPatches,
  placeFolderPatches,
  placeProjectPatches,
  projectSiblings,
  titleMatches,
  type CodeSidebarFolder,
  type CodeSidebarGroup,
  type SidebarGroup,
} from './sidebar/model.js';
import { PROJECT_DRAG_MIME, ProjectGroup, type ProjectGroupProps } from './sidebar/ProjectGroup.js';

/** A sidebar error line: the server's own message when there is one. */
function errorText(err: unknown, action: string): string {
  return err instanceof ApiError ? `${action}: ${err.message}` : `${action} -- please try again.`;
}

/**
 * Focuses `selector` once React has committed (a moved row re-mounts under
 * its new group), unless focus has meanwhile gone into a menu, a dialog or a
 * text field -- another action took it on purpose.
 */
function focusLater(selector: string, fallback?: string, options?: FocusOptions): void {
  setTimeout(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[role="menu"], [role="alertdialog"], input, select, textarea')) return;
    const target = document.querySelector<HTMLElement>(selector) ?? (fallback ? document.querySelector<HTMLElement>(fallback) : null);
    target?.focus(options);
  }, 0);
}

/** The chat list itself: the stable place focus falls back to when the row it wanted is gone. */
const LIST_SELECTOR = '[data-chat-list]';

function chatRowSelector(chatId: string): string {
  return `[data-testid="chat-row-${chatId}"] [data-row-main]`;
}

/** localStorage key: whether the "Show archived" section is open. Per device. */
export const SHOW_ARCHIVED_STORAGE_KEY = 'otherbench.showArchived';

function loadShowArchived(): boolean {
  try {
    return window.localStorage.getItem(SHOW_ARCHIVED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** A list of chats as the sidebar shows them: Pinned, a project's own pinned chats, or the rest of one project's group (null = No project). */
interface Section {
  chats: Chat[];
  pinned: boolean;
  projectPinned: boolean;
  projectId: string | null;
  /** In a group sorted by recent activity: its order isn't the user's to change. */
  recent: boolean;
}

/** A filter chip under the search box, on or off. */
function chipClass(on: boolean): string {
  return `rounded-full border px-2 py-0.5 text-xs ${
    on ? 'border-[var(--accent)] bg-[var(--bg-sunken)] text-[var(--text)]' : 'border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text)]'
  }`;
}

function headingSelector(projectId: string): string {
  return `[data-testid="group-heading-${projectId}"] [data-heading-main]`;
}

/**
 * Left pane (spec 2026-10-03-projects-design §3): search, then Pinned, each
 * project, and No project, with "+ New chat" and "+ New project" at the
 * bottom. Search matches chat titles here and message text through
 * `GET /api/search?scope=chats`, and the chips under it keep only chats with
 * a status, or that run on one machine. Any of those filters every group to
 * the matching chats; groups with no match hide, and collapsed or capped
 * groups show in full, while one is active. A group shows its first
 * `GROUP_ROW_CAP` chats until "Show N more", and orders them by hand or, with
 * date headings, by recent activity (its menu's sort item).
 *
 * A Chat | Code switch above the search picks the mode (spec
 * 2026-10-20-code-tab-design, Goal 1). Code mode lists each app with its chats
 * instead (`buildCodeSidebar`), and Chat mode never shows an app chat: a chat
 * lives in one mode only. Search and the chips work the same in both, and
 * while searching a trailing "In Code mode" / "In Chat mode" section lists the
 * other mode's matches; opening one switches mode. An app's
 * heading opens its home, collapses from its arrow, and has a menu (Rename,
 * Edit…, Delete…); each app's list ends with a "+ New chat" row, and "+ New
 * app" takes the place of "+ New chat" at the bottom. In Code mode there is no
 * Pinned section and no reordering by hand: a pinned app chat leads its group.
 * Apps can sit in folders (plan 2026-10-25-app-folders): foldable headings
 * above the top-level apps, made with "+ New folder" beside "+ New app", and
 * filed into by dragging an app's heading or its menu's Move to folder….
 *
 * `footer` renders at the end of the New chat / New project row, for
 * app-level controls the caller owns (Settings, Usage). `wrapFooter` lets
 * that row wrap onto a second line instead of running out of the sidebar
 * (signed-in remote access adds a fourth button, which a phone-width sidebar
 * can't fit).
 */
export function ChatList({ footer, wrapFooter = false }: { footer?: ReactNode; wrapFooter?: boolean } = {}): JSX.Element {
  const chats = useOtherBenchStore((s) => s.chats);
  const projects = useOtherBenchStore((s) => s.projects);
  const profiles = useOtherBenchStore((s) => s.profiles);
  const activeChatId = useOtherBenchStore((s) => s.activeChatId);
  const setActiveChatId = useOtherBenchStore((s) => s.setActiveChatId);
  const upsertChat = useOtherBenchStore((s) => s.upsertChat);
  const upsertProject = useOtherBenchStore((s) => s.upsertProject);
  const openProjectPage = useOtherBenchStore((s) => s.openProjectPage);
  const removeChat = useOtherBenchStore((s) => s.removeChat);
  const removeProject = useOtherBenchStore((s) => s.removeProject);
  const setProjects = useOtherBenchStore((s) => s.setProjects);
  const openTab = useOtherBenchStore((s) => s.openTab);
  const openSchedules = useOtherBenchStore((s) => s.openSchedules);
  const paneTabs = useOtherBenchStore((s) => s.paneState.tabs);
  const machines = useOtherBenchStore((s) => s.machines);
  const apps = useOtherBenchStore((s) => s.apps);
  const appFolders = useOtherBenchStore((s) => s.appFolders);
  const mode = useOtherBenchStore((s) => s.mode);
  const setMode = useOtherBenchStore((s) => s.setMode);
  const overviewOpen = useOtherBenchStore((s) => s.overviewOpen);
  const setOverviewOpen = useOtherBenchStore((s) => s.setOverviewOpen);
  const overviewTotal = useOtherBenchStore(selectOverviewTotal);
  const openAppHome = useOtherBenchStore((s) => s.openAppHome);
  const openAppPage = useOtherBenchStore((s) => s.openAppPage);
  const upsertApp = useOtherBenchStore((s) => s.upsertApp);
  const setApps = useOtherBenchStore((s) => s.setApps);
  const removeApp = useOtherBenchStore((s) => s.removeApp);
  const upsertAppFolder = useOtherBenchStore((s) => s.upsertAppFolder);
  const setAppFolders = useOtherBenchStore((s) => s.setAppFolders);
  const removeAppFolder = useOtherBenchStore((s) => s.removeAppFolder);
  const codeMode = mode === 'code';
  const collapsedGroups = useCollapsedGroups();
  const groupSorts = useGroupSorts();
  const now = useNow(60_000);
  const { waiting, working, background } = useChatActivity();
  const reading = useReadingChatIds(useMediaQuery(NARROW_BREAKPOINT));

  const [query, setQuery] = useState('');
  /** The server's message-text hits for the query; a previous query's stay until the new answer, so rows don't blink while typing. */
  const [searchChatIds, setSearchChatIds] = useState<ReadonlySet<string> | null>(null);
  const searchSeq = useRef(0);
  const [statusOnly, setStatusOnly] = useState(false);
  /** The Machine chip: only chats that run on this node id; null = any. */
  const [machine, setMachine] = useState<string | null>(null);
  /** Groups opened past their cap with "Show N more", this session only. */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [noProjectMenu, setNoProjectMenu] = useState<{ x: number; y: number } | null>(null);
  const [creating, setCreating] = useState(false);
  // A ref, not state: a double-click's second click runs before a re-render could show the first is in flight.
  const creatingFolder = useRef(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [rowDrop, setRowDrop] = useState<{ chatId: string; position: DropPosition } | null>(null);
  // The chat being dragged, while it is: with nothing pinned yet, a "Drop here to pin" target takes the search
  // box's place. Not a new section in the list, which would push every row down under the pointer mid-drag.
  const [draggingChatId, setDraggingChatId] = useState<string | null>(null);
  const [pinZoneActive, setPinZoneActive] = useState(false);
  // The project heading being dragged, and the sibling heading it's over: where a drop would place it.
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [projectDrop, setProjectDrop] = useState<{ projectId: string; position: DropPosition } | null>(null);
  // Dragging an app's heading in Code mode, as with project headings in Chat mode.
  const [draggingAppId, setDraggingAppId] = useState<string | null>(null);
  const [appDrop, setAppDrop] = useState<{ appId: string; position: DropPosition } | null>(null);
  // Dragging a folder's heading; and the folder heading a dragged folder or app is over (an app ignores `position`).
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null);
  const [folderDrop, setFolderDrop] = useState<{ folderId: string; position: DropPosition } | null>(null);
  const [topLevelZoneActive, setTopLevelZoneActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatMenu, setChatMenu] = useState<{ chatId: string; position: { x: number; y: number } } | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; position: { x: number; y: number } } | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(loadShowArchived);
  const [appMenu, setAppMenu] = useState<{ appId: string; position: { x: number; y: number } } | null>(null);
  const [renamingAppId, setRenamingAppId] = useState<string | null>(null);
  const [deletingAppId, setDeletingAppId] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folderId: string; position: { x: number; y: number } } | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);

  const trimmedQuery = query.trim();
  // A chip left on for a machine since unpaired would hide everything, with no chip shown to turn it off.
  const machineFilter = machines?.peers.length ? machine : null;
  const searching = trimmedQuery !== '' || statusOnly || machineFilter !== null;
  // The chats the status and machine chips allow (null with neither on); the open chat is never hidden by them:
  // reading a reply clears its dot, and a new chat runs here.
  const chipMatches = useMemo(() => {
    if (!statusOnly && machineFilter === null) return null;
    return new Set(
      chats
        .filter((c) => c.id === activeChatId || !statusOnly || chatStatus(c, waiting, working, background) !== null)
        .filter((c) => c.id === activeChatId || machineFilter === null || c.runsOn === machineFilter)
        .map((c) => c.id)
    );
  }, [chats, statusOnly, machineFilter, activeChatId, waiting, working, background]);
  const matches = useMemo(() => {
    if (!searching) return null;
    return new Set(
      chats
        .filter((c) => trimmedQuery === '' || titleMatches(c.title, trimmedQuery) || searchChatIds?.has(c.id) === true)
        .filter((c) => chipMatches === null || chipMatches.has(c.id))
        .map((c) => c.id)
    );
  }, [searching, chats, trimmedQuery, searchChatIds, chipMatches]);
  const sidebar = useMemo(() => buildSidebar(chats, projects, matches, (key) => groupSortOf(groupSorts, key)), [chats, projects, matches, groupSorts]);
  const codeSidebar = useMemo(() => buildCodeSidebar(chats, apps, appFolders, matches, trimmedQuery, chipMatches), [chats, apps, appFolders, matches, trimmedQuery, chipMatches]);
  const archived = codeMode ? codeSidebar.archived : sidebar.archived;
  const otherMode = codeMode ? codeSidebar.otherMode : sidebar.otherMode;
  const menuApp = appMenu ? (apps.find((a) => a.id === appMenu.appId) ?? null) : null;
  const deletingApp = deletingAppId ? (apps.find((a) => a.id === deletingAppId) ?? null) : null;
  const sortedFolders = useMemo(() => [...appFolders].sort(compareAppFolders), [appFolders]);
  const menuFolder = folderMenu ? (appFolders.find((f) => f.id === folderMenu.folderId) ?? null) : null;
  const deletingFolder = deletingFolderId ? (appFolders.find((f) => f.id === deletingFolderId) ?? null) : null;
  const draggingApp = draggingAppId ? (apps.find((a) => a.id === draggingAppId) ?? null) : null;
  const lookup = useMemo(() => projectLookup(projects), [projects]);
  /** Sidebar order: each top-level project, then its sub-projects. */
  const orderedProjects = useMemo(() => {
    const sorted = [...projects].sort(compareProjects);
    const parentOf = (p: Project): string | null => projectParentOf(p, lookup)?.id ?? null;
    return sorted.filter((p) => parentOf(p) === null).flatMap((p) => [p, ...sorted.filter((c) => parentOf(c) === p.id)]);
  }, [projects, lookup]);
  // Looked up on every render, so the menu and dialog act on the chat as it is now.
  const menuChat = chatMenu ? (chats.find((c) => c.id === chatMenu.chatId) ?? null) : null;
  const deletingChat = deletingChatId ? (chats.find((c) => c.id === deletingChatId) ?? null) : null;
  const menuProject = projectMenu ? (projects.find((p) => p.id === projectMenu.projectId) ?? null) : null;
  const menuSiblings = menuProject ? projectSiblings(projects, menuProject.id) : [];
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
      const results = await api.searchChats(q);
      // A newer keystroke, or clearing the box, supersedes this response.
      if (seq !== searchSeq.current) return;
      setSearchChatIds(new Set(results.map((r) => r.chatId)));
    } catch (err) {
      console.error('[otherbench-web] search failed:', err);
    }
  }

  /**
   * A new chat in a project, an app (Code mode), or neither. `into` names the
   * group the "+" belongs to; nothing means No project.
   */
  async function createChat(into?: { projectId: string } | { appId: string }): Promise<void> {
    if (creating) return;
    const projectId = into && 'projectId' in into ? into.projectId : undefined;
    let body: CreateChatBody;
    if (into && 'appId' in into) {
      // As for a project: the server gives the chat the app's folder and its
      // default profile, else the app-wide default (spec 2026-10-20-code-tab-design).
      body = { appId: into.appId };
    } else if (projectId !== undefined) {
      // The server copies the project's folder and default profile onto the
      // new chat, falling back to the app default profile (spec §2).
      body = { projectId };
    } else {
      const defaultProfile = profiles.find((p) => p.isDefault && p.archivedAt === null) ?? profiles.find((p) => p.archivedAt === null);
      if (!defaultProfile) return;
      body = { profileId: defaultProfile.id };
    }
    // A chat created into a collapsed group (or one inside a collapsed parent) would be invisible.
    setGroupCollapsed(into && 'appId' in into ? into.appId : (projectId ?? NO_PROJECT_KEY), false);
    const parent = projectId === undefined ? undefined : lookup(projectId);
    const parentId = parent ? projectParentOf(parent, lookup)?.id : undefined;
    if (parentId) setGroupCollapsed(parentId, false);
    setCreating(true);
    setError(null);
    try {
      const chat = await api.chats.create(body);
      upsertChat(chat);
      // Shown in the pane, not made a tab: only what the user asks to be a tab becomes one.
      setActiveChatId(chat.id);
    } catch (err) {
      console.error('[otherbench-web] failed to create chat:', err);
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
      console.error(`[otherbench-web] failed to update chat ${chat.id}:`, err);
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
    const chat = useOtherBenchStore.getState().chats.find((c) => c.id === chatId);
    if (!chat || chat.projectId === projectId) return;
    const group = allGroups(sidebar).find((g) => g.key === (projectId ?? NO_PROJECT_KEY))?.chats ?? [];
    const top = chat.pinned ? [] : placeChatPatches(group, chat, group[0]?.id ?? null).filter((p) => p.id === chat.id);
    const body: ChatPatchBody = { projectId, ...(top[0] ? { sortOrder: top[0].sortOrder } : {}) };
    // An app chat moved to a project leaves its app (the server clears appId), so it changes mode too.
    await moveAcrossModes(chat, body, "Couldn't move the chat");
  }

  /**
   * Sends a PATCH that may take the chat into or out of an app, so out of the
   * mode showing. The store then drops it from this mode's tabs (a chat lives
   * in one mode only, spec 2026-10-20-code-tab-design); when it was the open
   * chat, the window follows it into its new mode rather than losing it.
   */
  async function moveAcrossModes(chat: Chat, body: ChatPatchBody, action: string): Promise<void> {
    const wasOpen = useOtherBenchStore.getState().activeChatId === chat.id;
    const updated = await patchChat(chat, body, action);
    if (!updated) return;
    if (wasOpen && modeOfChat(updated) !== modeOfChat(chat)) setActiveChatId(updated.id);
    focusLater(chatRowSelector(chat.id), LIST_SELECTOR);
  }

  /**
   * "Move to app…" (spec 2026-10-20-code-tab-design, Goal 8): the server sets the chat's folder and profile from
   * the app and takes it out of its project. Null is "Move out of app": back to Chat mode, folder kept.
   */
  async function moveChatToApp(chatId: string, appId: string | null): Promise<void> {
    const chat = useOtherBenchStore.getState().chats.find((c) => c.id === chatId);
    if (!chat || chat.appId === appId) return;
    await moveAcrossModes(chat, { appId }, appId === null ? "Couldn't move the chat out of its app" : "Couldn't move the chat to the app");
  }

  /**
   * Puts chat `chatId` in `section` just above `beforeId` (null = the bottom),
   * filing, pinning or unpinning it to match the section (#823). Usually one
   * PATCH; a renumbered section sends one per chat that changes.
   */
  async function placeChat(chatId: string, section: Section, beforeId: string | null): Promise<void> {
    const chat = useOtherBenchStore.getState().chats.find((c) => c.id === chatId);
    if (!chat || chat.archivedAt !== null) return;
    const patches = placeChatPatches(section.chats, chat, beforeId);
    const own = patches.find((p) => p.id === chatId);
    const body: ChatPatchBody = {
      ...(own ? { sortOrder: own.sortOrder } : {}),
      ...(chat.pinned !== section.pinned ? { pinned: section.pinned } : {}),
      // Pinned in its project when dropped among that project's pinned chats, unpinned when dropped among the rest.
      ...(!section.pinned && chat.projectPinned !== section.projectPinned ? { projectPinned: section.projectPinned } : {}),
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
      console.error('[otherbench-web] failed to reorder chats:', err);
      setError(errorText(err, "Couldn't move the chat"));
      // Part of the reorder may have landed: show the server's order, not a guess.
      try {
        useOtherBenchStore.getState().setChats(await api.chats.list());
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

  /**
   * The section the sidebar shows `chat` in, or null when it isn't shown in one: archived, or an app chat. Code mode
   * has no Pinned section and no ordering by hand (a pinned app chat leads its group), so an app chat is in none of
   * Chat mode's sections and its menu offers no Move up / Move down (spec 2026-10-20-code-tab-design, Goal 1).
   */
  function sectionOf(chat: Chat): Section | null {
    if (chat.archivedAt !== null || chat.appId !== null || codeMode) return null;
    if (chat.pinned) return { chats: sidebar.pinned, pinned: true, projectPinned: false, projectId: null, recent: false };
    for (const group of allGroups(sidebar)) {
      const projectId = group.project?.id ?? null;
      const recent = group.sort === 'recent';
      if (group.pinnedChats.some((c) => c.id === chat.id)) return { chats: group.pinnedChats, pinned: false, projectPinned: true, projectId, recent };
      if (group.chats.some((c) => c.id === chat.id)) return { chats: group.chats, pinned: false, projectPinned: false, projectId, recent };
    }
    return null;
  }

  /** The chat's place in its section, for the menu's Move up / Move down; null while searching, when archived, or in a recent group. */
  function menuPosition(chat: Chat): { index: number; count: number } | null {
    const section = searching ? null : sectionOf(chat);
    if (section?.recent) return null;
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
      console.error('[otherbench-web] failed to create a project for the chat:', err);
      setError(errorText(err, "Couldn't create the project"));
    }
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
    setNoProjectMenu(null);
    setAppMenu(null);
    setFolderMenu(null);
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

  /**
   * `preventScroll` for the row's own pin button: the row moves into or out
   * of Pinned at the top, and following it there would lose the user's place
   * when pinning several chats from far down the list.
   */
  async function setPinned(chat: Chat, pinned: boolean, preventScroll = false): Promise<void> {
    setError(null);
    try {
      await setChatPinned(chat.id, pinned);
      focusLater(chatRowSelector(chat.id), LIST_SELECTOR, preventScroll ? { preventScroll: true } : undefined);
    } catch (err) {
      console.error(`[otherbench-web] failed to update chat ${chat.id}:`, err);
      setError(errorText(err, pinned ? "Couldn't pin the chat" : "Couldn't unpin the chat"));
    }
  }

  async function setProjectPinned(chat: Chat, pinned: boolean): Promise<void> {
    const action = pinned ? "Couldn't pin the chat in its project" : "Couldn't unpin the chat from its project";
    if (await patchChat(chat, { projectPinned: pinned }, action)) focusLater(chatRowSelector(chat.id), LIST_SELECTOR);
  }

  async function setMemoryExcluded(chat: Chat, excluded: boolean): Promise<void> {
    const action = excluded ? "Couldn't stop this chat adding to project memory" : "Couldn't let this chat add to project memory";
    if (await patchChat(chat, { memoryExcluded: excluded }, action)) focusLater(chatRowSelector(chat.id), LIST_SELECTOR);
  }

  async function exportChat(chat: Chat, format: 'markdown' | 'json'): Promise<void> {
    setError(null);
    try {
      await saveFile(await api.chats.export(chat.id, format), exportFilename(chat.title, format === 'json' ? 'json' : 'md'));
    } catch (err) {
      console.error(`[otherbench-web] failed to export chat ${chat.id}:`, err);
      setError(errorText(err, "Couldn't export the chat"));
    }
    focusLater(chatRowSelector(chat.id), LIST_SELECTOR);
  }

  /** Hides the chat from the sidebar (spec §3: reuses `archivedAt`). */
  async function archiveChat(chat: Chat): Promise<void> {
    const next = neighbourSelector(chat.id);
    const updated = await patchChat(chat, { archivedAt: Date.now() }, "Couldn't archive the chat");
    if (!updated) return;
    if (useOtherBenchStore.getState().activeChatId === chat.id) setActiveChatId(null);
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
    if (useOtherBenchStore.getState().activeChatId === chatId) setActiveChatId(null);
    setDeletingChatId(null);
    focusLater(next, LIST_SELECTOR);
  }

  function openProjectMenu(projectId: string, position: { x: number; y: number }, source: MenuSource): void {
    setChatMenu(null);
    setNoProjectMenu(null);
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
      console.error(`[otherbench-web] failed to rename project ${projectId}:`, err);
      setError(errorText(err, "Couldn't rename the project"));
    }
    focusLater(headingSelector(projectId), LIST_SELECTOR);
  }

  /** Puts a project under a top-level one (opening that group so it stays in view), or back at the top level. */
  async function moveProjectUnder(projectId: string, parentId: string | null): Promise<void> {
    setError(null);
    try {
      upsertProject(await api.projects.patch(projectId, { parentId }));
      if (parentId) setGroupCollapsed(parentId, false);
    } catch (err) {
      console.error(`[otherbench-web] failed to move project ${projectId}:`, err);
      setError(errorText(err, "Couldn't move the project"));
    }
    focusLater(headingSelector(projectId), LIST_SELECTOR);
  }

  /** Sends project order PATCHes one by one; on a failure says so and shows the server's order, since part may have landed. */
  async function sendProjectOrder(patches: { id: string; sortOrder: number }[], focusId: string): Promise<void> {
    setError(null);
    try {
      for (const { id, sortOrder } of patches) upsertProject(await api.projects.patch(id, { sortOrder }));
    } catch (err) {
      console.error('[otherbench-web] failed to reorder projects:', err);
      setError(errorText(err, "Couldn't reorder the projects"));
      try {
        setProjects(await api.projects.list());
      } catch {
        // the error line above already says something went wrong.
      }
    }
    focusLater(headingSelector(focusId), LIST_SELECTOR);
  }

  /** Puts a dragged project above or below sibling `targetId` (a drop on its heading). */
  async function placeProject(movingId: string, targetId: string, position: DropPosition): Promise<void> {
    const siblings = projectSiblings(projects, movingId);
    if (movingId === targetId || !siblings.some((p) => p.id === targetId)) return;
    let beforeId: string | null = targetId;
    if (position === 'after') {
      const rest = siblings.filter((p) => p.id !== movingId);
      beforeId = rest[rest.findIndex((p) => p.id === targetId) + 1]?.id ?? null;
    }
    const patches = placeProjectPatches(siblings, movingId, beforeId);
    if (patches.length > 0) await sendProjectOrder(patches, movingId);
  }

  async function moveProject(projectId: string, dir: -1 | 1): Promise<void> {
    await sendProjectOrder(moveProjectPatches(projectSiblings(projects, projectId), projectId, dir), projectId);
  }

  function openNoProjectMenu(position: { x: number; y: number }, source: MenuSource): void {
    setChatMenu(null);
    setProjectMenu(null);
    if (source === 'button' && noProjectMenu !== null) {
      setNoProjectMenu(null);
      focusLater(headingSelector(NO_PROJECT_KEY), LIST_SELECTOR);
      return;
    }
    setNoProjectMenu(position);
  }

  /**
   * Sends app order PATCHes one by one (a patch with `folderId` also files that app); on a failure says so and shows
   * the server's apps, since part may have landed.
   */
  async function sendAppOrder(patches: { id: string; folderId?: string | null; sortOrder: number }[], focusId: string, action = "Couldn't reorder the apps"): Promise<void> {
    setError(null);
    try {
      for (const { id, folderId, sortOrder } of patches) upsertApp(await api.apps.patch(id, folderId === undefined ? { sortOrder } : { folderId, sortOrder }));
    } catch (err) {
      console.error('[otherbench-web] failed to reorder apps:', err);
      setError(errorText(err, action));
      try {
        setApps(await api.apps.list());
      } catch {
        // the error line above already says something went wrong.
      }
    }
    focusLater(headingSelector(focusId), LIST_SELECTOR);
  }

  /**
   * Puts a dragged app above or below app `targetId` (a drop on its heading). An app from another group, a folder or
   * the top level, is filed into the target's group at that place.
   */
  async function placeApp(movingId: string, targetId: string, position: DropPosition): Promise<void> {
    const group = appSiblings(apps, targetId, appFolders);
    if (movingId === targetId || group.length === 0) return;
    const rest = group.filter((a) => a.id !== movingId);
    const beforeId = position === 'before' ? targetId : (rest[rest.findIndex((a) => a.id === targetId) + 1]?.id ?? null);
    if (!group.some((a) => a.id === movingId)) {
      await fileApp(movingId, loadedFolderOf(group[0]!), beforeId);
      return;
    }
    const patches = placeAppPatches(group, movingId, beforeId);
    if (patches.length > 0) await sendAppOrder(patches, movingId);
  }

  /** The app's folder when that folder is loaded, else null: the top level, where the sidebar shows it. */
  function loadedFolderOf(app: App): string | null {
    return app.folderId !== null && appFolders.some((f) => f.id === app.folderId) ? app.folderId : null;
  }

  /**
   * Files an app in a folder (null = the top level) just above `beforeId` (null = last), renumbering only that group.
   * Filing into a folded folder opens it, so the app stays in view (plan 2026-10-25-app-folders).
   */
  async function fileApp(appId: string, folderId: string | null, beforeId: string | null): Promise<void> {
    const patches = fileAppPatches(apps, appFolders, appId, folderId, beforeId);
    if (patches.length === 0) return;
    if (folderId !== null) setGroupCollapsed(folderKey(folderId), false);
    await sendAppOrder(patches, appId, "Couldn't move the app");
  }

  /** "Move to folder…": last in that folder, or (null) the top level; nothing when it's there already. */
  async function moveAppToFolder(appId: string, folderId: string | null): Promise<void> {
    const app = apps.find((a) => a.id === appId);
    if (!app) return;
    if (loadedFolderOf(app) !== folderId) await fileApp(appId, folderId, null);
    else focusLater(headingSelector(appId), LIST_SELECTOR);
  }

  /** The app's place among its siblings in the Code sidebar's order. */
  function appIndex(appId: string): number {
    return appSiblings(apps, appId, appFolders).findIndex((a) => a.id === appId);
  }

  async function moveApp(appId: string, dir: -1 | 1): Promise<void> {
    await sendAppOrder(moveAppPatches(appSiblings(apps, appId, appFolders), appId, dir), appId);
  }

  /** "+ New folder": the server names it "New folder", and its name opens for editing, as a project rename works. */
  async function createFolder(): Promise<void> {
    if (creatingFolder.current) return;
    creatingFolder.current = true;
    setError(null);
    // A search would hide the new folder (and its rename) unless its name happened to match.
    if (query !== '') void runSearch('');
    try {
      const folder = await api.appFolders.create({});
      upsertAppFolder(folder);
      setRenamingFolderId(folder.id);
    } catch (err) {
      console.error('[otherbench-web] failed to create a folder:', err);
      setError(errorText(err, "Couldn't create the folder"));
    } finally {
      creatingFolder.current = false;
    }
  }

  async function renameFolder(folderId: string, name: string): Promise<void> {
    setRenamingFolderId(null);
    setError(null);
    try {
      upsertAppFolder(await api.appFolders.patch(folderId, { name }));
    } catch (err) {
      console.error(`[otherbench-web] failed to rename folder ${folderId}:`, err);
      setError(errorText(err, "Couldn't rename the folder"));
    }
    focusLater(headingSelector(folderKey(folderId)), LIST_SELECTOR);
  }

  /** As `sendAppOrder`, for folders. */
  async function sendFolderOrder(patches: { id: string; sortOrder: number }[], focusId: string): Promise<void> {
    setError(null);
    try {
      for (const { id, sortOrder } of patches) upsertAppFolder(await api.appFolders.patch(id, { sortOrder }));
    } catch (err) {
      console.error('[otherbench-web] failed to reorder folders:', err);
      setError(errorText(err, "Couldn't reorder the folders"));
      try {
        setAppFolders(await api.appFolders.list());
      } catch {
        // the error line above already says something went wrong.
      }
    }
    focusLater(headingSelector(folderKey(focusId)), LIST_SELECTOR);
  }

  /** Puts a dragged folder above or below folder `targetId` (a drop on its heading). */
  async function placeFolder(movingId: string, targetId: string, position: DropPosition): Promise<void> {
    if (movingId === targetId) return;
    const rest = sortedFolders.filter((f) => f.id !== movingId);
    const beforeId = position === 'before' ? targetId : (rest[rest.findIndex((f) => f.id === targetId) + 1]?.id ?? null);
    const patches = placeFolderPatches(appFolders, movingId, beforeId);
    if (patches.length > 0) await sendFolderOrder(patches, movingId);
  }

  async function moveFolder(folderId: string, dir: -1 | 1): Promise<void> {
    await sendFolderOrder(moveFolderPatches(appFolders, folderId, dir), folderId);
  }

  function openFolderMenu(folderId: string, position: { x: number; y: number }, source: MenuSource): void {
    setChatMenu(null);
    setAppMenu(null);
    if (source === 'button' && folderMenu?.folderId === folderId) {
      setFolderMenu(null);
      focusLater(headingSelector(folderKey(folderId)), LIST_SELECTOR);
      return;
    }
    setFolderMenu({ folderId, position });
  }

  /**
   * Rejects on failure, which keeps the confirmation dialog open with the message. Its apps move to the top level
   * (`removeAppFolder` clears their `folderId` here as the server does); nothing else changes, the open app included.
   */
  async function deleteFolder(folderId: string): Promise<void> {
    const next = neighbourHeadingSelector(folderKey(folderId));
    try {
      await api.appFolders.delete(folderId);
    } catch (err) {
      // Already gone (deleted in another tab): same end state the user asked for.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    removeAppFolder(folderId);
    setDeletingFolderId(null);
    focusLater(next, LIST_SELECTOR);
  }

  /** Opens a capped group in full (focus goes to the first chat it revealed), or caps it again. */
  function setGroupExpanded(key: string, expanded: boolean, firstRevealedId?: string): void {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (expanded) next.add(key);
      else next.delete(key);
      return next;
    });
    if (firstRevealedId) focusLater(chatRowSelector(firstRevealedId));
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
    // A heading takes a dragged project only from its own siblings (top level, or the same parent's sub-projects).
    const target = draggingProjectId !== null && draggingProjectId !== project.id && projectSiblings(projects, project.id).some((p) => p.id === draggingProjectId);
    return {
      reorder: {
        draggable: !searching,
        onDragStart: () => setDraggingProjectId(project.id),
        onDragEnd: () => {
          setDraggingProjectId(null);
          setProjectDrop(null);
        },
        target,
        indicator: target && projectDrop?.projectId === project.id ? projectDrop.position : null,
        onOver: (position) => setProjectDrop({ projectId: project.id, position }),
        onLeave: () => setProjectDrop((current) => (current?.projectId === project.id ? null : current)),
        onDrop: (position) => {
          const moving = draggingProjectId;
          setDraggingProjectId(null);
          setProjectDrop(null);
          if (moving) void placeProject(moving, project.id, position);
        },
      },
      onNewChat: () => void createChat({ projectId: project.id }),
      onOpen: () => setActiveChatId(projectTabId(project.id)),
      active: activeChatId === projectTabId(project.id),
      newChatDisabled: creating || profiles.length === 0,
      menuOpen: projectMenu?.projectId === project.id,
      renaming: renamingProjectId === project.id,
      onOpenMenu: (position, source) => openProjectMenu(project.id, position, source),
      onRename: (name) => void renameProject(project.id, name),
      onRenameCancel: () => {
        setRenamingProjectId(null);
        focusLater(headingSelector(project.id), LIST_SELECTOR);
      },
    };
  }

  function openAppMenu(appId: string, position: { x: number; y: number }, source: MenuSource): void {
    setChatMenu(null);
    setFolderMenu(null);
    if (source === 'button' && appMenu?.appId === appId) {
      setAppMenu(null);
      focusLater(headingSelector(appId), LIST_SELECTOR);
      return;
    }
    setAppMenu({ appId, position });
  }

  async function renameApp(appId: string, name: string): Promise<void> {
    setRenamingAppId(null);
    setError(null);
    try {
      upsertApp(await api.apps.patch(appId, { name }));
    } catch (err) {
      console.error(`[otherbench-web] failed to rename app ${appId}:`, err);
      setError(errorText(err, "Couldn't rename the app"));
    }
    focusLater(headingSelector(appId), LIST_SELECTOR);
  }

  /**
   * Rejects on failure, which keeps the confirmation dialog open with the message. Its chats go back to Chat mode
   * (spec 2026-10-20-code-tab-design, "Creating an app"): `removeApp` clears their `appId` here as the server does,
   * and the server's chat-updated events bring the rest.
   */
  async function deleteApp(appId: string): Promise<void> {
    const next = neighbourHeadingSelector(appId);
    try {
      await api.apps.delete(appId);
    } catch (err) {
      // Already gone (deleted in another tab): same end state the user asked for.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    removeApp(appId);
    setDeletingAppId(null);
    focusLater(next, LIST_SELECTOR);
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

  /** A reply ready in a chat the user is reading isn't news: useMarkRead is clearing it. */
  function statusOf(chat: Chat): ChatStatus | null {
    return chatStatus(reading.has(chat.id) ? { id: chat.id, unread: false } : chat, waiting, working, background);
  }

  /** A pinned chat's project, named after its parent when it's a sub-project. */
  function pinnedProjectName(projectId: string): string | undefined {
    const project = lookup(projectId);
    return project ? projectDisplayName(project, lookup) : undefined;
  }

  /** Every chat shown in a group and its sub-projects, for the heading's status dot. */
  function groupChats(group: SidebarGroup): Chat[] {
    return [...group.pinnedChats, ...group.chats, ...group.children.flatMap(groupChats)];
  }

  /**
   * One project's (or No project's) group: its pinned chats, its sub-projects' groups (spec
   * 2026-10-15-sub-projects-design §4), then its other chats, capped and sorted as the group says.
   */
  function renderGroup(group: SidebarGroup): JSX.Element {
    const project = group.project;
    const projectId = project?.id ?? null;
    const recent = group.sort === 'recent';
    const rest: Section = { chats: group.chats, pinned: false, projectPinned: false, projectId, recent };
    const expanded = searching || expandedGroups.has(group.key);
    const { visible, hidden } = expanded ? { visible: group.chats, hidden: 0 } : capRows(group.chats, GROUP_ROW_CAP, activeChatId);
    const firstHidden = hidden > 0 ? group.chats.find((c) => !visible.includes(c)) : undefined;
    const groupStatuses = groupChats(group).map(statusOf);
    return (
      <ProjectGroup
        key={group.key}
        groupKey={group.key}
        name={project?.name ?? 'No project'}
        count={group.total}
        empty={group.total === 0 && group.children.length === 0}
        collapsed={!searching && collapsedGroups.has(group.key)}
        status={groupStatus(groupStatuses)}
        statusSummary={groupStatusSummary(groupStatuses)}
        dropActive={dropTarget === group.key}
        onToggle={() => setGroupCollapsed(group.key, !collapsedGroups.has(group.key))}
        onDragTarget={(on) => setDropTarget((current) => (on ? group.key : current === group.key ? null : current))}
        onDropChat={(chatId) => void moveChat(chatId, projectId)}
        {...(project
          ? projectGroupProps(project)
          : {
              menuOpen: noProjectMenu !== null,
              menuLabel: 'No project actions',
              onOpenMenu: openNoProjectMenu,
            })}
      >
        {group.pinnedChats.map((c) => renderRow(c, { chats: group.pinnedChats, pinned: false, projectPinned: true, projectId, recent }))}
        {group.children.map((child) => (
          <li key={`sub-${child.key}`} data-testid={`subgroup-${child.key}`}>
            {renderGroup(child)}
          </li>
        ))}
        {recent
          ? bucketRuns(visible, now).flatMap((run) => [
              <li
                key={`bucket-${run.bucket}`}
                role="presentation"
                data-testid={`bucket-${group.key}-${run.bucket}`}
                className="px-2 pt-1.5 pb-0.5 text-[11px] text-[var(--text-faint)]"
              >
                {AGE_BUCKET_LABELS[run.bucket]}
              </li>,
              ...run.chats.map((c) => renderRow(c, rest)),
            ])
          : visible.map((c) => renderRow(c, rest))}
        {(hidden > 0 || (!searching && expandedGroups.has(group.key) && group.chats.length > GROUP_ROW_CAP)) && (
          // One key for both labels: React keeps the button, so focus stays on it when "Show fewer" folds the group.
          <li key="row-cap-toggle">
            <button
              type="button"
              data-testid={`group-more-${group.key}`}
              onClick={() => setGroupExpanded(group.key, hidden > 0, firstHidden?.id)}
              className="w-full rounded-sm px-2 py-[3px] text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
            >
              {hidden > 0 ? `Show ${hidden} more` : 'Show fewer'}
            </button>
          </li>
        )}
      </ProjectGroup>
    );
  }

  /**
   * One app's group in Code mode, or the Unknown app group (`group.app` null). An app's list always ends with
   * "+ New chat", so it never reads as empty; the name opens the app's home and the arrow folds the list.
   */
  function renderAppGroup(group: CodeSidebarGroup): JSX.Element {
    const app = group.app;
    const expanded = searching || expandedGroups.has(group.key);
    const { visible, hidden } = expanded ? { visible: group.chats, hidden: 0 } : capRows(group.chats, GROUP_ROW_CAP, activeChatId);
    const firstHidden = hidden > 0 ? group.chats.find((c) => !visible.includes(c)) : undefined;
    const statuses = group.chats.map(statusOf);
    return (
      <ProjectGroup
        key={group.key}
        groupKey={group.key}
        name={app?.name ?? 'Unknown app'}
        count={group.total}
        empty={false}
        collapsed={!searching && collapsedGroups.has(group.key)}
        status={groupStatus(statuses)}
        statusSummary={groupStatusSummary(statuses)}
        dropActive={app !== null && dropTarget === group.key}
        onToggle={() => setGroupCollapsed(group.key, !collapsedGroups.has(group.key))}
        // Dropping a chat on an app's heading files it there, as Move to app… does; Unknown app takes no drops.
        onDragTarget={(on) => {
          if (app) setDropTarget((current) => (on ? group.key : current === group.key ? null : current));
        }}
        onDropChat={(chatId) => {
          if (app) void moveChatToApp(chatId, app.id);
        }}
        {...(app ? appGroupProps(app) : {})}
      >
        {visible.map((c) => renderRow(c, null, false))}
        {(hidden > 0 || (!searching && expandedGroups.has(group.key) && group.chats.length > GROUP_ROW_CAP)) && (
          <li key="row-cap-toggle">
            <button
              type="button"
              data-testid={`group-more-${group.key}`}
              onClick={() => setGroupExpanded(group.key, hidden > 0, firstHidden?.id)}
              className="w-full rounded-sm px-2 py-[3px] text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
            >
              {hidden > 0 ? `Show ${hidden} more` : 'Show fewer'}
            </button>
          </li>
        )}
        {app && (
          <li key="new-chat">
            <button
              type="button"
              data-testid={`app-new-chat-${app.id}`}
              aria-label={`New chat in ${app.name}`}
              // aria-disabled, not disabled: a disabled button drops keyboard focus while a chat is being created.
              aria-disabled={creating || profiles.length === 0 || undefined}
              onClick={() => void createChat({ appId: app.id })}
              className="w-full rounded-sm px-2 py-[3px] text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] aria-disabled:opacity-40"
            >
              + New chat
            </button>
          </li>
        )}
      </ProjectGroup>
    );
  }

  /** The app-only props of a Code mode group heading. It takes a dragged app from any group, but not a folder. */
  function appGroupProps(app: App): Partial<ProjectGroupProps> {
    const target = draggingAppId !== null && draggingAppId !== app.id;
    return {
      reorder: {
        draggable: !searching,
        onDragStart: () => setDraggingAppId(app.id),
        onDragEnd: () => {
          setDraggingAppId(null);
          setAppDrop(null);
          setFolderDrop(null);
          setTopLevelZoneActive(false);
        },
        target,
        indicator: target && appDrop?.appId === app.id ? appDrop.position : null,
        onOver: (position) => setAppDrop({ appId: app.id, position }),
        onLeave: () => setAppDrop((current) => (current?.appId === app.id ? null : current)),
        onDrop: (position) => {
          const moving = draggingAppId;
          setDraggingAppId(null);
          setAppDrop(null);
          if (moving) void placeApp(moving, app.id, position);
        },
      },
      onOpen: () => openAppHome(app.id),
      openTitle: "Open the app's home",
      active: activeChatId === appTabId(app.id),
      menuOpen: appMenu?.appId === app.id,
      menuLabel: 'App actions',
      renaming: renamingAppId === app.id,
      renameLabel: 'App name',
      renameMaxLength: APP_NAME_MAX,
      onOpenMenu: (position, source) => openAppMenu(app.id, position, source),
      onRename: (name) => void renameApp(app.id, name),
      onRenameCancel: () => {
        setRenamingAppId(null);
        focusLater(headingSelector(app.id), LIST_SELECTOR);
      },
    };
  }

  /**
   * An app folder in Code mode (plan 2026-10-25-app-folders): a group heading whose list holds its apps' groups, nested
   * as sub-projects nest in Chat mode. The heading's dot sums every chat in its apps, so a folded folder still shows
   * that something is replying or waiting.
   */
  function renderFolder(entry: CodeSidebarFolder): JSX.Element {
    const statuses = entry.groups.flatMap((g) => g.chats).map(statusOf);
    return (
      <ProjectGroup
        key={entry.key}
        groupKey={entry.key}
        name={entry.folder.name}
        count={entry.total}
        countNoun="app"
        empty={entry.total === 0}
        emptyText="No apps yet"
        collapsed={!searching && collapsedGroups.has(entry.key)}
        status={groupStatus(statuses)}
        statusSummary={groupStatusSummary(statuses)}
        dropActive={draggingAppId !== null && folderDrop?.folderId === entry.folder.id}
        onToggle={() => setGroupCollapsed(entry.key, !collapsedGroups.has(entry.key))}
        // A folder holds apps, not chats: a chat goes on an app's heading.
        onDragTarget={() => {}}
        onDropChat={() => {}}
        {...folderGroupProps(entry.folder)}
      >
        {entry.groups.map((group) => (
          <li key={`sub-${group.key}`} data-testid={`subgroup-${group.key}`}>
            {renderAppGroup(group)}
          </li>
        ))}
      </ProjectGroup>
    );
  }

  /**
   * The folder-only props of a Code mode group heading. It takes a dragged folder (placed above or below it) and a
   * dragged app (filed last in it). Both drags carry `PROJECT_DRAG_MIME`, so which one is under way tells them apart.
   */
  function folderGroupProps(folder: AppFolder): Partial<ProjectGroupProps> {
    const folderTarget = draggingFolderId !== null && draggingFolderId !== folder.id;
    const over = folderDrop?.folderId === folder.id ? folderDrop.position : null;
    return {
      reorder: {
        draggable: !searching,
        onDragStart: () => setDraggingFolderId(folder.id),
        onDragEnd: () => {
          setDraggingFolderId(null);
          setFolderDrop(null);
        },
        target: folderTarget || draggingAppId !== null,
        // An app lands in the folder, not beside it, so it lights the heading (dropActive) rather than drawing a line.
        indicator: folderTarget ? over : null,
        onOver: (position) => setFolderDrop((current) => (current?.folderId === folder.id && current.position === position ? current : { folderId: folder.id, position })),
        onLeave: () => setFolderDrop((current) => (current?.folderId === folder.id ? null : current)),
        onDrop: (position) => {
          const movingFolder = draggingFolderId;
          const movingApp = draggingAppId;
          setDraggingFolderId(null);
          setDraggingAppId(null);
          setFolderDrop(null);
          setAppDrop(null);
          if (movingFolder) void placeFolder(movingFolder, folder.id, position);
          else if (movingApp) void fileApp(movingApp, folder.id, null);
        },
      },
      menuOpen: folderMenu?.folderId === folder.id,
      menuLabel: 'Folder actions',
      renaming: renamingFolderId === folder.id,
      renameLabel: 'Folder name',
      renameMaxLength: APP_FOLDER_NAME_MAX,
      onOpenMenu: (position, source) => openFolderMenu(folder.id, position, source),
      onRename: (name) => void renameFolder(folder.id, name),
      onRenameCancel: () => {
        setRenamingFolderId(null);
        focusLater(headingSelector(folderKey(folder.id)), LIST_SELECTOR);
      },
    };
  }

  /** `muted`: dimmed, as archived rows are; by default every row outside a section is one (Chat mode's archived list). */
  function renderRow(chat: Chat, section: Section | null, muted = section === null): JSX.Element {
    return (
      <ChatRow
        key={chat.id}
        chat={chat}
        status={statusOf(chat)}
        active={chat.id === activeChatId}
        onSelect={() => setActiveChatId(chat.id)}
        onDragStart={() => setDraggingChatId(chat.id)}
        onDragEnd={() => {
          setDropTarget(null);
          setRowDrop(null);
          setDraggingChatId(null);
          setPinZoneActive(false);
        }}
        reorder={
          // Reordering against a filtered list would place chats relative to ones the user can't see; a recent group orders itself.
          section && !searching && !section.recent
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
        muted={muted}
        onTogglePin={chat.archivedAt === null ? () => void setPinned(chat, !chat.pinned, true) : undefined}
        showPinMarker={!section?.pinned}
        projectPinMarker={section?.projectPinned === true}
        projectName={section?.pinned && chat.projectId ? pinnedProjectName(chat.projectId) : undefined}
        now={now}
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
      <div className="border-b border-[var(--border)] p-2">
        <div role="group" aria-label="Mode" data-testid="mode-switch" className="mb-2 grid grid-cols-3 gap-0.5 rounded-sm border border-[var(--border-strong)] bg-[var(--bg)] p-0.5">
          {(['chat', 'code'] as const satisfies readonly Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m && !overviewOpen}
              onClick={() => setMode(m)}
              className={`rounded-[3px] px-2 py-1 text-xs ${
                mode === m && !overviewOpen ? 'bg-[var(--bg-raised)] font-medium text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {m === 'chat' ? 'Chat' : 'Code'}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={overviewOpen}
            onClick={() => setOverviewOpen(true)}
            className={`flex items-center justify-center gap-1 rounded-[3px] px-2 py-1 text-xs ${
              overviewOpen ? 'bg-[var(--bg-raised)] font-medium text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            Overview
            {overviewTotal > 0 && (
              <span data-testid="overview-count" className="rounded-full bg-[var(--accent)] px-1.5 text-[0.65rem] tabular-nums text-[var(--bg)]">
                {overviewTotal}
              </span>
            )}
          </button>
        </div>
        {!codeMode && draggingChatId !== null && sidebar.pinned.length === 0 && !searching ? (
          <div
            data-testid="pinned-drop-zone"
            data-drop-active={pinZoneActive ? 'true' : undefined}
            onDragOver={(e) => {
              if (!Array.from(e.dataTransfer.types).includes(CHAT_DRAG_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (!pinZoneActive) setPinZoneActive(true);
            }}
            onDragLeave={(e) => {
              if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
              setPinZoneActive(false);
            }}
            onDrop={(e) => {
              const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME);
              setPinZoneActive(false);
              setDraggingChatId(null);
              if (!chatId) return;
              e.preventDefault();
              void placeChat(chatId, { chats: [], pinned: true, projectPinned: false, projectId: null, recent: false }, null);
            }}
            // Same box as the search field it stands in for, so nothing below it moves.
            className={`flex w-full items-center gap-1.5 rounded-sm border border-dashed px-2 py-1.5 text-sm text-[var(--text-muted)] ${
              pinZoneActive ? 'border-[var(--accent)] bg-[var(--bg-sunken)] text-[var(--text)]' : 'border-[var(--border-strong)] bg-[var(--bg)]'
            }`}
          >
            <PinIcon />
            Drop here to pin
          </div>
        ) : (
          <input
            type="search"
            value={query}
            onChange={(e) => void runSearch(e.target.value)}
            placeholder="Search chats..."
            aria-label="Search chats"
            className="w-full rounded-sm border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
          />
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1" data-testid="chat-filters">
          <button type="button" aria-pressed={statusOnly} onClick={() => setStatusOnly((on) => !on)} className={chipClass(statusOnly)}>
            Unread / working
          </button>
          {machines && machines.peers.length > 0 && (
            <select
              aria-label="Machine"
              value={machineFilter ?? ''}
              onChange={(e) => setMachine(e.target.value === '' ? null : e.target.value)}
              className={`${chipClass(machineFilter !== null)} bg-[var(--bg-raised)]`}
            >
              <option value="">Any machine</option>
              <option value={machines.self.id}>{machines.self.name} (this machine)</option>
              {machines.peers.map((p) => (
                <option key={p.nodeId} value={p.nodeId}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* relative: the group headings' screen-reader text is absolutely positioned, and without a positioned
          ancestor here it was placed against the page, escaped this scroll area's clipping and made the whole
          window scroll once a group sat below the fold. */}
      <div className="relative flex-1 overflow-y-auto px-1.5 py-1" data-testid="chat-list-scroll">
        {overviewOpen ? (
          <OverviewJumpList />
        ) : (
          <>
        {!codeMode && sidebar.pinned.length > 0 && (
          <div className="mb-1.5" data-testid="group-pinned">
            <h2 className="label-caps px-2 pb-1 text-[var(--text-muted)]">Pinned</h2>
            <ul>{sidebar.pinned.map((c) => renderRow(c, { chats: sidebar.pinned, pinned: true, projectPinned: false, projectId: null, recent: false }))}</ul>
          </div>
        )}

        {searching &&
          (codeMode ? codeSidebar.folders.length === 0 && codeSidebar.groups.length === 0 : sidebar.pinned.length === 0 && sidebar.groups.length === 0) &&
          archived.length === 0 &&
          otherMode.length === 0 && (
          <p className="px-2 py-4 text-sm text-[var(--text-faint)]">{trimmedQuery === '' ? 'No chats match these filters.' : 'No chats match your search.'}</p>
        )}

        {codeMode && !searching && apps.length === 0 && codeSidebar.folders.length === 0 && codeSidebar.groups.length === 0 && (
          <p className="px-2 py-4 text-sm text-[var(--text-faint)]">No apps yet. An app is a repo folder; its chats show here, under it.</p>
        )}

        {codeMode && codeSidebar.folders.map(renderFolder)}

        {/* While a filed app is dragged: the way out of its folder, after the last folder (where the top level
            starts). Only then, and below the folders, so what moves is the list under it, not the rows under the pointer. */}
        {codeMode && draggingApp !== null && loadedFolderOf(draggingApp) !== null && (
          <div
            data-testid="app-top-level-drop-zone"
            data-drop-active={topLevelZoneActive ? 'true' : undefined}
            onDragOver={(e) => {
              if (!Array.from(e.dataTransfer.types).includes(PROJECT_DRAG_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (!topLevelZoneActive) setTopLevelZoneActive(true);
            }}
            onDragLeave={(e) => {
              if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
              setTopLevelZoneActive(false);
            }}
            onDrop={(e) => {
              const moving = draggingAppId;
              setTopLevelZoneActive(false);
              setDraggingAppId(null);
              setAppDrop(null);
              if (!moving) return;
              e.preventDefault();
              // First, where the zone sits: just above the top-level apps.
              void fileApp(moving, null, codeSidebar.groups.find((g) => g.app !== null)?.app?.id ?? null);
            }}
            // The Pinned drop zone's look.
            className={`mb-1.5 flex w-full items-center gap-1.5 rounded-sm border border-dashed px-2 py-1.5 text-sm text-[var(--text-muted)] ${
              topLevelZoneActive ? 'border-[var(--accent)] bg-[var(--bg-sunken)] text-[var(--text)]' : 'border-[var(--border-strong)] bg-[var(--bg)]'
            }`}
          >
            No folder
          </div>
        )}

        {codeMode ? codeSidebar.groups.map(renderAppGroup) : sidebar.groups.map(renderGroup)}

        {archived.length > 0 && (
          <div className="mb-1.5" data-testid="archived-section">
            <button
              type="button"
              aria-expanded={showArchived}
              onClick={toggleArchived}
              className="label-caps w-full rounded-sm px-2 py-1 text-left text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]"
            >
              {showArchived ? 'Hide archived' : `Show archived (${archived.length})`}
            </button>
            {showArchived && <ul>{archived.map((c) => renderRow(c, null))}</ul>}
          </div>
        )}

        {/* While searching, the other mode's matches, so a chat is found from either mode; opening one switches to
            the mode it lives in (spec 2026-10-20-code-tab-design, "Decisions Adam made"). Dimmed and not draggable,
            as rows outside a section are: they don't belong to this mode's groups. */}
        {otherMode.length > 0 && (
          <div className="mb-1.5" data-testid="other-mode-section">
            <h2 className="label-caps px-2 pb-1 text-[var(--text-muted)]">{codeMode ? 'In Chat mode' : 'In Code mode'}</h2>
            <ul>{otherMode.map((c) => renderRow(c, null))}</ul>
          </div>
        )}

        {error && (
          <p role="alert" className="px-2 py-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
          </>
        )}
      </div>

      <div className={`flex items-center gap-1 border-t border-[var(--border)] p-2${wrapFooter ? ' flex-wrap' : ''}`}>
        {codeMode ? (
          // In Code mode a new chat starts from its app's "+ New chat" row, so the main button makes an app.
          <>
            <button type="button" onClick={() => openAppPage({ mode: 'create' })} className="btn btn-primary flex-1 px-2 py-1.5">
              + New app
            </button>
            <button type="button" onClick={() => void createFolder()} aria-label="New folder" title="New folder" className="btn px-2 py-1.5">
              <FolderPlusIcon />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void createChat()}
              // aria-disabled, not disabled: a disabled button drops keyboard focus while a chat is being created.
              aria-disabled={creating || profiles.length === 0 || undefined}
              title={profiles.length === 0 ? 'Create a profile before starting a chat.' : undefined}
              className="btn btn-primary flex-1 px-2 py-1.5"
            >
              + New chat
            </button>
            <button type="button" onClick={() => openProjectPage({ mode: 'create' })} aria-label="New project" title="New project" className="btn px-2 py-1.5">
              <FolderPlusIcon />
            </button>
          </>
        )}
        {footer}
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
              openInTab: () => openTab(menuChat.id),
              rename: () => setRenamingChatId(menuChat.id),
              setPinned: (pinned) => void setPinned(menuChat, pinned),
              setProjectPinned: (pinned) => void setProjectPinned(menuChat, pinned),
              reorder: (dir) => void reorderChat(menuChat, dir),
              moveTo: (projectId) => void moveChat(menuChat.id, projectId),
              moveToNewProject: () => void moveToNewProject(menuChat),
              moveToApp: (appId) => void moveChatToApp(menuChat.id, appId),
              moveOutOfApp: () => void moveChatToApp(menuChat.id, null),
              exportAs: (format) => void exportChat(menuChat, format),
              schedule: () => openSchedules({ kind: 'chat', chatId: menuChat.id }),
              setMemoryExcluded: (excluded) => void setMemoryExcluded(menuChat, excluded),
              archive: () => void archiveChat(menuChat),
              unarchive: () => void unarchiveChat(menuChat),
              requestDelete: () => setDeletingChatId(menuChat.id),
            },
            menuPosition(menuChat),
            paneTabs.includes(menuChat.id),
            apps,
            appFolders
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
            menuSiblings.findIndex((p) => p.id === menuProject.id),
            menuSiblings.length,
            groupSortOf(groupSorts, menuProject.id),
            {
              rename: () => setRenamingProjectId(menuProject.id),
              settings: () => openProjectPage({ mode: 'edit', projectId: menuProject.id, returnFocus: headingSelector(menuProject.id) }),
              schedule: () => openSchedules({ kind: 'project', projectId: menuProject.id }),
              move: (dir) => void moveProject(menuProject.id, dir),
              setSort: (sort) => {
                setGroupSort(menuProject.id, sort);
                focusLater(headingSelector(menuProject.id), LIST_SELECTOR);
              },
              newSubProject: () => openProjectPage({ mode: 'create', parentId: menuProject.id, returnFocus: headingSelector(menuProject.id) }),
              moveUnder: (parentId) => void moveProjectUnder(menuProject.id, parentId),
              requestDelete: () => setDeletingProjectId(menuProject.id),
            },
            {
              parentId: projectParentOf(menuProject, lookup)?.id ?? null,
              candidates: orderedProjects.filter((p) => p.id !== menuProject.id && projectParentOf(p, lookup) === null),
              // As the server checks it: any project naming this one as its parent.
              hasChildren: projects.some((p) => p.parentId === menuProject.id),
            }
          )}
          onClose={(reason) => {
            setProjectMenu(null);
            if (reason === 'dismiss') focusLater(headingSelector(menuProject.id), LIST_SELECTOR);
          }}
        />
      )}

      {noProjectMenu && (
        <Menu
          key="no-project"
          label="No project actions"
          position={noProjectMenu}
          items={[
            groupSortItem(groupSortOf(groupSorts, NO_PROJECT_KEY), (sort) => {
              setGroupSort(NO_PROJECT_KEY, sort);
              focusLater(headingSelector(NO_PROJECT_KEY), LIST_SELECTOR);
            }),
          ]}
          onClose={(reason) => {
            setNoProjectMenu(null);
            if (reason === 'dismiss') focusLater(headingSelector(NO_PROJECT_KEY), LIST_SELECTOR);
          }}
        />
      )}

      {appMenu && menuApp && (
        <Menu
          key={`app:${menuApp.id}`}
          label="App actions"
          position={appMenu.position}
          items={appMenuItems(
            appIndex(menuApp.id),
            appSiblings(apps, menuApp.id, appFolders).length,
            {
              rename: () => setRenamingAppId(menuApp.id),
              edit: () => openAppPage({ mode: 'edit', appId: menuApp.id, returnFocus: headingSelector(menuApp.id) }),
              move: (dir) => void moveApp(menuApp.id, dir),
              moveToFolder: (folderId) => void moveAppToFolder(menuApp.id, folderId),
              requestDelete: () => setDeletingAppId(menuApp.id),
            },
            sortedFolders,
            loadedFolderOf(menuApp)
          )}
          onClose={(reason) => {
            setAppMenu(null);
            if (reason === 'dismiss') focusLater(headingSelector(menuApp.id), LIST_SELECTOR);
          }}
        />
      )}

      {deletingApp && (
        <ConfirmDialog
          title={`Delete ${deletingApp.name}?`}
          message="Its chats move back to Chat mode; nothing is deleted."
          confirmLabel="Delete"
          onConfirm={() => deleteApp(deletingApp.id)}
          onCancel={() => {
            setDeletingAppId(null);
            focusLater(headingSelector(deletingApp.id), LIST_SELECTOR);
          }}
        />
      )}

      {folderMenu && menuFolder && (
        <Menu
          key={`folder:${menuFolder.id}`}
          label="Folder actions"
          position={folderMenu.position}
          items={folderMenuItems(sortedFolders.findIndex((f) => f.id === menuFolder.id), sortedFolders.length, {
            rename: () => setRenamingFolderId(menuFolder.id),
            move: (dir) => void moveFolder(menuFolder.id, dir),
            requestDelete: () => setDeletingFolderId(menuFolder.id),
          })}
          onClose={(reason) => {
            setFolderMenu(null);
            if (reason === 'dismiss') focusLater(headingSelector(folderKey(menuFolder.id)), LIST_SELECTOR);
          }}
        />
      )}

      {deletingFolder && (
        <ConfirmDialog
          title={`Delete ${deletingFolder.name}?`}
          message="Its apps move out of the folder; nothing is deleted."
          confirmLabel="Delete"
          onConfirm={() => deleteFolder(deletingFolder.id)}
          onCancel={() => {
            setDeletingFolderId(null);
            focusLater(headingSelector(folderKey(deletingFolder.id)), LIST_SELECTOR);
          }}
        />
      )}

      {deletingProject && (
        <ConfirmDialog
          title={`Delete project '${deletingProject.name}'?`}
          message={
            projects.some((p) => p.parentId === deletingProject.id)
              ? 'Its chats move to No project. Its sub-projects become top-level projects.'
              : 'Its chats move to No project.'
          }
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
