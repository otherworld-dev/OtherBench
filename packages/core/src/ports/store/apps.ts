import type { Workspace, WorkspaceStatus } from '../../types/workspace.js';

// --- apps ----------------------------------------------------------------------

/**
 * A codebase the Code tab works on (spec 2026-10-20-code-tab-design, "Data"): a folder, optionally the GitHub repo
 * it came from, and optionally a project whose memory and instructions its chats borrow. Chats filed under an app
 * carry `appId`; a chat has an app or a project, never both.
 */
export interface App {
  id: string;
  name: string;
  /** The app's folder, portable across machines like `Project.workspace`. Unlike a project it has no extra folders: those come only from the linked project. */
  workspace: Workspace | null;
  /** API only, as on `Project`: `workspace` resolved on this machine, filled by the server. */
  workspaceRoot?: string | null;
  workspaceStatus?: WorkspaceStatus;
  /** "owner/name" on GitHub, or null. */
  githubRepo: string | null;
  /** Not trusted on read: a synced row can name a project that is missing here, and the column is not a foreign key (migration 029). */
  linkedProjectId: string | null;
  /** Cleared (null) when that profile is archived (by the profiles route) or deleted (by the foreign key's ON DELETE SET NULL). */
  defaultProfileId: string | null;
  /** The app's Nextcloud Deck board (numeric id), or null. */
  deckBoardId: number | null;
  /** The Collectives collective holding the app's wiki page, or null. */
  wikiCollective: string | null;
  /** Slash-separated page path within that collective, or null. */
  wikiPagePath: string | null;
  /** The Nextcloud Bookmarks tag that marks the app's links, or null. */
  bookmarkTag: string | null;
  /** The Code sidebar folder this app is in, or null for the top level. Not trusted on read: not a foreign key (migration 032), so a synced row can name a folder that is missing here, which shows as none. */
  folderId: string | null;
  /** Shown in the Code sidebar (spec 2026-11-04-open-apps). Synced: every machine shows the same open apps. */
  open: boolean;
  /** Ascending; ties break by name (ASCII case-insensitive), then id -- see `compareApps`. */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** What `AppRepo.create` takes: timestamps default to now, `sortOrder` to 0, `open` to true, the links to null; `workspace` and a bare `workspaceRoot` as on `NewProject`. */
export type NewApp = Omit<
  App,
  'createdAt' | 'updatedAt' | 'sortOrder' | 'workspace' | 'workspaceRoot' | 'workspaceStatus' | 'githubRepo' | 'linkedProjectId' | 'defaultProfileId' | 'deckBoardId' | 'wikiCollective' | 'wikiPagePath' | 'bookmarkTag' | 'folderId' | 'open'
> & {
  workspace?: Workspace | null;
  workspaceRoot?: string | null;
  githubRepo?: string | null;
  linkedProjectId?: string | null;
  defaultProfileId?: string | null;
  deckBoardId?: number | null;
  wikiCollective?: string | null;
  wikiPagePath?: string | null;
  bookmarkTag?: string | null;
  folderId?: string | null;
  open?: boolean;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
};

export interface AppRepo {
  create(a: NewApp): App;
  get(id: string): App | null;
  /** Every app, in sidebar order (`compareApps`). */
  list(): App[];
  /** A `workspaceRoot` in the patch (and no `workspace`) is stored as a folder bound to this machine. */
  update(id: string, patch: Partial<Omit<App, 'id'>>): App;
  /** Deletes the app. Its chats keep existing with `appId: null` (cleared through the chat repo so the change syncs); chats are never deleted. */
  delete(id: string): void;
}

// --- app folders -------------------------------------------------------------

/** A folder in the Code sidebar that groups apps (migration 032); one level, a synced table. */
export interface AppFolder {
  id: string;
  name: string;
  /** Ascending; ties break by name (ASCII case-insensitive), then id -- see `compareAppFolders`. */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** What `AppFolderRepo.create` takes: `sortOrder` defaults to 0, timestamps to now. */
export type NewAppFolder = { id: string; name: string; sortOrder?: number };

export interface AppFolderRepo {
  create(f: NewAppFolder): AppFolder;
  get(id: string): AppFolder | null;
  /** Every folder, in sidebar order (`compareAppFolders`). */
  list(): AppFolder[];
  update(id: string, patch: Partial<Pick<AppFolder, 'name' | 'sortOrder'>>): AppFolder;
  /** Deletes the folder. Its apps keep existing with `folderId: null` (cleared through the app repo so the change syncs); apps are never deleted. */
  delete(id: string): void;
}

// --- issue ticks -------------------------------------------------------------

/** How far the user has ticked a GitHub issue off in an app (migration 033); a synced table. */
export interface IssueTick {
  appId: string;
  number: number;
  /** ISO time of the issue activity ticked through. */
  through: string;
  updatedAt: number;
}

export interface IssueTickRepo {
  list(): IssueTick[];
  /** Upserts the tick for the issue; a later `through` replaces an earlier one, and an earlier one changes nothing. Returns the tick as stored. */
  set(appId: string, number: number, through: string): IssueTick;
  /** Deletes every tick of the app; each delete syncs as a tombstone. */
  deleteForApp(appId: string): void;
}

// --- app notes ----------------------------------------------------------------------

/**
 * An app's notes (spec 2026-11-05-app-notes-design): the user's standing facts
 * about it, under headings, kept by the user only (typed with `#`, a model's
 * offer the user saved, or an edit). `mirroredAt` is this machine's last good
 * write of them to Collectives (null: never); it doesn't sync.
 */
export interface AppNotes {
  appId: string;
  body: string;
  updatedAt: number;
  /** The chat a fact came from, null for an edit or a restore. */
  sourceChatId: string | null;
  mirroredAt: number | null;
}

/** One saved version of an app's notes; every save adds one. Kept on this machine only. */
export interface AppNotesVersion {
  id: string;
  appId: string;
  body: string;
  createdAt: number;
  sourceChatId: string | null;
}

export interface AppNotesRepo {
  /** The app's notes, or null if they were never saved. */
  get(appId: string): AppNotes | null;
  /** Every app's notes (for the Collectives retry). */
  list(): AppNotes[];
  /**
   * Replaces the app's notes, records a version, and prunes versions beyond
   * the newest `APP_NOTES_VERSIONS_KEPT`. `at` defaults to now. Throws for an
   * app that doesn't exist.
   */
  save(appId: string, body: string, sourceChatId: string | null, at?: number): AppNotes;
  /** Records a good write to Collectives of the notes saved at `at` (their `updatedAt`). Never syncs. */
  markMirrored(appId: string, at: number): void;
  /** The app's versions, newest first. */
  versions(appId: string): AppNotesVersion[];
  version(id: string): AppNotesVersion | null;
}
