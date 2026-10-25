import { compareAppFolders, compareApps } from '@otherbench/core/domain/apps.js';
import { compareProjects, projectLookup, projectParentOf } from '@otherbench/core/domain/projects.js';
import type { App, AppFolder, Chat, Project } from '@otherbench/core/ports/store.js';
import { NO_PROJECT_KEY, UNKNOWN_APP_KEY } from '../../state/sidebarGroups.js';
import type { GroupSort } from '../../state/sidebarSort.js';

export interface SidebarGroup {
  /** The project's id, or `NO_PROJECT_KEY`. Also the group's collapse-state key. */
  key: string;
  /** Null for No project. */
  project: Project | null;
  /** `recent`: both lists below are ordered by last activity, not by hand. */
  sort: GroupSort;
  /**
   * Chats pinned in this project (`projectPinned`, spec 2026-10-11-sidebar-layout-design §5), shown first, in
   * sidebar order; only search matches while searching. Always empty for No project, where the flag means nothing.
   */
  pinnedChats: Chat[];
  /** The group's other unpinned chats in sidebar order (`sortOrder`, highest first); only search matches while searching. */
  chats: Chat[];
  /** Every unarchived chat in the group and its sub-projects, pinned ones included (they display under Pinned). */
  total: number;
  /**
   * Its sub-projects' groups, shown inside it after its pinned chats (spec 2026-10-15-sub-projects-design §4), in
   * `compareProjects` order; while searching, only those with a match. Always empty for a sub-project and No project.
   */
  children: SidebarGroup[];
}

/** Every group, each top-level one followed by its sub-projects: for finding a group or a chat's section by key. */
export function allGroups(model: SidebarModel): SidebarGroup[] {
  return model.groups.flatMap((g) => [g, ...g.children]);
}

/**
 * The projects that sit beside `projectId` in the sidebar, itself included, in display order: the top-level
 * projects, or its parent's sub-projects. What Move up / Move down reorder among.
 */
export function projectSiblings(projects: Project[], projectId: string): Project[] {
  const lookup = projectLookup(projects);
  const self = lookup(projectId);
  if (!self) return [];
  const parentId = projectParentOf(self, lookup)?.id ?? null;
  return [...projects].sort(compareProjects).filter((p) => (projectParentOf(p, lookup)?.id ?? null) === parentId);
}

export interface SidebarModel {
  pinned: Chat[];
  groups: SidebarGroup[];
  /** Archived chats (newest activity first; only search matches while searching), for the "Show archived" section. */
  archived: Chat[];
  /** While searching, Code mode's matching chats (see `otherModeMatches`); empty otherwise. */
  otherMode: Chat[];
}

/**
 * While searching, the matches that live in the other mode, archived ones
 * included, newest activity first; empty when not searching. Search is
 * scoped to the showing mode's lists, but opening an app chat "from anywhere,
 * such as search" switches to Code mode, and an ordinary chat to Chat mode
 * (spec 2026-10-20-code-tab-design, "Decisions Adam made"), so the sidebar
 * lists these in a trailing "In Code mode" / "In Chat mode" section.
 */
function otherModeMatches(chats: Chat[], matches: ReadonlySet<string> | null, inOtherMode: (c: Chat) => boolean): Chat[] {
  if (matches === null) return [];
  return chats.filter((c) => inOtherMode(c) && matches.has(c.id)).sort(byActivity);
}

const byActivity = (a: Chat, b: Chat): number => b.updatedAt - a.updatedAt;
const byId = (a: Chat, b: Chat): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Sidebar order (#823): `sortOrder`, highest first; activity, then id, only break ties. */
export const byOrder = (a: Chat, b: Chat): number => b.sortOrder - a.sortOrder || byActivity(a, b) || byId(a, b);
/** A `recent` group's order: last activity first; id breaks ties so the order is stable. */
const byRecent = (a: Chat, b: Chat): number => byActivity(a, b) || byId(a, b);

/** How many of a group's (unpinned-in-project) chats show before its "Show N more". */
export const GROUP_ROW_CAP = 10;

/**
 * The rows a capped group shows: the first `cap` of `chats`, plus `keepId`'s
 * chat wherever it falls past them (the active chat never hides behind
 * "Show more"). `hidden` is how many stay folded away.
 */
export function capRows(chats: Chat[], cap: number, keepId: string | null): { visible: Chat[]; hidden: number } {
  if (chats.length <= cap) return { visible: chats, hidden: 0 };
  const visible = chats.filter((c, i) => i < cap || c.id === keepId);
  return { visible, hidden: chats.length - visible.length };
}

/** A `recent` group's date headings, by last activity: since local midnight, then the 7 and 30 days before now. */
export type AgeBucket = 'today' | 'week' | 'month' | 'older';

export const AGE_BUCKET_LABELS: Record<AgeBucket, string> = {
  today: 'Today',
  week: 'Previous 7 days',
  month: 'Previous 30 days',
  older: 'Older',
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function ageBucket(at: number, now: number): AgeBucket {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (at >= midnight.getTime()) return 'today';
  if (at >= now - 7 * DAY_MS) return 'week';
  if (at >= now - 30 * DAY_MS) return 'month';
  return 'older';
}

/** Splits chats in last-activity order into consecutive runs by `ageBucket`, for the date headings between them. */
export function bucketRuns(chats: Chat[], now: number): { bucket: AgeBucket; chats: Chat[] }[] {
  const runs: { bucket: AgeBucket; chats: Chat[] }[] = [];
  for (const chat of chats) {
    const bucket = ageBucket(chat.updatedAt, now);
    const last = runs[runs.length - 1];
    if (last && last.bucket === bucket) last.chats.push(chat);
    else runs.push({ bucket, chats: [chat] });
  }
  return runs;
}

/** Every word of `query` (split on whitespace, any case) appears in `title`. False for a blank query. */
export function titleMatches(title: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const lower = title.toLowerCase();
  return words.every((w) => lower.includes(w));
}

/**
 * The sidebar's layout (spec 2026-10-03-projects-design §3): Pinned, each
 * project in `compareProjects` order (its own pinned chats first), then No project. Archived chats never
 * appear in those; they are returned separately in `archived`. Pinned chats
 * appear only under Pinned (but count towards their project). A chat whose
 * project isn't loaded falls under No project. While searching (`matches`
 * set), every list is filtered to those chat ids and groups left with no
 * match are dropped. `sortOf` says how each group orders its chats
 * (default: all `manual`; the app passes the saved sorts).
 *
 * App chats (`appId` set) are left out of every list, pinned and archived
 * included: a chat lives in one mode only (spec 2026-10-20-code-tab-design,
 * "Calls I made"), and Code mode's `buildCodeSidebar` lists them. One whose
 * app isn't loaded stays out too, in Code mode's Unknown app group, since it
 * is still an app chat and `modeOfChat` would send it to Code mode anyway.
 * While searching, the matching ones come back in `otherMode` only.
 */
export function buildSidebar(
  chats: Chat[],
  projects: Project[],
  matches: ReadonlySet<string> | null,
  sortOf: (key: string) => GroupSort = () => 'manual'
): SidebarModel {
  const own = chats.filter((c) => c.appId === null);
  const live = own.filter((c) => c.archivedAt === null);
  const known = new Set(projects.map((p) => p.id));
  const keyOf = (c: Chat): string => (c.projectId !== null && known.has(c.projectId) ? c.projectId : NO_PROJECT_KEY);
  const shown = (c: Chat): boolean => matches === null || matches.has(c.id);

  const ordered = [...projects].sort(compareProjects);
  const lookup = projectLookup(projects);
  const parentOf = (p: Project): string | null => projectParentOf(p, lookup)?.id ?? null;
  // While searching, a group stays when it or one of its sub-projects has a match.
  const hasMatch = (g: SidebarGroup): boolean => g.pinnedChats.length + g.chats.length > 0 || g.children.length > 0;

  const group = (key: string, project: Project | null): SidebarGroup => {
    const sort = sortOf(key);
    const members = live.filter((c) => keyOf(c) === key);
    const listed = members.filter((c) => !c.pinned && shown(c)).sort(sort === 'recent' ? byRecent : byOrder);
    // A chat whose project was deleted keeps the flag (the foreign key clears projectId only); in No project it means nothing.
    const pinnedHere = (c: Chat): boolean => project !== null && c.projectPinned;
    const children = project === null || parentOf(project) !== null ? [] : ordered.filter((p) => parentOf(p) === project.id).map((p) => group(p.id, p));
    const shownChildren = matches === null ? children : children.filter(hasMatch);
    return {
      key,
      project,
      sort,
      total: members.length + children.reduce((sum, c) => sum + c.total, 0),
      pinnedChats: listed.filter(pinnedHere),
      chats: listed.filter((c) => !pinnedHere(c)),
      children: shownChildren,
    };
  };
  const groups = [...ordered.filter((p) => parentOf(p) === null).map((p) => group(p.id, p)), group(NO_PROJECT_KEY, null)];

  return {
    pinned: live.filter((c) => c.pinned && shown(c)).sort(byOrder),
    groups: matches === null ? groups : groups.filter(hasMatch),
    archived: own.filter((c) => c.archivedAt !== null && shown(c)).sort(byActivity),
    otherMode: otherModeMatches(chats, matches, (c) => c.appId !== null),
  };
}

/** One app's group in Code mode's sidebar, or (`app` null) the Unknown app group. */
export interface CodeSidebarGroup {
  /** Null for the Unknown app group: chats whose `appId` names no loaded app. */
  app: App | null;
  /** The app's id, or `UNKNOWN_APP_KEY`. Also the group's collapse-state key. */
  key: string;
  /** Its unarchived chats, pinned ones first, then sidebar order (`byOrder`); only search matches while searching. */
  chats: Chat[];
  /** Every unarchived chat in the group, matched or not. */
  total: number;
}

/** The collapse-state key of an app folder's heading (per-machine collapsed-groups store). */
export const folderKey = (id: string): string => `folder:${id}`;

/** One app folder in Code mode's sidebar, with its apps' groups. */
export interface CodeSidebarFolder {
  folder: AppFolder;
  /** `folderKey(folder.id)`: also the heading's collapse-state key. */
  key: string;
  /** Its apps in `compareApps` order; while searching, only those with a match unless the folder's name matched. */
  groups: CodeSidebarGroup[];
  /** The folder's app count, matched or not. */
  total: number;
}

export interface CodeSidebarModel {
  /** Folders in `compareAppFolders` order; while searching, only those with a match (or whose name matches). */
  folders: CodeSidebarFolder[];
  /**
   * The top-level apps (no folder, or a folder that isn't loaded) in `compareApps` order (while searching, only
   * those with a match), then Unknown app when it has chats.
   */
  groups: CodeSidebarGroup[];
  /** Archived app chats, newest activity first; only search matches while searching. */
  archived: Chat[];
  /** While searching, Chat mode's matching chats (see `otherModeMatches`); empty otherwise. */
  otherMode: Chat[];
}

/**
 * Code mode's sidebar (spec 2026-10-20-code-tab-design, Goal 1): each app with
 * its chats, and nothing else, since chats outside an app live in Chat mode
 * only. A chat whose app isn't loaded (a synced row, or an app deleted
 * elsewhere before its chats' updates arrive) goes in a trailing Unknown app
 * group rather than vanishing. There is no Pinned section here: a pinned app
 * chat just leads its own group. Archived chats are kept out of the groups and
 * returned in `archived`. While searching (`matches` set) every list is
 * filtered to those ids and groups left with no match are dropped; otherwise
 * an app with no chats still shows, so it can be opened and given one. While
 * searching, matching chats outside an app come back in `otherMode`.
 *
 * Apps sit in folders (plan 2026-10-25-app-folders): `folders` holds each loaded folder with its apps' groups, and
 * `groups` the top-level ones. While searching, a folder whose name matches `query` shows all its apps, each with
 * all its chats; any other folder shows only the app groups with a match and is dropped when it has none. Without a
 * search every folder shows, empty ones too.
 */
export function buildCodeSidebar(chats: Chat[], apps: App[], folders: AppFolder[], matches: ReadonlySet<string> | null, query = ''): CodeSidebarModel {
  const appChats = chats.filter((c) => c.appId !== null);
  const live = appChats.filter((c) => c.archivedAt === null);
  const known = new Set(apps.map((a) => a.id));
  const keyOf = (c: Chat): string => (c.appId !== null && known.has(c.appId) ? c.appId : UNKNOWN_APP_KEY);
  const shown = (c: Chat): boolean => matches === null || matches.has(c.id);
  const pinnedFirst = (a: Chat, b: Chat): number => Number(b.pinned) - Number(a.pinned) || byOrder(a, b);

  const group = (key: string, app: App | null, all = false): CodeSidebarGroup => {
    const members = live.filter((c) => keyOf(c) === key);
    return { app, key, chats: (all ? members : members.filter(shown)).sort(pinnedFirst), total: members.length };
  };
  const knownFolders = new Set(folders.map((f) => f.id));
  const sortedApps = [...apps].sort(compareApps);
  const groups = sortedApps.filter((a) => a.folderId === null || !knownFolders.has(a.folderId)).map((a) => group(a.id, a));
  const unknown = group(UNKNOWN_APP_KEY, null);
  if (unknown.total > 0) groups.push(unknown);

  const folderModels = [...folders].sort(compareAppFolders).flatMap((folder): CodeSidebarFolder[] => {
    const members = sortedApps.filter((a) => a.folderId === folder.id);
    // A matching folder name keeps every app and chat in view, and the folder itself even when it's empty.
    const nameHit = matches !== null && titleMatches(folder.name, query);
    const folderGroups = members.map((a) => group(a.id, a, nameHit)).filter((g) => matches === null || nameHit || g.chats.length > 0);
    if (matches !== null && !nameHit && folderGroups.length === 0) return [];
    return [{ folder, key: folderKey(folder.id), groups: folderGroups, total: members.length }];
  });

  return {
    folders: folderModels,
    // Unknown app shows only with chats; while searching, any group only with a match.
    groups: groups.filter((g) => (matches === null ? g.app !== null || g.total > 0 : g.chats.length > 0)),
    archived: appChats.filter((c) => c.archivedAt !== null && shown(c)).sort(byActivity),
    otherMode: otherModeMatches(chats, matches, (c) => c.appId === null),
  };
}

/**
 * The `sortOrder` PATCHes that move project `id` one place up (-1) or down
 * (+1) among `projects` (its siblings: see `projectSiblings`). Renumbers the whole list 0..n-1, so projects that
 * share a sortOrder can't turn a move into a no-op, and returns only the
 * projects whose sortOrder actually changes, in display order. Empty at
 * either end or for an unknown id.
 */
export function moveProjectPatches(projects: Project[], id: string, dir: -1 | 1): { id: string; sortOrder: number }[] {
  return moveOrderPatches(projects, compareProjects, id, dir);
}

/** As `moveProjectPatches`, for apps in the Code sidebar (in `compareApps` order). Pass `appSiblings(...)`, not every app. */
export function moveAppPatches(apps: App[], id: string, dir: -1 | 1): { id: string; sortOrder: number }[] {
  return moveOrderPatches(apps, compareApps, id, dir);
}

/** As `moveProjectPatches`, for folders in the Code sidebar (in `compareAppFolders` order). */
export function moveFolderPatches(folders: AppFolder[], id: string, dir: -1 | 1): { id: string; sortOrder: number }[] {
  return moveOrderPatches(folders, compareAppFolders, id, dir);
}

/**
 * The apps that sit beside `appId` in the Code sidebar, itself included, in `compareApps` order: those in its
 * folder, or the top-level ones (no folder, or one that isn't loaded). What Move up / Move down and drops reorder among.
 */
export function appSiblings(apps: App[], appId: string, folders: AppFolder[]): App[] {
  const self = apps.find((a) => a.id === appId);
  if (!self) return [];
  const known = new Set(folders.map((f) => f.id));
  const home = (a: App): string | null => (a.folderId !== null && known.has(a.folderId) ? a.folderId : null);
  return apps.filter((a) => home(a) === home(self)).sort(compareApps);
}

/**
 * The PATCHes that file app `appId` in a group, a loaded folder or (null) the top level, just above `beforeId`
 * (null = last). Renumbers only that group 0..n-1 and returns just the apps that change, in display order; the moved
 * app's entry carries `folderId`. Empty for an unknown app or folder, or a `beforeId` that isn't in the group.
 */
export function fileAppPatches(
  apps: App[],
  folders: AppFolder[],
  appId: string,
  folderId: string | null,
  beforeId: string | null
): { id: string; folderId?: string | null; sortOrder: number }[] {
  const moving = apps.find((a) => a.id === appId);
  if (!moving) return [];
  const known = new Set(folders.map((f) => f.id));
  if (folderId !== null && !known.has(folderId)) return [];
  const home = (a: App): string | null => (a.folderId !== null && known.has(a.folderId) ? a.folderId : null);
  const rest = apps.filter((a) => a.id !== appId && home(a) === folderId).sort(compareApps);
  const at = beforeId === null ? rest.length : rest.findIndex((a) => a.id === beforeId);
  if (at === -1) return [];
  const ordered = [...rest.slice(0, at), moving, ...rest.slice(at)];
  return ordered.flatMap((a, sortOrder) => {
    if (a.id === appId) return a.folderId === folderId && a.sortOrder === sortOrder ? [] : [{ id: a.id, folderId, sortOrder }];
    return a.sortOrder === sortOrder ? [] : [{ id: a.id, sortOrder }];
  });
}

interface Ordered {
  id: string;
  sortOrder: number;
}

function renumbered<T extends Ordered>(ordered: T[]): { id: string; sortOrder: number }[] {
  return ordered.flatMap((p, index) => (p.sortOrder === index ? [] : [{ id: p.id, sortOrder: index }]));
}

function moveOrderPatches<T extends Ordered>(items: T[], compare: (a: T, b: T) => number, id: string, dir: -1 | 1): { id: string; sortOrder: number }[] {
  const ordered = [...items].sort(compare);
  const i = ordered.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= ordered.length) return [];
  const moving = ordered[i]!;
  ordered[i] = ordered[j]!;
  ordered[j] = moving;
  return renumbered(ordered);
}

/**
 * The `sortOrder` PATCHes that put project `movingId` just above `beforeId`
 * (null = the end) among `siblings` (see `projectSiblings`), for dragging a
 * heading. Renumbers the siblings 0..n-1 in their new order and returns only
 * the projects whose sortOrder changes, in display order. Empty when the
 * project or `beforeId` isn't among them.
 */
export function placeProjectPatches(siblings: Project[], movingId: string, beforeId: string | null): { id: string; sortOrder: number }[] {
  return placeOrderPatches(siblings, compareProjects, movingId, beforeId);
}

/** As `placeProjectPatches`, for dragging an app's heading in the Code sidebar. Pass `appSiblings(...)`, not every app. */
export function placeAppPatches(apps: App[], movingId: string, beforeId: string | null): { id: string; sortOrder: number }[] {
  return placeOrderPatches(apps, compareApps, movingId, beforeId);
}

/** As `placeProjectPatches`, for dragging a folder's heading in the Code sidebar. */
export function placeFolderPatches(folders: AppFolder[], movingId: string, beforeId: string | null): { id: string; sortOrder: number }[] {
  return placeOrderPatches(folders, compareAppFolders, movingId, beforeId);
}

function placeOrderPatches<T extends Ordered>(items: T[], compare: (a: T, b: T) => number, movingId: string, beforeId: string | null): { id: string; sortOrder: number }[] {
  const ordered = [...items].sort(compare);
  const moving = ordered.find((p) => p.id === movingId);
  if (!moving) return [];
  const rest = ordered.filter((p) => p.id !== movingId);
  const at = beforeId === null ? rest.length : rest.findIndex((p) => p.id === beforeId);
  if (at === -1) return [];
  return renumbered([...rest.slice(0, at), moving, ...rest.slice(at)]);
}

/** Gap below which a new sortOrder can't sit strictly between two neighbours, so the section is renumbered. */
const MIN_GAP = 1e-6;

/**
 * The `sortOrder` PATCHes that place `moving` in `section` (its chats in
 * display order, highest sortOrder first) just above `beforeId`, or at the
 * bottom when `beforeId` is null (#823). `moving` may come from another
 * section. Normally one patch: the moving chat takes a value between its new
 * neighbours (one above the top, one below the bottom). Only when the
 * neighbours are too close to fit a value between them is the whole section
 * renumbered, returning just the chats whose sortOrder changes. Empty when
 * the chat is already there, or `beforeId` isn't in the section.
 */
export function placeChatPatches(section: Chat[], moving: Chat, beforeId: string | null): { id: string; sortOrder: number }[] {
  const rest = section.filter((c) => c.id !== moving.id);
  const at = beforeId === null ? rest.length : rest.findIndex((c) => c.id === beforeId);
  if (at === -1) return [];
  const above = rest[at - 1];
  const below = rest[at];
  const current = section.findIndex((c) => c.id === moving.id);
  if (current !== -1 && section[current - 1] === above && section[current + 1] === below) return [];

  let value: number;
  if (above && below) value = (above.sortOrder + below.sortOrder) / 2;
  else if (below) value = below.sortOrder + 1;
  else if (above) value = above.sortOrder - 1;
  else value = moving.sortOrder;
  const fits = (!above || above.sortOrder - value > MIN_GAP) && (!below || value - below.sortOrder > MIN_GAP);
  if (fits) return [{ id: moving.id, sortOrder: value }];

  const ordered = [...rest.slice(0, at), moving, ...rest.slice(at)];
  return ordered.flatMap((c, i) => {
    const sortOrder = ordered.length - i;
    return c.sortOrder === sortOrder && c.id !== moving.id ? [] : [{ id: c.id, sortOrder }];
  });
}

/** Where to place `chatId` to move it one place up (-1) or down (+1) in `section`: above `beforeId` (null = the bottom). Undefined at either end. */
export function moveTarget(section: Chat[], chatId: string, dir: -1 | 1): { beforeId: string | null } | undefined {
  const i = section.findIndex((c) => c.id === chatId);
  if (i === -1) return undefined;
  if (dir === -1) return i === 0 ? undefined : { beforeId: section[i - 1]!.id };
  if (i >= section.length - 1) return undefined;
  return { beforeId: section[i + 2]?.id ?? null };
}
