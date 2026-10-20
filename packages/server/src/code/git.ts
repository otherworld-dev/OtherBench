import { relative, sep } from 'node:path';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';
import { containPath } from '@otherbench/core/domain/paths.js';
import type { GitErrorCode, GitStatus } from '@otherbench/core/types/code.js';
import { parseBranches, parseRemotes, parseStatusV2 } from './git-parse.js';
import { ExecutableMissingError, runProcess, type RunResult } from './process.js';

/**
 * The Code tab's git service (spec 2026-10-20-code-tab-design, Goal 2): the
 * machine's own `git`, run as fixed argv lists. Nothing the UI sends is ever
 * spliced into a command line:
 *
 *  - Every call is `git --no-pager -c core.quotepath=false <fixed verb> ...`,
 *    spawned without a shell, with the server's environment minus its secrets
 *    plus settings that stop git, gh and credential helpers from prompting or
 *    paging (nothing here has a terminal to answer).
 *  - A file path from the UI goes through containPath against the app's
 *    resolved root, then is handed to git after a `--` so it can only ever be a
 *    pathspec, never an option. A path that escapes is `bad-path`.
 *  - A branch name is refused if empty or starting with `-` (it would be read as
 *    an option) and must pass `git check-ref-format --branch`; otherwise
 *    `bad-branch`.
 *
 * Every function takes the app's resolved absolute root and runs git there.
 */

export type { GitErrorCode } from '@otherbench/core/types/code.js';

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const GIT_ENV_EXTRAS: Record<string, string> = {
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
};

/** Reads and short writes get the default; fetch/push/pull talk to a network, so they get longer. */
const NETWORK_TIMEOUT_MS = 120_000;

async function run(root: string, args: string[], opts: { timeoutMs?: number; okCodes?: number[] } = {}): Promise<RunResult> {
  let result: RunResult;
  try {
    result = await runProcess('git', ['--no-pager', '-c', 'core.quotepath=false', ...args], {
      cwd: root,
      env: { ...withoutServerSecrets(process.env), ...GIT_ENV_EXTRAS },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch (err) {
    if (err instanceof ExecutableMissingError) {
      throw new GitError('git-missing', 'Git is not installed, or is not on the PATH.');
    }
    throw err;
  }
  if (result.timedOut) throw new GitError('git-failed', `git ${args[0] ?? ''} timed out.`, result.stderr);
  if (result.code !== 0 && !(opts.okCodes ?? []).includes(result.code ?? -1)) {
    if (/not a git repository/i.test(result.stderr)) {
      throw new GitError('not-a-repo', 'This folder is not a git repository.', result.stderr);
    }
    throw new GitError('git-failed', firstLine(result.stderr) || `git ${args[0] ?? ''} failed.`, result.stderr);
  }
  return result;
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
}

/** containPath, then a root-relative, forward-slash pathspec ('.' for the root itself). */
function pathspec(root: string, candidate: string): string {
  let abs: string;
  try {
    abs = containPath(root, candidate);
  } catch {
    throw new GitError('bad-path', `"${candidate}" is outside the project folder.`);
  }
  const rel = relative(root, abs);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

async function checkBranch(root: string, name: string): Promise<void> {
  if (name === '' || name.startsWith('-')) throw new GitError('bad-branch', `"${name}" is not a valid branch name.`);
  const r = await runProcess('git', ['--no-pager', '-c', 'core.quotepath=false', 'check-ref-format', '--branch', name], {
    cwd: root,
    env: { ...withoutServerSecrets(process.env), ...GIT_ENV_EXTRAS },
  }).catch((err: unknown) => {
    if (err instanceof ExecutableMissingError) throw new GitError('git-missing', 'Git is not installed, or is not on the PATH.');
    throw err;
  });
  if (r.code !== 0) throw new GitError('bad-branch', `"${name}" is not a valid branch name.`, r.stderr);
}

async function hasHead(root: string): Promise<boolean> {
  const r = await runProcess('git', ['--no-pager', 'rev-parse', '--verify', '-q', 'HEAD'], {
    cwd: root,
    env: { ...withoutServerSecrets(process.env), ...GIT_ENV_EXTRAS },
  }).catch(() => null);
  return r?.code === 0;
}

/** A new file has no diff against HEAD; show it the way git would against an empty file. */
async function untrackedDiff(root: string, spec: string): Promise<string> {
  // `--no-index` exits 1 when the files differ, which is the normal case here.
  const r = await run(root, ['diff', '--no-index', '--', '/dev/null', spec], { okCodes: [1] });
  return r.stdout;
}

export const git = {
  async status(root: string): Promise<GitStatus> {
    const r = await run(root, ['status', '--porcelain=v2', '--branch', '-z']);
    return parseStatusV2(r.stdout);
  },

  async diff(root: string, path?: string): Promise<string> {
    const spec = path === undefined ? undefined : pathspec(root, path);
    const scope = spec === undefined ? [] : ['--', spec];
    // Unborn branch: there is no HEAD to compare to, so the staged diff is all there is.
    const base = (await hasHead(root)) ? ['diff', 'HEAD'] : ['diff', '--cached'];
    let out = (await run(root, [...base, ...scope])).stdout;

    const others = await run(root, ['ls-files', '--others', '--exclude-standard', '-z', ...scope]);
    for (const file of others.stdout.split('\0').filter((f) => f !== '')) {
      out += await untrackedDiff(root, file);
    }
    return out;
  },

  async commit(root: string, message: string, paths: string[] | 'all'): Promise<{ sha: string }> {
    if (message.trim() === '') throw new GitError('git-failed', 'A commit needs a message.');
    if (paths === 'all') {
      await run(root, ['add', '-A']);
      await run(root, ['commit', '-m', message]);
    } else {
      if (paths.length === 0) throw new GitError('git-failed', 'Choose at least one file to commit.');
      const specs = paths.map((p) => pathspec(root, p));
      await run(root, ['add', '--', ...specs]);
      await run(root, ['commit', '-m', message, '--', ...specs]);
    }
    const head = await run(root, ['rev-parse', 'HEAD']);
    return { sha: head.stdout.trim() };
  },

  async pull(root: string): Promise<{ output: string }> {
    const r = await run(root, ['pull', '--ff-only'], { timeoutMs: NETWORK_TIMEOUT_MS });
    return { output: (r.stdout + r.stderr).trim() };
  },

  async push(root: string, opts: { setUpstream?: boolean } = {}): Promise<{ output: string }> {
    const args = opts.setUpstream ? ['push', '-u', 'origin', 'HEAD'] : ['push'];
    const r = await run(root, args, { timeoutMs: NETWORK_TIMEOUT_MS });
    return { output: (r.stdout + r.stderr).trim() };
  },

  async branches(root: string): Promise<{ name: string; current: boolean }[]> {
    const r = await run(root, ['branch', '--format=%(HEAD)%00%(refname:short)']);
    return parseBranches(r.stdout);
  },

  async checkout(root: string, branch: string): Promise<void> {
    await checkBranch(root, branch);
    await run(root, ['switch', branch]);
  },

  async createBranch(root: string, branch: string): Promise<void> {
    await checkBranch(root, branch);
    await run(root, ['switch', '-c', branch]);
  },

  async remotes(root: string): Promise<{ name: string; url: string }[]> {
    const r = await run(root, ['remote', '-v']);
    return parseRemotes(r.stdout);
  },
};
