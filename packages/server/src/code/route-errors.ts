import { HTTPException } from 'hono/http-exception';
import type { GhErrorCode, GitErrorCode } from '@otherbench/core/types/code.js';
import { GhError } from './github.js';
import { GitError } from './git.js';
import { ExecutableMissingError } from './process.js';

/**
 * The Code tab's route failures (spec 2026-10-20-code-tab-design, "Error
 * states the panels must handle"). The panels have to say *which* thing is
 * wrong -- git missing, gh signed out, not a repo, the folder not on this
 * machine -- and print the command that fixes it, so a bare message isn't
 * enough: every one carries a machine-readable `code` the web switches on.
 *
 * The body keeps the shape every other route already answers with,
 * `{ error: message }` (app.ts's onError), and adds `code` (and, for a git
 * failure, git's `stderr`) beside it, so the web client's existing error
 * reading still finds the message and no other route's response changes.
 */
export type CodeRouteErrorCode = GitErrorCode | GhErrorCode | 'not-on-this-machine' | 'no-github-repo';

export class CodeRouteError extends HTTPException {
  constructor(
    status: 400 | 409,
    readonly code: CodeRouteErrorCode,
    message: string,
    readonly stderr?: string
  ) {
    super(status, { message });
    this.name = 'CodeRouteError';
  }

  /** What goes beside `error` in the JSON body. */
  extras(): { code: CodeRouteErrorCode; stderr?: string } {
    return { code: this.code, ...(this.stderr !== undefined ? { stderr: this.stderr } : {}) };
  }
}

/**
 * A bad path or branch name is the request's fault (400); everything else --
 * git or gh missing or signed out, not a repo, an unknown repo, or the tool
 * itself failing -- is the state of this machine (409). Never a 500: these
 * are expected, and the panel shows each one.
 */
const BAD_REQUEST: ReadonlySet<CodeRouteErrorCode> = new Set(['bad-path', 'bad-branch']);

/**
 * Rethrows a git, gh or missing-executable failure as a CodeRouteError, and
 * anything else unchanged. `git-failed` carries git's stderr as-is: the git
 * service already redacted credentials in URLs from it, and the spec says to
 * show a rejected push or a conflicting pull exactly as git wrote it.
 */
export function asCodeRouteError(err: unknown): never {
  if (err instanceof GitError) {
    const status = BAD_REQUEST.has(err.code) ? 400 : 409;
    throw new CodeRouteError(status, err.code, err.message, err.code === 'git-failed' ? (err.stderr ?? '') : undefined);
  }
  if (err instanceof GhError) throw new CodeRouteError(409, err.code, err.message);
  if (err instanceof ExecutableMissingError) {
    throw err.command === 'gh'
      ? new CodeRouteError(409, 'gh-missing', 'The GitHub CLI (gh) is not installed, or is not on the PATH.')
      : new CodeRouteError(409, 'git-missing', 'Git is not installed, or is not on the PATH.');
  }
  throw err;
}

/** Runs a git or gh call, turning its failures into CodeRouteErrors. */
export async function codeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    asCodeRouteError(err);
  }
}
