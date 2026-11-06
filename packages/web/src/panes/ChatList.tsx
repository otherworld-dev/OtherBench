import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { APP_NAME_MAX } from '@otherbench/core/domain/apps.js';
import { exportFilename } from '@otherbench/core/domain/export.js';
import { compareProjects, PROJECT_NAME_MAX, projectDisplayName, projectLookup, projectParentOf } from '@otherbench/core/domain/projects.js';
import type { App, Chat, Project } from '@otherbench/core/ports/store.js';
import { setAppOpen } from '../code/appOpen.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { FolderPlusIcon } from '../components/icons.js';
import { Menu } from '../components/Menu.js';
import { saveFile } from '../lib/saveFile.js';
import { toast } from '../lib/toasts.js';
import { useNow } from '../lib/useNow.js';
import { ApiError, api, type ChatPatchBody, type CreateChatBody } from '../state/api.js';
import { ALL_APPS_TAB_ID } from '../state/allAppsTab.js';
import { appTabId } from '../state/appTab.js';
import { setChatPinned } from '../state/chatActions.js';
import { chatStatus, groupStatusSummary, isOnCard, needsYouChats, useChatActivity, type ChatStatus } from '../state/chatStatus.js';
import { modeOfChat } from '../state/mode.js';
import { projectTabId } from '../state/projectTab.js';
import { NO_PROJECT_KEY, setGroupCollapsed, useCollapsedGroups } from '../state/sidebarGroups.js';
import { groupSortOf, setGroupSort, useGroupSorts } from '../state/sidebarSort.js';
import { schedulesDeletedLine, useScheduleCount } from '../views/schedules/useScheduleCount.js';
import { OverviewJumpList } from '../overview/OverviewJumpList.js';
import { useOtherBenchStore } from '../state/store.js';
import { AllAppsEntry } from './sidebar/AllAppsEntry.js';
import { ChatFilters } from './sidebar/ChatFilters.js';
import { ChatRow, type DropPosition, type MenuSource } from './sidebar/ChatRow.js';
import { focusLater, headingSelector, LIST_SELECTOR, neighbourHeadingSelector, ROW_PREFIX, rowSelector, type RowKind } from './sidebar/focus.js';
import { appMenuItems, chatMenuItems, groupSortItem, projectMenuItems } from './sidebar/menus.js';
import {
  AGE_BUCKET_LABELS,
  allGroups,
  bucketRuns,
  buildCodeSidebar,
  buildSidebar,
  capRows,
  GROUP_ROW_CAP,
  liveApps,
  moveProjectPatches,
  moveTarget,
  placeChatPatches,
  placeProjectPatches,
  projectSiblings,
  type CodeSidebarGroup,
  type SidebarGroup,
} from './sidebar/model.js';
import { ModeSwitch } from './sidebar/ModeSwitch.js';
import { PinDropZone } from './sidebar/PinDropZone.js';
import { ProjectGroup, type ProjectGroupProps } from './sidebar/ProjectGroup.js';
import { useShowArchived } from './sidebar/showArchived.js';
import { useSidebarSearch } from './sidebar/useSidebarSearch.js';
import { useTrayNewChat } from './sidebar/useTrayNewChat.js';

export { SHOW_ARCHIVED_STORAGE_KEY } from './sidebar/showArchived.js';

/** A sidebar error line: the server's own message when there is one. */
function errorText(err: unknown, action: string): string {
  return err instanceof ApiError ? `${action}: ${err.message}` : `${action} -- please try again.`;
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

/**
 * Left pane (spec 2026-10-03-projects-design §3): search, then Pinned, each
 * project, and No project, with "+ New chat" and "+ New project" at the
 * bottom. A pinned chat keeps its row in its group and gets a second one
 * under Pinned until unpinned (Deck d961). Search matches chat titles here
 * and message text through `GET /api/search?scope=chats`, and the chips under it keep only chats with
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
 * Only open apps are listed (plan 2026-11-04-open-apps), under an All apps
 * entry that opens the page holding every app, where apps are opened, filed in
 * folders and ordered. A heading's × (or its menu's Close app) closes an app,
 * with Undo in a toast; a closed app still shows while one of its chats is on a
 * card or running, saying so under its heading, and a search finds chats in
 * closed apps too.
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
  const overviewOpen = useOtherBenchStore((s) => s.overviewOpen);
  const openAppHome = useOtherBenchStore((s) => s.openAppHome);
  const openAllApps = useOtherBenchStore((s) => s.openAllApps);
  const openAppPage = useOtherBenchStore((s) => s.openAppPage);
  const upsertApp = useOtherBenchStore((s) => s.upsertApp);
  const removeApp = useOtherBenchStore((s) => s.removeApp);
  const codeMode = mode === 'code';
  const collapsedGroups = useCollapsedGroups();
  const groupSorts = useGroupSorts();
  const now = useNow(60_000);
  const activity = useChatActivity();

  const { query, runSearch, trimmedQuery, statusOnly, setStatusOnly, machineFilter, setMachine, searching, matches } = useSidebarSearch(
    chats,
    machines,
    activeChatId,
    activity,
    now
  );
  /** Groups opened past their cap with "Show N more", this session only. */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [noProjectMenu, setNoProjectMenu] = useState<{ x: number; y: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [rowDrop, setRowDrop] = useState<{ chatId: string; position: DropPosition } | null>(null);
  // The chat being dragged, while it is: with nothing pinned yet, a "Drop here to pin" target takes the search
  // box's place. Not a new section in the list, which would push every row down under the pointer mid-drag.
  const [draggingChatId, setDraggingChatId] = useState<string | null>(null);
  const [pinZoneActive, setPinZoneActive] = useState(false);
  // The project heading being dragged, and the sibling heading it's over: where a drop would place it.
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [projectDrop, setProjectDrop] = useState<{ projectId: string; position: DropPosition } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatMenu, setChatMenu] = useState<{ chatId: string; position: { x: number; y: number } } | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  // Which row the chat menu was opened from, for a chat with a row under Pinned or in Needs you as well as in its group.
  const [menuRow, setMenuRow] = useState<RowKind>('group');
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; position: { x: number; y: number } } | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [showArchived, toggleArchived] = useShowArchived();
  const [appMenu, setAppMenu] = useState<{ appId: string; position: { x: number; y: number } } | null>(null);
  const [renamingAppId, setRenamingAppId] = useState<string | null>(null);
  const [deletingAppId, setDeletingAppId] = useState<string | null>(null);

  // While searching every chat stays in its group, so a result is found where it lives.
  // In the order each chat came to need the user, as the server recorded it, so a reload keeps it (`needsYouChats`).
  const queue = useMemo(() => needsYouChats(chats, activity, now), [chats, activity, now]);
  const needsYou = useMemo(() => (searching ? [] : queue.filter((c) => modeOfChat(c) === mode)), [searching, queue, mode]);
  const needsYouIds = useMemo(() => new Set(needsYou.map((c) => c.id)), [needsYou]);
  // Its row in the group gets the tick too, so a chat can be ticked off where it is, searching or not.
  const queuedIds = useMemo(() => new Set(queue.map((c) => c.id)), [queue]);
  const sidebar = useMemo(() => buildSidebar(chats, projects, matches, (key) => groupSortOf(groupSorts, key)), [chats, projects, matches, groupSorts]);
  // A closed app still shows while one of its chats is on a card or running (plan 2026-11-04-open-apps).
  const live = useMemo(() => liveApps(chats, (c) => chatStatus(c, activity, now)), [chats, activity, now]);
  const codeSidebar = useMemo(() => buildCodeSidebar(chats, apps, appFolders, matches, live), [chats, apps, appFolders, matches, live]);
  const archived = codeMode ? codeSidebar.archived : sidebar.archived;
  const otherMode = codeMode ? codeSidebar.otherMode : sidebar.otherMode;
  const menuApp = appMenu ? (apps.find((a) => a.id === appMenu.appId) ?? null) : null;
  const deletingApp = deletingAppId ? (apps.find((a) => a.id === deletingAppId) ?? null) : null;
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
  // Deleting a chat or project deletes its schedules: its delete dialog says how many.
  const chatSchedulesLine = schedulesDeletedLine(useScheduleCount(deletingChatId ? { kind: 'chat', chatId: deletingChatId } : null));
  const projectSchedulesLine = schedulesDeletedLine(useScheduleCount(deletingProjectId ? { kind: 'project', projectId: deletingProjectId } : null));

  // The chat under an open menu vanished (deleted or archived from elsewhere): close the menu, keep focus in the list.
  // Closed in the render that finds it gone; the focus, a side effect, waits for the commit (bumped, never reset).
  const [menuGoneCount, setMenuGoneCount] = useState(0);
  if (chatMenu !== null && menuChat === null) {
    setChatMenu(null);
    setMenuGoneCount((n) => n + 1);
  }
  useEffect(() => {
    if (menuGoneCount > 0) focusLater(LIST_SELECTOR);
  }, [menuGoneCount]);

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
      useOtherBenchStore.getState().focusComposer(chat.id);
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
   * group. A pinned chat keeps its sortOrder, so its place under Pinned, and
   * shows in the group where that puts it. A no-op when it's already there.
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
    focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
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
   * filing it, or pinning it in its project or not, to match the section
   * (#823). Dropped under Pinned it is pinned; dropped in a group a pinned chat
   * stays pinned, since it shows in its group as well (Deck d961) and only
   * Unpin takes it out of Pinned. Usually one PATCH; a renumbered section
   * sends one per chat that changes.
   */
  async function placeChat(chatId: string, section: Section, beforeId: string | null): Promise<void> {
    const chat = useOtherBenchStore.getState().chats.find((c) => c.id === chatId);
    if (!chat || chat.archivedAt !== null) return;
    const patches = placeChatPatches(section.chats, chat, beforeId);
    const own = patches.find((p) => p.id === chatId);
    const body: ChatPatchBody = {
      ...(own ? { sortOrder: own.sortOrder } : {}),
      ...(section.pinned && !chat.pinned ? { pinned: true } : {}),
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
    focusLater(currentRowSelector(chatId), LIST_SELECTOR);
  }

  /** The chat that a drop `position` relative to row `targetId` lands above, skipping the dragged chat itself. */
  function beforeIdFor(section: Section, targetId: string, position: DropPosition, movingId: string): string | null {
    if (position === 'before') return targetId;
    const rest = section.chats.filter((c) => c.id !== movingId);
    return rest[rest.findIndex((c) => c.id === targetId) + 1]?.id ?? null;
  }

  /**
   * The section the sidebar shows `chat`'s row in, or null when it isn't shown in one: archived, or an app chat. A
   * pinned chat has two: Pinned for its row there (`kind` 'pinned'), else its group. Code mode
   * has no Pinned section and no ordering by hand (a pinned app chat leads its group), so an app chat is in none of
   * Chat mode's sections and its menu offers no Move up / Move down (spec 2026-10-20-code-tab-design, Goal 1).
   */
  function sectionOf(chat: Chat, kind: RowKind = rowKindOf(chat.id)): Section | null {
    if (chat.archivedAt !== null || chat.appId !== null || codeMode) return null;
    if (kind === 'pinned' && chat.pinned) return { chats: sidebar.pinned, pinned: true, projectPinned: false, projectId: null, recent: false };
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

  /**
   * Which of a chat's rows its menu and rename belong to: the one the menu was opened from while that row is still
   * shown, else the one in its group.
   */
  function rowKindOf(chatId: string): RowKind {
    if (menuRow === 'list' && needsYouIds.has(chatId)) return 'list';
    if (menuRow === 'pinned' && !codeMode && sidebar.pinned.some((c) => c.id === chatId)) return 'pinned';
    return 'group';
  }

  /**
   * The row to return focus to: the one the user was on (`kind`, by default the menu's), so focus doesn't scroll the
   * sidebar to the chat's other row. From under Pinned, the row in its group once that one is gone (unpinned).
   */
  function currentRowSelector(chatId: string, kind: RowKind = rowKindOf(chatId)): string {
    // Pinned sits above the groups, so a selector list finds the row under Pinned first while there is one.
    return kind === 'pinned' ? `${rowSelector(chatId, 'pinned')}, ${rowSelector(chatId, 'group')}` : rowSelector(chatId, kind);
  }

  /**
   * The row to focus once `chatId`'s row is gone: the next one in the list, else the previous one. Within Needs you
   * or Pinned when the user was there, as a row in a group further down would scroll the sidebar away from where they were.
   */
  function neighbourSelector(chatId: string): string {
    const kind = rowKindOf(chatId);
    const prefix = ROW_PREFIX[kind];
    const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`));
    const i = rows.findIndex((el) => el.getAttribute('data-testid') === `${prefix}${chatId}`);
    const neighbour = i === -1 ? undefined : (rows[i + 1] ?? rows[i - 1]);
    const id = neighbour?.getAttribute('data-testid')?.slice(prefix.length);
    return id ? rowSelector(id, kind) : LIST_SELECTOR;
  }

  function openChatMenu(chatId: string, position: { x: number; y: number }, source: MenuSource): void {
    setProjectMenu(null);
    setNoProjectMenu(null);
    setAppMenu(null);
    if (source === 'button' && chatMenu?.chatId === chatId) {
      setChatMenu(null);
      focusLater(currentRowSelector(chatId), LIST_SELECTOR);
      return;
    }
    setChatMenu({ chatId, position });
  }

  async function renameChat(chat: Chat, title: string): Promise<void> {
    setRenamingChatId(null);
    if (await patchChat(chat, { title }, "Couldn't rename the chat")) focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
  }

  /**
   * `row`: which row's pin button, when it was one (else the menu's row). `preventScroll` for the row's own pin
   * button: unpinning from under Pinned sends focus to the chat's row in its group, and following it there would
   * lose the user's place when unpinning several chats.
   */
  async function setPinned(chat: Chat, pinned: boolean, preventScroll = false, row?: RowKind): Promise<void> {
    setError(null);
    try {
      await setChatPinned(chat.id, pinned);
      focusLater(currentRowSelector(chat.id, row), LIST_SELECTOR, preventScroll ? { preventScroll: true } : undefined);
    } catch (err) {
      console.error(`[otherbench-web] failed to update chat ${chat.id}:`, err);
      setError(errorText(err, pinned ? "Couldn't pin the chat" : "Couldn't unpin the chat"));
    }
  }

  async function setProjectPinned(chat: Chat, pinned: boolean): Promise<void> {
    const action = pinned ? "Couldn't pin the chat in its project" : "Couldn't unpin the chat from its project";
    if (await patchChat(chat, { projectPinned: pinned }, action)) focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
  }

  async function setMemoryExcluded(chat: Chat, excluded: boolean): Promise<void> {
    const action = excluded ? "Couldn't stop this chat adding to project memory" : "Couldn't let this chat add to project memory";
    if (await patchChat(chat, { memoryExcluded: excluded }, action)) focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
  }

  async function exportChat(chat: Chat, format: 'markdown' | 'json'): Promise<void> {
    setError(null);
    try {
      await saveFile(await api.chats.export(chat.id, format), exportFilename(chat.title, format === 'json' ? 'json' : 'md'));
    } catch (err) {
      console.error(`[otherbench-web] failed to export chat ${chat.id}:`, err);
      setError(errorText(err, "Couldn't export the chat"));
    }
    focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
  }

  /** Hides the chat from the sidebar (spec §3: reuses `archivedAt`). */
  async function archiveChat(chat: Chat): Promise<void> {
    const next = neighbourSelector(chat.id);
    // eslint-disable-next-line react-hooks/purity -- runs from the menu's Archive, never in render; the compiler assumes chatMenuItems, called while rendering, may call the actions it is handed.
    const updated = await patchChat(chat, { archivedAt: Date.now() }, "Couldn't archive the chat");
    if (!updated) return;
    if (useOtherBenchStore.getState().activeChatId === chat.id) setActiveChatId(null);
    focusLater(next, LIST_SELECTOR);
  }

  async function unarchiveChat(chat: Chat): Promise<void> {
    if (await patchChat(chat, { archivedAt: null }, "Couldn't unarchive the chat")) focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
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

  /** Opens a capped group in full (focus goes to the first chat it revealed), or caps it again. */
  function setGroupExpanded(key: string, expanded: boolean, firstRevealedId?: string): void {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (expanded) next.add(key);
      else next.delete(key);
      return next;
    });
    if (firstRevealedId) focusLater(rowSelector(firstRevealedId, 'group'));
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

  /**
   * Closes an app (plan 2026-11-04-open-apps): it leaves the sidebar and nothing else changes, no chat archived and no
   * tab closed. The toast's Undo opens it again by sending `open: true` (`setAppOpen`), not by putting back the app as
   * it was, so a rename that synced in meanwhile stays.
   */
  async function closeApp(app: App): Promise<void> {
    const next = neighbourHeadingSelector(app.id);
    setError(null);
    try {
      await setAppOpen(app.id, false);
    } catch (err) {
      console.error(`[otherbench-web] failed to close app ${app.id}:`, err);
      setError(errorText(err, "Couldn't close the app"));
      focusLater(headingSelector(app.id), LIST_SELECTOR);
      return;
    }
    const name = useOtherBenchStore.getState().apps.find((a) => a.id === app.id)?.name ?? app.name;
    toast({ text: `Closed ${name}. It's still in All apps.`, tone: 'ok', action: { label: 'Undo', run: () => void reopenApp(app.id, name) } });
    // Still there when a live chat keeps it in the sidebar; else the next heading.
    focusLater(headingSelector(app.id), next);
  }

  /** Keep in sidebar, on a closed app the sidebar shows only for a live chat or a search: it opens the app again. */
  async function keepApp(app: App): Promise<void> {
    setError(null);
    try {
      await setAppOpen(app.id, true);
    } catch (err) {
      console.error(`[otherbench-web] failed to keep app ${app.id} in the sidebar:`, err);
      setError(errorText(err, "Couldn't keep the app in the sidebar"));
    }
    focusLater(headingSelector(app.id), LIST_SELECTOR);
  }

  /** The close toast's Undo. Says so in a toast of its own if it fails: the sidebar's error line may be long gone. */
  async function reopenApp(appId: string, name: string): Promise<void> {
    try {
      await setAppOpen(appId, true);
    } catch (err) {
      console.error(`[otherbench-web] failed to reopen app ${appId}:`, err);
      toast({ text: `Couldn't put ${name} back in the sidebar -- please try again.`, tone: 'error' });
    }
  }

  useTrayNewChat(createChat);

  function statusOf(chat: Chat): ChatStatus | null {
    return chatStatus(chat, activity, now);
  }

  /** A pinned chat's project, named after its parent when it's a sub-project. */
  function pinnedProjectName(projectId: string): string | undefined {
    const project = lookup(projectId);
    return project ? projectDisplayName(project, lookup) : undefined;
  }

  /** Every chat shown in a group and its sub-projects, for the heading's status. */
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
    return (
      <ProjectGroup
        key={group.key}
        groupKey={group.key}
        name={project?.name ?? 'No project'}
        count={group.total}
        empty={group.total === 0 && group.children.length === 0}
        collapsed={!searching && collapsedGroups.has(group.key)}
        statusSummary={groupStatusSummary(groupChats(group).map(statusOf))}
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
    return (
      <ProjectGroup
        key={group.key}
        groupKey={group.key}
        name={app?.name ?? 'Unknown app'}
        count={group.total}
        empty={false}
        collapsed={!searching && collapsedGroups.has(group.key)}
        statusSummary={groupStatusSummary(group.chats.map(statusOf))}
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
        note={group.shownBecause === 'card' ? 'Shown because a chat needs you' : group.shownBecause === 'running' ? 'Shown because a chat is running' : undefined}
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

  /**
   * The app-only props of a Code mode group heading. Its heading doesn't drag: apps are ordered and filed on the All
   * apps page. An open app's heading has a × that closes it; a closed one (shown because a chat is live, or found by a
   * search) has none.
   */
  function appGroupProps(app: App): Partial<ProjectGroupProps> {
    return {
      ...(app.open ? { onClose: () => void closeApp(app), closeLabel: `Close ${app.name}` } : {}),
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

  /** What a row in the Needs you list is filed under: its project, or its app. */
  function homeName(chat: Chat): string | undefined {
    if (chat.appId !== null) return apps.find((a) => a.id === chat.appId)?.name;
    return chat.projectId ? pinnedProjectName(chat.projectId) : undefined;
  }

  /** Ticks a chat off: nothing to do here until a newer reply lands. The server stamps it, never before the reply, whatever this device's clock says. */
  function tickOff(chat: Chat): void {
    void patchChat(chat, { dealtWithAt: true }, 'tick off the chat');
  }

  /** `muted`: dimmed, as archived rows are; by default every row outside a section is one (Chat mode's archived list). */
  function renderRow(chat: Chat, section: Section | null, muted = section === null, listed = false): JSX.Element {
    const kind: RowKind = listed ? 'list' : section?.pinned ? 'pinned' : 'group';
    // A chat can have up to three rows; its open menu and rename show on the one they came from.
    const current = kind === rowKindOf(chat.id);
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
        menuOpen={current && chatMenu?.chatId === chat.id}
        renaming={current && renamingChatId === chat.id}
        muted={muted}
        onTogglePin={chat.archivedAt === null ? () => void setPinned(chat, !chat.pinned, true, kind) : undefined}
        showPinMarker={!section?.pinned}
        projectPinMarker={section?.projectPinned === true}
        projectName={listed ? homeName(chat) : section?.pinned && chat.projectId ? pinnedProjectName(chat.projectId) : undefined}
        needsYou={listed}
        pinnedCopy={kind === 'pinned'}
        onTick={queuedIds.has(chat.id) && !isOnCard(statusOf(chat)) ? () => tickOff(chat) : undefined}
        now={now}
        onOpenMenu={(position, source) => {
          setMenuRow(kind);
          openChatMenu(chat.id, position, source);
        }}
        onRename={(title) => void renameChat(chat, title)}
        onRenameCancel={() => {
          setRenamingChatId(null);
          focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
        }}
      />
    );
  }

  return (
    <nav aria-label="Chats" data-chat-list="" tabIndex={-1} className="flex h-full w-full flex-col border-r border-[var(--border)] bg-[var(--bg-raised)]">
      <div className="border-b border-[var(--border)] p-2">
        <ModeSwitch />
        {!codeMode && draggingChatId !== null && sidebar.pinned.length === 0 && !searching ? (
          <PinDropZone
            active={pinZoneActive}
            onActiveChange={setPinZoneActive}
            onDragFinished={() => setDraggingChatId(null)}
            onPin={(chatId) => void placeChat(chatId, { chats: [], pinned: true, projectPinned: false, projectId: null, recent: false }, null)}
          />
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
        <ChatFilters statusOnly={statusOnly} setStatusOnly={setStatusOnly} machines={machines} machineFilter={machineFilter} setMachine={setMachine} />
      </div>

      {/* relative: the group headings' screen-reader text is absolutely positioned, and without a positioned
          ancestor here it was placed against the page, escaped this scroll area's clipping and made the whole
          window scroll once a group sat below the fold. */}
      <div className="relative flex-1 overflow-y-auto px-1.5 py-1" data-testid="chat-list-scroll">
        {overviewOpen ? (
          <OverviewJumpList />
        ) : (
          <>
          {codeMode && <AllAppsEntry active={activeChatId === ALL_APPS_TAB_ID} count={apps.length} onOpen={openAllApps} />}

          {needsYou.length > 0 && (
            <div className="mb-1.5" data-testid="group-needs-you">
              <h2 className="label-caps flex justify-between px-2 pb-1 text-[var(--warn)]">
                <span>Needs you</span>
                <span className="font-normal tabular-nums">{needsYou.length}</span>
              </h2>
              <ul>{needsYou.map((c) => renderRow(c, null, false, true))}</ul>
            </div>
          )}

          {!codeMode && sidebar.pinned.length > 0 && (
            <div className="mb-1.5" data-testid="group-pinned">
              <h2 className="label-caps px-2 pb-1 text-[var(--text-muted)]">Pinned</h2>
              <ul>{sidebar.pinned.map((c) => renderRow(c, { chats: sidebar.pinned, pinned: true, projectPinned: false, projectId: null, recent: false }))}</ul>
            </div>
          )}

          {searching &&
            (codeMode ? codeSidebar.groups.length === 0 : sidebar.pinned.length === 0 && sidebar.groups.length === 0) &&
            archived.length === 0 &&
            otherMode.length === 0 && (
            <p className="px-2 py-4 text-sm text-[var(--text-faint)]">{trimmedQuery === '' ? 'No chats match these filters.' : 'No chats match your search.'}</p>
          )}

          {codeMode && !searching && apps.length === 0 && codeSidebar.groups.length === 0 && (
            <p className="px-2 py-4 text-sm text-[var(--text-faint)]">No apps yet. An app is a repo folder; its chats show here, under it.</p>
          )}

          {codeMode && !searching && apps.length > 0 && !codeSidebar.groups.some((g) => g.app !== null) && (
            <p data-testid="no-open-apps" className="px-2 py-4 text-sm text-[var(--text-faint)]">
              No apps open. Pick one from{' '}
              <button type="button" onClick={openAllApps} className="underline hover:text-[var(--text)]">
                All apps
              </button>
              .
            </p>
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

      {/* An @container so the main button's words give way to a bare "+" in a narrow sidebar rather than wrap
          onto a second line; they stay in its accessible name. */}
      <div className={`@container flex items-stretch gap-1 border-t border-[var(--border)] p-2${wrapFooter ? ' flex-wrap' : ''}`}>
        {codeMode ? (
          // In Code mode a new chat starts from its app's "+ New chat" row, so the main button makes an app. Folders are
          // made on the All apps page.
          <button type="button" onClick={() => openAppPage({ mode: 'create' })} title="New app" className="btn btn-primary flex-1 whitespace-nowrap px-2 py-1.5">
            + <span className="@max-[14.125rem]:sr-only">New app</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void createChat()}
              // aria-disabled, not disabled: a disabled button drops keyboard focus while a chat is being created.
              aria-disabled={creating || profiles.length === 0 || undefined}
              title={profiles.length === 0 ? 'Create a profile before starting a chat.' : 'New chat'}
              className="btn btn-primary flex-1 whitespace-nowrap px-2 py-1.5"
            >
              + <span className="@max-[14.125rem]:sr-only">New chat</span>
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
            if (reason === 'dismiss') focusLater(currentRowSelector(menuChat.id), LIST_SELECTOR);
          }}
        />
      )}

      {deletingChat && (
        <ConfirmDialog
          title={`Delete '${deletingChat.title}'? This can't be undone.`}
          {...(chatSchedulesLine ? { message: chatSchedulesLine } : {})}
          confirmLabel="Delete"
          onConfirm={() => deleteChat(deletingChat.id)}
          onCancel={() => {
            setDeletingChatId(null);
            focusLater(currentRowSelector(deletingChat.id), LIST_SELECTOR);
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
            {
              rename: () => setRenamingAppId(menuApp.id),
              edit: () => openAppPage({ mode: 'edit', appId: menuApp.id, returnFocus: headingSelector(menuApp.id) }),
              close: () => void closeApp(menuApp),
              keep: () => void keepApp(menuApp),
              requestDelete: () => setDeletingAppId(menuApp.id),
            },
            menuApp.open
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

      {deletingProject && (
        <ConfirmDialog
          title={`Delete project '${deletingProject.name}'?`}
          message={[
            projects.some((p) => p.parentId === deletingProject.id)
              ? 'Its chats move to No project. Its sub-projects become top-level projects.'
              : 'Its chats move to No project.',
            projectSchedulesLine,
          ]
            .filter((line) => line !== null)
            .join(' ')}
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
