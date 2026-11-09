/** Project and memory calls and shapes for `api.projects` and `api.memory`. */
import type { GlobalMemory, GlobalMemoryVersion, Project, ProjectMemoryVersion } from '@otherbench/core/ports/store.js';
import type { MemoryFailure, MemoryUpdateOutcome, MemoryVersionSummary, ProjectMemoryView } from '@otherbench/core/domain/memory.js';
import type { FolderAccess, Workspace } from '@otherbench/core/types/workspace.js';
import { request, post, put, patch, del } from './http.js';

/** What `GET /api/memory/global` and its writes return (spec 2026-10-08-global-memory-design §3). */
export interface GlobalMemoryView {
  memory: GlobalMemory;
  lastError: MemoryFailure | null;
}

export interface CreateProjectBody {
  name: string;
  workspaceRoot?: string | null;
  defaultProfileId?: string | null;
  /** At most 500 characters (stored trimmed). */
  description?: string;
  /** At most 8,000 characters; added to every chat's system prompt in the project. */
  instructions?: string;
  /** Extra folders for every chat in the project, each new one by path. */
  folders?: FolderEntry[];
  /** A top-level project to make this a sub-project of (spec 2026-10-15-sub-projects-design). */
  parentId?: string | null;
}

export type PatchProjectBody = Partial<{
  name: string;
  workspaceRoot: string | null;
  defaultProfileId: string | null;
  sortOrder: number;
  /** Extra folders for every chat in the project, the whole list. */
  folders: FolderEntry[];
  description: string;
  instructions: string;
  /** Moves it under a top-level project, or (null) back to the top level. */
  parentId: string | null;
}>;

/**
 * One extra folder in a `folders` patch (spec 2026-10-07-extra-folders): a new
 * one by its path on the machine that runs the chat, or one it already has by
 * its stored form (which keeps a folder this machine can't see).
 */
export type FolderEntry = { path: string; access: FolderAccess } | { workspace: Workspace; access: FolderAccess };

export const projectsApi = {
  /** In sidebar order (sortOrder, then name). */
  list: () => request<Project[]>('/projects'),
  create: (body: CreateProjectBody) => post<Project>('/projects', body),
  patch: (id: string, body: PatchProjectBody) => patch<Project>(`/projects/${id}`, body),
  /** Its chats move to No project; none are deleted. */
  delete: (id: string) => del(`/projects/${id}`),
};

/** A project's shared memory note (spec 2026-10-03-project-memory-design §4). */
export const memoryApi = {
  get: (projectId: string) => request<ProjectMemoryView>(`/projects/${projectId}/memory`),
  /** Saves as the user. The server checks the headings and the 4,000-character cap; Pinned may change. */
  save: (projectId: string, body: string) => put<ProjectMemoryView>(`/projects/${projectId}/memory`, { body }),
  /** Newest first. */
  versions: (projectId: string) => request<MemoryVersionSummary[]>(`/projects/${projectId}/memory/versions`),
  version: (projectId: string, versionId: string) => request<ProjectMemoryVersion>(`/projects/${projectId}/memory/versions/${versionId}`),
  /** Saves that version's body as a new user version. */
  restore: (projectId: string, versionId: string) => post<ProjectMemoryView>(`/projects/${projectId}/memory/versions/${versionId}/restore`),
  /** Folds this chat's new turns in now. Resolves when the update has finished; 409 when the chat isn't in a project or is excluded. */
  updateNow: (chatId: string) => post<MemoryUpdateOutcome>(`/chats/${chatId}/memory/update`),
  /** About you and the learned global note (spec 2026-10-08-global-memory-design §3). */
  global: {
    get: () => request<GlobalMemoryView>('/memory/global'),
    /** At most 4,000 characters. */
    saveAbout: (about: string) => put<GlobalMemoryView>('/memory/global/about', { about }),
    /** Saves the note as the user. The server checks the headings and the 4,000-character cap; Pinned may change. */
    saveNote: (body: string) => put<GlobalMemoryView>('/memory/global', { body }),
    /** Newest first. */
    versions: () => request<MemoryVersionSummary[]>('/memory/global/versions'),
    version: (versionId: string) => request<GlobalMemoryVersion>(`/memory/global/versions/${versionId}`),
    /** Saves that version's body as a new user version. */
    restore: (versionId: string) => post<GlobalMemoryView>(`/memory/global/versions/${versionId}/restore`),
  },
};
