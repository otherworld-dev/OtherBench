import type { ExtraFolder, FolderView, Workspace, WorkspaceStatus } from '../../types/workspace.js';

// --- projects ----------------------------------------------------------------

/**
 * A sidebar group of chats that can carry a workspace folder and a default
 * profile (spec 2026-10-03-projects-design). Both are copied onto a chat only
 * when it is created in the project; changing them later never touches
 * existing chats.
 */
export interface Project {
  id: string;
  name: string;
  /**
   * A line about the project, shown in the Inspector and, cut to 120 characters, in the project index
   * every chat with global memory gets (spec 2026-10-08-global-memory-design §1).
   */
  description: string;
  /** Added to the system prompt of every chat in the project, as the user's instructions (spec 2026-10-08-project-page-design §2). */
  instructions: string;
  /** The default folder for new chats, portable across machines like `Chat.workspace`. */
  workspace: Workspace | null;
  /** API only, as on `Chat`: `workspace` resolved on this machine, filled by the server. */
  workspaceRoot?: string | null;
  workspaceStatus?: WorkspaceStatus;
  /** Extra folders every chat in the project may use, as on `Chat`; `folderViews` is API only, resolved on this machine. */
  folders?: ExtraFolder[];
  folderViews?: FolderView[];
  /** Cleared (null) when that profile is archived (by the profiles route) or deleted (by the foreign key's ON DELETE SET NULL). */
  defaultProfileId: string | null;
  /**
   * The project this one is a sub-project of (spec 2026-10-15-sub-projects-design); absent or null for a top-level
   * project. The store always fills it. Not trusted on read: a synced row can name a missing or nested parent, so
   * read it through `projectParentOf` (domain/projects.ts).
   */
  parentId?: string | null;
  /** Ascending; ties break by name (ASCII case-insensitive), then id -- see `compareProjects`. */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** What `ProjectRepo.create` takes: timestamps default to now, `sortOrder` to 0; `workspace` and a bare `workspaceRoot` as on `NewChat`. */
export type NewProject = Omit<Project, 'createdAt' | 'updatedAt' | 'sortOrder' | 'workspace' | 'workspaceRoot' | 'workspaceStatus' | 'description' | 'instructions'> & {
  workspace?: Workspace | null;
  workspaceRoot?: string | null;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
  /** Default ''. */
  description?: string;
  /** Default ''. */
  instructions?: string;
};

export interface ProjectRepo {
  create(p: NewProject): Project;
  get(id: string): Project | null;
  /** Every project, in sidebar order (`compareProjects`). */
  list(): Project[];
  /** A `workspaceRoot` in the patch (and no `workspace`) is stored as a folder bound to this machine. */
  update(id: string, patch: Partial<Omit<Project, 'id'>>): Project;
  /**
   * Deletes the project and its memory note and versions. Its chats move to
   * no project (`projectId: null`, `memoryCursor: null`); chats are never deleted.
   */
  delete(id: string): void;
}
