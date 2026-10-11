import { compareProjects } from '@grunt/core/domain/projects.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { NO_PROJECT_KEY } from '../../state/sidebarGroups.js';

export interface SidebarGroup {
  /** The project's id, or `NO_PROJECT_KEY`. Also the group's collapse-state key. */
  key: string;
  /** Null for No project. */
  project: Project | null;
  /**
   * Chats pinned in this project (`projectPinned`, spec 2026-10-11-sidebar-layout-design §5), shown first, in
   * sidebar order; only search matches while searching. Always empty for No project, where the flag means nothing.
   */
  pinnedChats: Chat[];
  /** The group's other unpinned chats in sidebar order (`sortOrder`, highest first); only search matches while searching. */
  chats: Chat[];
  /** Every unarchived chat in the group, pinned ones included (they display under Pinned). */
  total: number;
}

export interface SidebarModel {
  pinned: Chat[];
  groups: SidebarGroup[];
  /** Archived chats (newest activity first; only search matches while searching), for the "Show archived" section. */
  archived: Chat[];
}

const byActivity = (a: Chat, b: Chat): number => b.updatedAt - a.updatedAt;
/** Sidebar order (#823): `sortOrder`, highest first; activity, then id, only break ties. */
export const byOrder = (a: Chat, b: Chat): number => b.sortOrder - a.sortOrder || byActivity(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The sidebar's layout (spec 2026-10-03-projects-design §3): Pinned, each
 * project in `compareProjects` order (its own pinned chats first), then No project. Archived chats never
 * appear in those; they are returned separately in `archived`. Pinned chats
 * appear only under Pinned (but count towards their project). A chat whose
 * project isn't loaded falls under No project. While searching (`matches`
 * set), every list is filtered to those chat ids and groups left with no
 * match are dropped.
 */
export function buildSidebar(chats: Chat[], projects: Project[], matches: ReadonlySet<string> | null): SidebarModel {
  const live = chats.filter((c) => c.archivedAt === null);
  const known = new Set(projects.map((p) => p.id));
  const keyOf = (c: Chat): string => (c.projectId !== null && known.has(c.projectId) ? c.projectId : NO_PROJECT_KEY);
  const shown = (c: Chat): boolean => matches === null || matches.has(c.id);

  const slots: { key: string; project: Project | null }[] = [
    ...[...projects].sort(compareProjects).map((p) => ({ key: p.id, project: p })),
    { key: NO_PROJECT_KEY, project: null },
  ];
  const groups = slots.map(({ key, project }) => {
    const members = live.filter((c) => keyOf(c) === key);
    const listed = members.filter((c) => !c.pinned && shown(c)).sort(byOrder);
    // A chat whose project was deleted keeps the flag (the foreign key clears projectId only); in No project it means nothing.
    const pinnedHere = (c: Chat): boolean => project !== null && c.projectPinned;
    return { key, project, total: members.length, pinnedChats: listed.filter(pinnedHere), chats: listed.filter((c) => !pinnedHere(c)) };
  });

  return {
    pinned: live.filter((c) => c.pinned && shown(c)).sort(byOrder),
    groups: matches === null ? groups : groups.filter((g) => g.pinnedChats.length + g.chats.length > 0),
    archived: chats.filter((c) => c.archivedAt !== null && shown(c)).sort(byActivity),
  };
}

/**
 * The `sortOrder` PATCHes that move project `id` one place up (-1) or down
 * (+1) in display order. Renumbers the whole list 0..n-1, so projects that
 * share a sortOrder can't turn a move into a no-op, and returns only the
 * projects whose sortOrder actually changes, in display order. Empty at
 * either end or for an unknown id.
 */
export function moveProjectPatches(projects: Project[], id: string, dir: -1 | 1): { id: string; sortOrder: number }[] {
  const ordered = [...projects].sort(compareProjects);
  const i = ordered.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= ordered.length) return [];
  const moving = ordered[i]!;
  ordered[i] = ordered[j]!;
  ordered[j] = moving;
  return ordered.flatMap((p, index) => (p.sortOrder === index ? [] : [{ id: p.id, sortOrder: index }]));
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
