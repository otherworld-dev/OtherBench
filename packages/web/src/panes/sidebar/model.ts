import { compareProjects } from '@grunt/core/domain/projects.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { NO_PROJECT_KEY } from '../../state/sidebarGroups.js';

export interface SidebarGroup {
  /** The project's id, or `NO_PROJECT_KEY`. Also the group's collapse-state key. */
  key: string;
  /** Null for No project. */
  project: Project | null;
  /** The group's unpinned chats, newest activity first; only search matches while searching. */
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

/**
 * The sidebar's layout (spec 2026-10-03-projects-design §3): Pinned, each
 * project in `compareProjects` order, then No project. Archived chats never
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
    return { key, project, total: members.length, chats: members.filter((c) => !c.pinned && shown(c)).sort(byActivity) };
  });

  return {
    pinned: live.filter((c) => c.pinned && shown(c)).sort(byActivity),
    groups: matches === null ? groups : groups.filter((g) => g.chats.length > 0),
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
