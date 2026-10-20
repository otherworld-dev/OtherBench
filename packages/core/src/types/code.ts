/**
 * Shared shapes for the Code tab's git view (spec 2026-10-20-code-tab-design,
 * Goal 2). They live in core, not in the server's git service, because the web
 * package reads them too and cannot import from the server. The git service's
 * `GitError` class stays in the server; only its code union is shared, so the
 * UI can switch on a failure without knowing how it was raised.
 */

/** One entry from `git status --porcelain=v2`. `index`/`worktree` are git's XY letters, ' ' for unchanged, '?' for untracked. */
export interface GitFileChange {
  path: string;
  /** The path a rename or copy came from. */
  origPath?: string;
  index: string;
  worktree: string;
}

export interface GitStatus {
  /** The current branch's name; for a repo with no commits, the unborn branch's name. null when detached. */
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export type GitErrorCode = 'git-missing' | 'not-a-repo' | 'bad-path' | 'bad-branch' | 'git-failed';

/** Failure kinds of the GitHub issues service (spec 2026-10-20-code-tab-design, "Error states"); the `GhError` class stays in the server. */
export type GhErrorCode = 'gh-missing' | 'gh-signed-out' | 'repo-not-found' | 'gh-failed';

export interface IssueSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  author: string;
  labels: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface IssueDetail extends IssueSummary {
  body: string;
  commentList: { author: string; body: string; createdAt: string }[];
}
