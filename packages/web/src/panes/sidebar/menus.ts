import { compareApps } from '@otherbench/core/domain/apps.js';
import { projectLookup, projectParentOf } from '@otherbench/core/domain/projects.js';
import type { App, AppFolder, Chat, Project } from '@otherbench/core/ports/store.js';
import type { MenuItem } from '../../components/Menu.js';
import { NO_PROJECT_KEY } from '../../state/sidebarGroups.js';
import type { GroupSort } from '../../state/sidebarSort.js';

export interface ChatMenuHandlers {
  /** Opens the chat as a tab (or goes to its tab) (#824). */
  openInTab(): void;
  rename(): void;
  /** Sets the pin state the menu item asked for (the opposite of the state the menu was built with). */
  setPinned(pinned: boolean): void;
  /** Pins the chat at the top of its own project, or unpins it there (the opposite of the state the menu was built with). */
  setProjectPinned(pinned: boolean): void;
  /** One place up (-1) or down (+1) within its sidebar section (#823). */
  reorder(dir: -1 | 1): void;
  moveTo(projectId: string | null): void;
  /** Makes a new project named after the chat and moves the chat into it. */
  moveToNewProject(): void;
  /** Files the chat under an app, which sets its folder and profile from the app (spec 2026-10-20-code-tab-design, Goal 8). */
  moveToApp(appId: string): void;
  /** Takes an app chat out of its app, back to Chat mode's No project; its folder stays. */
  moveOutOfApp(): void;
  /** Downloads the chat (#820). */
  exportAs(format: 'markdown' | 'json'): void;
  /** Opens the Scheduled overlay's editor for a new schedule on this chat. */
  schedule(): void;
  /** Sets "Don't add to project memory" to the given state (the opposite of the chat's state when the menu was built). */
  setMemoryExcluded(excluded: boolean): void;
  archive(): void;
  unarchive(): void;
  requestDelete(): void;
}

/**
 * The chat row menu (spec §3 "Chat context menu", plus project memory's toggle). `orderedProjects` must be
 * in display order, each sub-project after its parent, where it is listed indented. A chat whose project isn't in the list counts as being in
 * No project, matching where the sidebar shows it. An archived chat gets
 * "Unarchive" in place of "Archive" (controller ruling R2). `position` is the
 * chat's place in its sidebar section; without it (archived, or while
 * searching) there is no Move up / Move down.
 *
 * `apps` adds "Move to app…" beside "Move to project…" (spec 2026-10-20-code-tab-design, Goal 8), left out while
 * there are none. An app chat also gets "Move out of app", and in Move to project… nothing is checked (it isn't in
 * No project) and No project does the same as Move out of app: a null `projectId` alone wouldn't take it out of the
 * app, while a real project does (the server clears `appId`).
 */
export function chatMenuItems(
  chat: Chat,
  orderedProjects: Project[],
  h: ChatMenuHandlers,
  position: { index: number; count: number } | null = null,
  isTab = false,
  apps: App[] = []
): MenuItem[] {
  const inApp = chat.appId !== null;
  const inListedProject = chat.projectId !== null && orderedProjects.some((p) => p.id === chat.projectId);
  const lookup = projectLookup(orderedProjects);
  const archived = chat.archivedAt !== null;
  // Memory: every chat feeds the global note, and a chat in a project its project's note too
  // (spec 2026-10-08-global-memory-design); one switch covers both.
  const memory: MenuItem[] = [
    {
      id: 'memory',
      label: chat.memoryExcluded ? 'Add to memory' : "Don't add to memory",
      onSelect: () => h.setMemoryExcluded(!chat.memoryExcluded),
    },
  ];
  return [
    { id: 'tab', label: isTab ? 'Go to tab' : 'Open in new tab', onSelect: h.openInTab },
    { id: 'rename', label: 'Rename', onSelect: h.rename },
    ...(archived ? [] : [{ id: 'pin', label: chat.pinned ? 'Unpin' : 'Pin', onSelect: () => h.setPinned(!chat.pinned) }]),
    ...(archived || !inListedProject
      ? []
      : [{ id: 'project-pin', label: chat.projectPinned ? 'Unpin from project' : 'Pin in project', onSelect: () => h.setProjectPinned(!chat.projectPinned) }]),
    ...(position
      ? [
          { id: 'up', label: 'Move up', disabled: position.index <= 0, onSelect: () => h.reorder(-1) },
          { id: 'down', label: 'Move down', disabled: position.index >= position.count - 1, onSelect: () => h.reorder(1) },
        ]
      : []),
    {
      id: 'move',
      label: 'Move to project…',
      submenu: [
        ...orderedProjects.map((p) => ({
          id: p.id,
          label: p.name,
          checked: chat.projectId === p.id,
          ...(projectParentOf(p, lookup) ? { indent: true } : {}),
          onSelect: () => h.moveTo(p.id),
        })),
        inApp
          ? { id: NO_PROJECT_KEY, label: 'No project', checked: false, onSelect: h.moveOutOfApp }
          : { id: NO_PROJECT_KEY, label: 'No project', checked: !inListedProject, onSelect: () => h.moveTo(null) },
        { id: 'new-project', label: 'New project…', onSelect: h.moveToNewProject },
      ],
    },
    ...(apps.length === 0
      ? []
      : [
          {
            id: 'move-app',
            label: 'Move to app…',
            submenu: [...apps].sort(compareApps).map((a) => ({ id: a.id, label: a.name, checked: chat.appId === a.id, onSelect: () => h.moveToApp(a.id) })),
          },
        ]),
    ...(inApp ? [{ id: 'move-out-app', label: 'Move out of app', onSelect: h.moveOutOfApp }] : []),
    ...memory,
    ...(archived ? [] : [{ id: 'schedule', label: 'Schedule…', onSelect: h.schedule }]),
    {
      id: 'export',
      label: 'Export…',
      submenu: [
        { id: 'markdown', label: 'Markdown (shown conversation)', onSelect: () => h.exportAs('markdown') },
        { id: 'json', label: 'JSON (every branch)', onSelect: () => h.exportAs('json') },
      ],
    },
    archived
      ? { id: 'unarchive', label: 'Unarchive', onSelect: h.unarchive }
      : { id: 'archive', label: 'Archive', onSelect: h.archive },
    { id: 'delete', label: 'Delete…', danger: true, onSelect: h.requestDelete },
  ];
}

export interface AppMenuHandlers {
  rename(): void;
  /** Opens the app form on this app. */
  edit(): void;
  /** Moves the app one place up (-1) or down (+1) among its siblings in the Code sidebar. */
  move(dir: -1 | 1): void;
  /** Files the app last in a folder, or (null) at the top level. */
  moveToFolder(folderId: string | null): void;
  requestDelete(): void;
}

/**
 * An app heading's ⋯ menu in Code mode (spec 2026-10-20-code-tab-design, "Creating an app"): rename, edit, move, delete.
 * `index` and `count`: the app's place among its siblings (its folder's apps, or the top level), for Move up / Move down.
 *
 * `folders` (in sidebar order) adds "Move to folder…" after Edit… (plan 2026-10-25-app-folders): No folder, then each
 * folder, with `folderId` (the app's loaded folder, or null) checked. Left out while there are no folders.
 */
export function appMenuItems(index: number, count: number, h: AppMenuHandlers, folders: AppFolder[] = [], folderId: string | null = null): MenuItem[] {
  return [
    { id: 'rename', label: 'Rename', onSelect: h.rename },
    { id: 'edit', label: 'Edit…', onSelect: h.edit },
    ...(folders.length === 0
      ? []
      : [
          {
            id: 'move-folder',
            label: 'Move to folder…',
            submenu: [
              { id: 'no-folder', label: 'No folder', checked: folderId === null, onSelect: () => h.moveToFolder(null) },
              ...folders.map((f) => ({ id: f.id, label: f.name, checked: folderId === f.id, onSelect: () => h.moveToFolder(f.id) })),
            ],
          },
        ]),
    { id: 'up', label: 'Move up', disabled: index <= 0, onSelect: () => h.move(-1) },
    { id: 'down', label: 'Move down', disabled: index >= count - 1, onSelect: () => h.move(1) },
    { id: 'delete', label: 'Delete…', danger: true, onSelect: h.requestDelete },
  ];
}

export interface FolderMenuHandlers {
  rename(): void;
  /** Moves the folder one place up (-1) or down (+1) among the folders. */
  move(dir: -1 | 1): void;
  requestDelete(): void;
}

/** An app folder heading's ⋯ menu in Code mode (plan 2026-10-25-app-folders). `index` of `count`: its place among the folders. */
export function folderMenuItems(index: number, count: number, h: FolderMenuHandlers): MenuItem[] {
  return [
    { id: 'rename', label: 'Rename', onSelect: h.rename },
    { id: 'up', label: 'Move up', disabled: index <= 0, onSelect: () => h.move(-1) },
    { id: 'down', label: 'Move down', disabled: index >= count - 1, onSelect: () => h.move(1) },
    { id: 'delete', label: 'Delete…', danger: true, onSelect: h.requestDelete },
  ];
}

export interface ProjectMenuHandlers {
  rename(): void;
  /** Opens the project page for this project. */
  settings(): void;
  /** Opens the Scheduled overlay's editor for a new schedule that makes chats in this project. */
  schedule(): void;
  move(dir: -1 | 1): void;
  /** Sets the group's sort to the given one (the opposite of the sort the menu was built with). */
  setSort(sort: GroupSort): void;
  /** Opens the project page to create a sub-project of this one. */
  newSubProject(): void;
  /** Puts the project under a top-level project, or (null) back at the top level. */
  moveUnder(parentId: string | null): void;
  requestDelete(): void;
}

/**
 * Where a project sits (spec 2026-10-15-sub-projects-design §5): `parentId` is its effective parent,
 * `candidates` the top-level projects it could go under (itself left out), in display order, and
 * `hasChildren` whether it has sub-projects (then it can't go under another, and Move under… is left out).
 */
export interface ProjectNesting {
  parentId: string | null;
  candidates: Project[];
  hasChildren: boolean;
}

/** The item that switches a group between hand order and last-activity order; No project's menu is only this. */
export function groupSortItem(sort: GroupSort, setSort: (sort: GroupSort) => void): MenuItem {
  return sort === 'recent'
    ? { id: 'sort', label: 'Sort manually', onSelect: () => setSort('manual') }
    : { id: 'sort', label: 'Sort by recent activity', onSelect: () => setSort('recent') };
}

/**
 * A project heading's ⋯ menu (spec §3). `index` of `count` is its position among its siblings; Move up/down
 * disable at the ends. A top-level project offers New sub-project…; any project without sub-projects offers
 * Move under….
 */
export function projectMenuItems(index: number, count: number, sort: GroupSort, h: ProjectMenuHandlers, nesting: ProjectNesting): MenuItem[] {
  const moveUnder: MenuItem[] = nesting.hasChildren
    ? []
    : [
        {
          id: 'move-under',
          label: 'Move under…',
          submenu: [
            { id: 'top-level', label: 'Top level', checked: nesting.parentId === null, onSelect: () => h.moveUnder(null) },
            ...nesting.candidates.map((p) => ({ id: p.id, label: p.name, checked: nesting.parentId === p.id, onSelect: () => h.moveUnder(p.id) })),
          ],
        },
      ];
  return [
    { id: 'rename', label: 'Rename', onSelect: h.rename },
    { id: 'settings', label: 'Project settings…', onSelect: h.settings },
    ...(nesting.parentId === null ? [{ id: 'new-sub', label: 'New sub-project…', onSelect: h.newSubProject }] : []),
    { id: 'schedule', label: 'Schedule…', onSelect: h.schedule },
    groupSortItem(sort, h.setSort),
    ...moveUnder,
    { id: 'up', label: 'Move up', disabled: index <= 0, onSelect: () => h.move(-1) },
    { id: 'down', label: 'Move down', disabled: index >= count - 1, onSelect: () => h.move(1) },
    { id: 'delete', label: 'Delete…', danger: true, onSelect: h.requestDelete },
  ];
}
