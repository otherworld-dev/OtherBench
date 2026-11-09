/** Code mode calls and shapes: `api.appFolders`, `api.apps`, `api.terminals` and `api.appNotes`. */
import type { App, AppFolder, AppNotesVersion } from '@otherbench/core/ports/store.js';
import type { FeatureOffCode, GhErrorCode, GitErrorCode, GitStatus, IssueDetail, IssueSummary, PullRequestDetail } from '@otherbench/core/types/code.js';
import type { AppNotesVersionSummary, AppNotesView, FactSaved, PlacedFact } from '@otherbench/core/domain/app-notes.js';
import type { Bookmark, DeckBoardView, DeckCardDetail, NextcloudErrorCode, WikiPage, WikiTree } from '@otherbench/core/types/nextcloud.js';
import type { TerminalInfo, TerminalStatus } from '@otherbench/core/types/terminal.js';
import type { ViewEntry, ViewText } from './view.js';
import { streamApiUrl } from '../transport.js';
import { request, post, put, patch, del } from './http.js';

/**
 * The `code` a Code tab route's failure names (spec 2026-10-20-code-tab-design,
 * "Error states the panels must handle"; server `code/route-errors.ts`). The
 * panels pick their one-line copy by it.
 */
export type CodeErrorCode = GitErrorCode | GhErrorCode | 'not-on-this-machine' | 'no-github-repo' | NextcloudErrorCode | FeatureOffCode;

/** `POST /api/apps` (spec 2026-10-20-code-tab-design, "The New app form"). The folder is required. */
export interface CreateAppBody {
  /** Trimmed, 1 to 80 characters. */
  name: string;
  /** An absolute path on this machine. */
  workspacePath: string;
  /** "owner/name"; null or blank for none. */
  githubRepo?: string | null;
  linkedProjectId?: string | null;
  /** Not an archived profile. */
  defaultProfileId?: string | null;
  /** Left out: the new app goes to the bottom. */
  sortOrder?: number;
  /** The app folder it sits in; null for the top level. */
  folderId?: string | null;
  /** A Nextcloud Deck board id; null for none. */
  deckBoardId?: number | null;
  /** The Collectives collective and page path holding the app's wiki; null for none. */
  wikiCollective?: string | null;
  wikiPagePath?: string | null;
  /** The Nextcloud bookmark tag for the app's links; null for none. */
  bookmarkTag?: string | null;
}

/** `PATCH /api/apps/:id`: any of these. The folder can't be cleared; a new one moves every chat in the app with it. */
export type PatchAppBody = Partial<CreateAppBody> & { open?: boolean };

/** `GET /api/apps/detect-repo`: `isRepo` only for a repo's top level; its GitHub `origin`, when it has one. */
export interface DetectRepoResult {
  githubRepo: string | null;
  isRepo: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

/** Folders for apps in the Code sidebar (plan 2026-10-25-app-folders; server `routes/app-folders.ts`). */
export const appFoldersApi = {
  /** In sidebar order. */
  list: () => request<AppFolder[]>('/app-folders'),
  create: (body: { name?: string; sortOrder?: number } = {}) => post<AppFolder>('/app-folders', body),
  patch: (id: string, body: { name?: string; sortOrder?: number }) => patch<AppFolder>(`/app-folders/${encodeURIComponent(id)}`, body),
  /** Its apps move to the top level; none are deleted. */
  delete: (id: string) => del(`/app-folders/${encodeURIComponent(id)}`),
};

/**
 * Apps and their git, GitHub issues and files (spec 2026-10-20-code-tab-design; server `routes/apps.ts`).
 * Each failure's `code` (a `CodeErrorCode`) and, for git-failed/gh-failed, `stderr` are on the ApiError.
 * The git and files routes answer 409 `not-on-this-machine` when the app's folder isn't here; the issue routes
 * work wherever the folder is, and answer 409 `no-github-repo` for an app with none.
 */
export const appsApi = {
  /** In sidebar order. */
  list: () => request<App[]>('/apps'),
  get: (id: string) => request<App>(`/apps/${encodeURIComponent(id)}`),
  create: (body: CreateAppBody) => post<App>('/apps', body),
  patch: (id: string, body: PatchAppBody) => patch<App>(`/apps/${encodeURIComponent(id)}`, body),
  /** Its chats go back to Chat mode (`appId: null`); none are deleted. */
  delete: (id: string) => del(`/apps/${encodeURIComponent(id)}`),
  /** What the New app form pre-fills from a folder: an absolute path on this machine. */
  detectRepo: (path: string) => request<DetectRepoResult>(`/apps/detect-repo?path=${encodeURIComponent(path)}`),
  git: {
    status: (id: string) => request<GitStatus>(`/apps/${encodeURIComponent(id)}/git/status`),
    /** One file's diff, or the whole tree's without `path`. */
    diff: (id: string, path?: string) =>
      request<{ diff: string }>(`/apps/${encodeURIComponent(id)}/git/diff${path !== undefined ? `?path=${encodeURIComponent(path)}` : ''}`),
    /** `paths` defaults to 'all' (every change); a list commits only those. */
    commit: (id: string, body: { message: string; paths?: string[] | 'all' }) => post<{ sha: string }>(`/apps/${encodeURIComponent(id)}/git/commit`, body),
    pull: (id: string) => post<{ output: string }>(`/apps/${encodeURIComponent(id)}/git/pull`),
    /** `setUpstream` for a branch with no upstream yet ("Push and set upstream"). */
    push: (id: string, opts: { setUpstream?: boolean } = {}) => post<{ output: string }>(`/apps/${encodeURIComponent(id)}/git/push`, opts),
    branches: (id: string) => request<{ branches: GitBranch[] }>(`/apps/${encodeURIComponent(id)}/git/branches`),
    /** Switches to an existing branch (204); refetch the status after. */
    checkout: (id: string, branch: string) => post<void>(`/apps/${encodeURIComponent(id)}/git/checkout`, { branch }),
    /** Creates the branch and switches to it (204); refetch the status after. */
    branch: (id: string, branch: string) => post<void>(`/apps/${encodeURIComponent(id)}/git/branch`, { branch }),
  },
  issues: {
    /** Open issues unless `state` says closed. */
    list: (id: string, state?: 'open' | 'closed') =>
      request<{ repo: string; issues: IssueSummary[] }>(`/apps/${encodeURIComponent(id)}/issues${state !== undefined ? `?state=${state}` : ''}`),
    get: (id: string, n: number) => request<IssueDetail>(`/apps/${encodeURIComponent(id)}/issues/${n}`),
    /** A blank comment is a 400 (204 otherwise); refetch the issue after. */
    comment: (id: string, n: number, body: string) => post<void>(`/apps/${encodeURIComponent(id)}/issues/${n}/comment`, { body }),
    close: (id: string, n: number) => post<void>(`/apps/${encodeURIComponent(id)}/issues/${n}/close`),
    reopen: (id: string, n: number) => post<void>(`/apps/${encodeURIComponent(id)}/issues/${n}/reopen`),
  },
  pulls: {
    /** A pull request with its branch, for a chat started on it. */
    get: (id: string, n: number) => request<PullRequestDetail>(`/apps/${encodeURIComponent(id)}/pulls/${n}`),
  },
  deck: {
    /** The app's Deck board; 409 `no-deck-board` for an app with none. */
    board: (id: string) => request<DeckBoardView>(`/apps/${encodeURIComponent(id)}/deck`),
    create: (id: string, body: { stackId: number; title: string; description?: string }) =>
      post<DeckCardDetail>(`/apps/${encodeURIComponent(id)}/deck/cards`, body),
  },
  wiki: {
    /** The page tree under the app's wiki page; 409 `no-wiki-page` for an app with none. */
    tree: (id: string) => request<WikiTree>(`/apps/${encodeURIComponent(id)}/wiki`),
    page: (id: string, pageId: number) => request<WikiPage>(`/apps/${encodeURIComponent(id)}/wiki/pages/${pageId}`),
  },
  links: {
    /** The bookmarks under the app's tag; 409 `no-bookmark-tag` for an app with none. */
    list: (id: string) => request<{ tag: string; bookmarks: Bookmark[] }>(`/apps/${encodeURIComponent(id)}/links`),
    add: (id: string, body: { url: string; title?: string; description?: string; tags?: string[] }) =>
      post<Bookmark>(`/apps/${encodeURIComponent(id)}/links`, body),
    /** `tags` replaces the tag set (the server keeps the app's own tag on it). */
    update: (id: string, bookmarkId: number, body: { url?: string; title?: string; description?: string; tags?: string[] }) =>
      patch<Bookmark>(`/apps/${encodeURIComponent(id)}/links/${bookmarkId}`, body),
    remove: (id: string, bookmarkId: number) => del(`/apps/${encodeURIComponent(id)}/links/${bookmarkId}`),
  },
  /** A folder's entries; the app's root without `path`. A relative path is read inside the root. */
  files: (id: string, path?: string) =>
    request<{ path: string; entries: ViewEntry[] }>(`/apps/${encodeURIComponent(id)}/files${path !== undefined ? `?path=${encodeURIComponent(path)}` : ''}`),
  /** A file's text inside the app's folder, as `view.text` reads one for a chat. */
  text: (id: string, path: string) => request<ViewText>(`/apps/${encodeURIComponent(id)}/text?path=${encodeURIComponent(path)}`),
};

/**
 * The Code tab's terminals (spec 2026-10-21-code-terminal-design; server `routes/terminals.ts`). Only a local server
 * has them: `status()` says whether this one does, and why not.
 */
export const terminalsApi = {
  status: () => request<TerminalStatus>('/terminal/status'),
  list: (appId: string) => request<TerminalInfo[]>(`/apps/${encodeURIComponent(appId)}/terminals`),
  /** The default shell without `shell`. A folder not on this machine is a 409 `not-on-this-machine`. */
  create: (appId: string, body: { shell?: string; cols: number; rows: number }) => post<TerminalInfo>(`/apps/${encodeURIComponent(appId)}/terminals`, body),
  rename: (appId: string, id: string, name: string) => patch<TerminalInfo>(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}`, { name }),
  kill: (appId: string, id: string) => del(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}`),
  /** At most 64 KiB a call. */
  input: (appId: string, id: string, data: string) => post<void>(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}/input`, { data }),
  resize: (appId: string, id: string, cols: number, rows: number) =>
    post<void>(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}/resize`, { cols, rows }),
  restart: (appId: string, id: string) => post<TerminalInfo>(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}/restart`),
  /** The output after offset `from` (an earlier answer's `next`), for a page that polls; `reset`: start the screen again from `data`. */
  output: (appId: string, id: string, from: number) =>
    request<{ data: string; next: number; reset: boolean; exitCode: number | null }>(
      `/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}/output?from=${from}`
    ),
  /** Not fetched via `request` -- opened by `state/sse.ts`'s streaming reader, for the terminal on screen only. */
  streamUrl: (appId: string, id: string) => streamApiUrl(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}/stream`),
};

/** An app's notes (spec 2026-11-05-app-notes-design). */
export const appNotesApi = {
  get: (appId: string) => request<AppNotesView>(`/apps/${appId}/notes`),
  /** The whole page; at most 12,000 characters. */
  save: (appId: string, body: string) => put<AppNotesView>(`/apps/${appId}/notes`, { body }),
  /** Files a fact (typed with # or a model's offer); the server's model picks its heading and the line it replaces. */
  addFact: (appId: string, body: { text: string; section?: string | null; chatId?: string | null }) => post<FactSaved>(`/apps/${appId}/notes/facts`, body),
  editFact: (appId: string, line: string, text: string) => post<AppNotesView>(`/apps/${appId}/notes/facts/edit`, { line, text }),
  moveFact: (appId: string, line: string, section: string) => post<AppNotesView>(`/apps/${appId}/notes/facts/move`, { line, section }),
  /** Takes a filed fact back out and puts back the line it replaced. */
  undoFact: (appId: string, fact: PlacedFact) => post<AppNotesView>(`/apps/${appId}/notes/facts/undo`, { line: fact.line, section: fact.section, replaced: fact.replaced }),
  /** Newest first. */
  versions: (appId: string) => request<AppNotesVersionSummary[]>(`/apps/${appId}/notes/versions`),
  version: (appId: string, versionId: string) => request<AppNotesVersion>(`/apps/${appId}/notes/versions/${versionId}`),
  restore: (appId: string, versionId: string) => post<AppNotesView>(`/apps/${appId}/notes/versions/${versionId}/restore`),
};
