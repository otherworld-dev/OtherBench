import { tmpdir } from 'node:os';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';
import { isGithubRepo, ISSUE_LIST_LIMIT } from '@otherbench/core/domain/apps.js';
import type { GhErrorCode, IssueDetail, IssueSummary } from '@otherbench/core/types/code.js';
import { ExecutableNotFoundError, resolveExecutable } from '@otherbench/tools/mcp/spawn.js';
import { redactUrls } from './git-parse.js';
import { ExecutableMissingError, runProcess, type RunResult } from './process.js';

/**
 * The Code tab's GitHub issues service (spec 2026-10-20-code-tab-design, Goal 3
 * and "Decisions Adam made" on gh): the machine's own `gh`, signed in by the
 * user. OtherBench stores no GitHub token, so there is nothing here to leak and
 * nothing to rotate.
 *
 *  - Runs as a fixed argv list, no shell. The repo ("owner/name") is checked
 *    with isGithubRepo and always passed as `--repo`, so the app folder never
 *    matters and the process runs from a neutral directory.
 *  - An issue number must be a positive integer; a comment body goes on stdin
 *    (`--body-file -`), never into argv.
 *  - Failures become a GhErrorCode: a missing executable, a signed-out gh, an
 *    unknown repo, or anything else with stderr's first line (credentials in
 *    URLs redacted).
 *
 * The service takes an injected Runner so tests never call a real gh.
 */

export type { GhErrorCode, IssueSummary, IssueDetail } from '@otherbench/core/types/code.js';

export class GhError extends Error {
  constructor(
    readonly code: GhErrorCode,
    message: string,
    /** gh's whole stderr, credentials in URLs redacted, for a `gh-failed` the panel shows as-is (spec "Error states"). */
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

export type Runner = (args: string[], input?: string) => Promise<RunResult>;

const GH_ENV_EXTRAS: Record<string, string> = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
};

/** The environment every gh process gets: the server's minus its secrets, plus the no-prompt settings. */
export function ghEnv(base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  return { ...withoutServerSecrets(base), ...GH_ENV_EXTRAS };
}

const GH_TIMEOUT_MS = 60_000;

const GH_MISSING = 'The GitHub CLI (gh) is not installed, or is not on the PATH.';

/**
 * The default Runner: `gh` run from a neutral folder (every call passes
 * --repo). The executable is resolved once per runner and the path reused, as
 * git.ts does for git: on Windows resolveExecutable is a synchronous `where`
 * spawn, too slow to repeat for every issue-list refresh (spec
 * 2026-10-20-code-tab-design, Goal 3). A gh that is not found is not cached, so
 * installing it later works without restarting the server. `resolve` is
 * injectable for tests.
 */
export function ghRunner(resolve: (command: string) => string = resolveExecutable): Runner {
  let ghExe: string | undefined;
  return async (args, input) => {
    if (ghExe === undefined) {
      try {
        ghExe = resolve('gh');
      } catch (err) {
        if (err instanceof ExecutableNotFoundError) throw new GhError('gh-missing', GH_MISSING);
        throw err;
      }
    }
    try {
      return await runProcess(ghExe, args, {
        cwd: tmpdir(),
        env: ghEnv(),
        timeoutMs: GH_TIMEOUT_MS,
        ...(input !== undefined ? { input } : {}),
      });
    } catch (err) {
      if (err instanceof ExecutableMissingError) throw new GhError('gh-missing', GH_MISSING);
      const reason = err instanceof Error ? err.message : String(err);
      throw new GhError('gh-failed', `Could not start gh: ${redactUrls(reason)}`);
    }
  };
}

const SUMMARY_FIELDS = 'number,title,state,author,labels,comments,createdAt,updatedAt,url';

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
}

interface RawComment {
  author?: { login?: string } | null;
  body?: string;
  createdAt?: string;
}
interface RawIssue {
  number: number;
  title: string;
  state: string;
  author?: { login?: string } | null;
  labels?: { name: string }[];
  comments?: RawComment[];
  createdAt: string;
  updatedAt: string;
  url: string;
  body?: string;
}

function summary(r: RawIssue): IssueSummary {
  return {
    number: r.number,
    title: r.title,
    state: r.state.toLowerCase() === 'closed' ? 'closed' : 'open',
    author: r.author?.login ?? '',
    labels: (r.labels ?? []).map((l) => l.name),
    comments: (r.comments ?? []).length,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    url: r.url,
  };
}

/** What githubService returns; the container's `github` is one of these. */
export type GithubService = ReturnType<typeof githubService>;

export function githubService(run: Runner) {
  async function gh(args: string[], input?: string): Promise<string> {
    let r: RunResult;
    try {
      r = await run(args, input);
    } catch (err) {
      if (err instanceof ExecutableMissingError) throw new GhError('gh-missing', GH_MISSING);
      if (err instanceof GhError) throw err;
      // An injected runner's spawn failure other than a missing gh (EINVAL, EACCES...): still gh-failed, as git.ts
      // does for git, never a raw error the route would answer with a 500.
      const reason = err instanceof Error ? err.message : String(err);
      throw new GhError('gh-failed', `Could not start gh: ${redactUrls(reason)}`);
    }
    if (r.timedOut) throw new GhError('gh-failed', `gh ${args[0] ?? ''} ${args[1] ?? ''} timed out.`, redactUrls(r.stderr));
    if (r.code !== 0) {
      const stderr = redactUrls(r.stderr);
      if (/gh auth login|not logged in|authentication/i.test(stderr)) {
        throw new GhError('gh-signed-out', 'The GitHub CLI is not signed in. Run `gh auth login` in a terminal.');
      }
      if (/Could not resolve to a Repository|not found/i.test(stderr)) throw new GhError('repo-not-found', 'That repository was not found on GitHub.');
      throw new GhError('gh-failed', firstLine(stderr) || `gh ${args[0] ?? ''} ${args[1] ?? ''} failed.`, stderr);
    }
    return r.stdout;
  }

  const checkRepo = (repo: string): void => {
    if (!isGithubRepo(repo)) throw new GhError('repo-not-found', `"${repo}" is not a GitHub repository (owner/name).`);
  };
  const checkNumber = (n: number): void => {
    if (!Number.isInteger(n) || n <= 0) throw new GhError('gh-failed', `"${String(n)}" is not a valid issue number.`);
  };
  const parse = <T>(text: string): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GhError('gh-failed', 'gh returned output that was not valid JSON.');
    }
  };

  return {
    async list(repo: string, state: 'open' | 'closed'): Promise<IssueSummary[]> {
      checkRepo(repo);
      const out = await gh(['issue', 'list', '--repo', repo, '--state', state, '--limit', String(ISSUE_LIST_LIMIT), '--json', SUMMARY_FIELDS]);
      return parse<RawIssue[]>(out)
        .map(summary)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },
    async view(repo: string, n: number): Promise<IssueDetail> {
      checkRepo(repo);
      checkNumber(n);
      const out = await gh(['issue', 'view', String(n), '--repo', repo, '--json', `${SUMMARY_FIELDS},body`]);
      const r = parse<RawIssue>(out);
      return {
        ...summary(r),
        body: r.body ?? '',
        commentList: (r.comments ?? []).map((c) => ({ author: c.author?.login ?? '', body: c.body ?? '', createdAt: c.createdAt ?? '' })),
      };
    },
    async comment(repo: string, n: number, body: string): Promise<void> {
      checkRepo(repo);
      checkNumber(n);
      await gh(['issue', 'comment', String(n), '--repo', repo, '--body-file', '-'], body);
    },
    async close(repo: string, n: number): Promise<void> {
      checkRepo(repo);
      checkNumber(n);
      await gh(['issue', 'close', String(n), '--repo', repo]);
    },
    async reopen(repo: string, n: number): Promise<void> {
      checkRepo(repo);
      checkNumber(n);
      await gh(['issue', 'reopen', String(n), '--repo', repo]);
    },
  };
}
