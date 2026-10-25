import type { App, AppFolder } from '../ports/store.js';

/** Longest app name, after trimming (spec 2026-10-20-code-tab-design, "Data"). Same bound as a project's. */
export const APP_NAME_MAX = 80;

/** Longest app folder name, after trimming (plan 2026-10-25-app-folders). */
export const APP_FOLDER_NAME_MAX = 100;

/**
 * Most issues one Issues tab list fetches (`gh issue list --limit`). A list
 * that comes back this long may have been cut, so the tab says "100+" rather
 * than claiming an exact count (spec 2026-10-20-code-tab-design, Goal 3).
 */
export const ISSUE_LIST_LIMIT = 100;

/** Folds A-Z only, exactly like SQLite's NOCASE collation, so both stores order names identically. */
function asciiFold(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * Sidebar order for apps: `sortOrder`, then name (ASCII case-insensitive), then
 * id. Mirrors `SqliteAppRepo.list`'s `ORDER BY sort_order, name COLLATE NOCASE, id`;
 * the in-memory store and the web client sort with this.
 */
export function compareApps(a: App, b: App): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const an = asciiFold(a.name);
  const bn = asciiFold(b.name);
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sidebar order for folders: `sortOrder`, then name (ASCII case-insensitive), then id; mirrors `SqliteAppFolderRepo.list`. */
export function compareAppFolders(a: AppFolder, b: AppFolder): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const an = asciiFold(a.name);
  const bn = asciiFold(b.name);
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Whether `value` is a GitHub "owner/name": an owner of letters, digits and
 * hyphens (never leading one), a name of those plus `.` and `_`, and no `..`
 * anywhere so it can't be read as a path.
 */
export function isGithubRepo(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(value) && !value.includes('..');
}

/**
 * "owner/name" from a git remote URL, or null when the remote isn't on
 * github.com (https, ssh:// and scp-style `git@github.com:o/n.git` forms; a
 * trailing `.git` or `/` is dropped).
 */
export function githubRepoFromRemote(url: string): string | null {
  const m = /^\s*(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/i.exec(url);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  return isGithubRepo(repo) ? repo : null;
}

/** The GitHub repo among a folder's remotes: `github` first, then `origin`, then the first that is on GitHub. */
export function githubRepoFromRemotes(remotes: { name: string; url: string }[]): string | null {
  for (const name of ['github', 'origin']) {
    const r = remotes.find((x) => x.name === name);
    const repo = r ? githubRepoFromRemote(r.url) : null;
    if (repo) return repo;
  }
  for (const r of remotes) {
    const repo = githubRepoFromRemote(r.url);
    if (repo) return repo;
  }
  return null;
}
