import { compareAppFolders, compareApps } from '@otherbench/core/domain/apps.js';
import type { App, AppFolder, Chat } from '@otherbench/core/ports/store.js';
import { folderKey } from '../panes/sidebar/model.js';

/** One app on the All apps page, with what its card shows about it. */
export interface AllAppsCard {
  app: App;
  /** Its unarchived chats' count (`chats.length`). */
  chatCount: number;
  /** The latest `updatedAt` among its unarchived chats, or null with none. */
  lastUsed: number | null;
  /** Its unarchived chats, for the status words. */
  chats: Chat[];
}

/** One section of the page: a folder, or (`folder` null) Unfiled. */
export interface AllAppsSection {
  folder: AppFolder | null;
  /** `folderKey(id)`, or `'folder:unfiled'` for Unfiled: also its collapse-state key. */
  key: string;
  /** The apps shown, in `compareApps` order; only those matching the query while searching. */
  cards: AllAppsCard[];
  /** Every app in the section, matched or not. */
  total: number;
}

export const UNFILED_KEY = 'folder:unfiled';

/**
 * The page's sections (spec 2026-11-04-open-apps-design, Goals 10 and 14): a section per folder in
 * `compareAppFolders` order (kept when empty), then Unfiled for apps with no folder or one that isn't loaded
 * (left out when empty, unless `keepUnfiled`: a filed app is being dragged and needs somewhere to go back out of its
 * folder). A query (case-insensitive) matches an app's name or workspace path, or its folder's name, which brings in
 * all of that folder's apps; sections left with no match are dropped.
 */
export function allAppsSections(apps: App[], folders: AppFolder[], chats: Chat[], query: string, keepUnfiled = false): AllAppsSection[] {
  const q = query.trim().toLowerCase();
  const known = new Set(folders.map((f) => f.id));
  const sorted = [...apps].sort(compareApps);
  const card = (app: App): AllAppsCard => {
    const own = chats.filter((c) => c.appId === app.id && c.archivedAt === null);
    return { app, chatCount: own.length, lastUsed: own.reduce<number | null>((m, c) => (m === null || c.updatedAt > m ? c.updatedAt : m), null), chats: own };
  };
  const section = (folder: AppFolder | null, members: App[]): AllAppsSection => {
    const folderHit = q !== '' && folder !== null && folder.name.toLowerCase().includes(q);
    const shown = q === '' || folderHit ? members : members.filter((a) => a.name.toLowerCase().includes(q) || (a.workspaceRoot ?? '').toLowerCase().includes(q));
    return { folder, key: folder === null ? UNFILED_KEY : folderKey(folder.id), cards: shown.map(card), total: members.length };
  };
  const sections = [...folders].sort(compareAppFolders).map((f) => section(f, sorted.filter((a) => a.folderId === f.id)));
  const unfiled = section(null, sorted.filter((a) => a.folderId === null || !known.has(a.folderId)));
  if (unfiled.total > 0 || keepUnfiled) sections.push(unfiled);
  // Searching keeps a section with a match; an empty folder only when its own name matched.
  return q === '' ? sections : sections.filter((s) => s.cards.length > 0 || (s.folder !== null && s.total === 0 && s.folder.name.toLowerCase().includes(q)));
}
