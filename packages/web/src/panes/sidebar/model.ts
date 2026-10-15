import { compareProjects } from '@grunt/core/domain/projects.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { NO_PROJECT_KEY } from '../../state/sidebarGroups.js';
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
 */
export function buildSidebar(
  chats: Chat[],
  projects: Project[],
  matches: ReadonlySet<string> | null,
  sortOf: (key: string) => GroupSort = () => 'manual'
): SidebarModel {
  const live = chats.filter((c) => c.archivedAt === null);
  const known = new Set(projects.map((p) => p.id));
  const keyOf = (c: Chat): string => (c.projectId !== null && known.has(c.projectId) ? c.projectId : NO_PROJECT_KEY);
  const shown = (c: Chat): boolean => matches === null || matches.has(c.id);

  const slots: { key: string; project: Project | null }[] = [
    ...[...projects].sort(compareProjects).map((p) => ({ key: p.id, project: p })),
    { key: NO_PROJECT_KEY, project: null },
  ];
  const groups = slots.map(({ key, project }) => {
    const sort = sortOf(key);
    const members = live.filter((c) => keyOf(c) === key);
    const listed = members.filter((c) => !c.pinned && shown(c)).sort(sort === 'recent' ? byRecent : byOrder);
    // A chat whose project was deleted keeps the flag (the foreign key clears projectId only); in No project it means nothing.
    const pinnedHere = (c: Chat): boolean => project !== null && c.projectPinned;
    return { key, project, sort, total: members.length, pinnedChats: listed.filter(pinnedHere), chats: listed.filter((c) => !pinnedHere(c)) };
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
