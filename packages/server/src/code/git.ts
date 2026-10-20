import { realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';
import { containPath } from '@otherbench/core/domain/paths.js';
import type { GitErrorCode, GitStatus } from '@otherbench/core/types/code.js';
import { ExecutableNotFoundError, resolveExecutable } from '@otherbench/tools/mcp/spawn.js';
import { parseBranches, parseRemotes, parseStatusV2, redactUrls } from './git-parse.js';
import { ExecutableMissingError, runProcess, STDOUT_CAP_BYTES, type RunResult } from './process.js';

/**
 * The Code tab's git service (spec 2026-10-20-code-tab-design, Goal 2): the
 * machine's own `git`, run as fixed argv lists. Nothing the UI sends is ever
 * spliced into a command line:
 *
 *  - Every call goes through run(), which prepends one fixed prefix (GIT_PREFIX)
 *    and one environment (gitEnv), and spawns without a shell. Nothing here has
 *    a terminal to answer a prompt or page, so those are switched off.
 *  - A file path from the UI goes through containPath against the app's
 *    resolved root, then is handed to git after a `--` as a literal pathspec,
 *    so it can only ever be a file, never an option or a pattern. A path that
 *    escapes is `bad-path`.
 *  - A branch name is refused if empty or starting with `-` (it would be read as
 *    an option) and must pass `git check-ref-format --branch`; otherwise
 *    `bad-branch`.
 *  - The app's folder must be its repository's top level (requireTopLevel).
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

/**
 * Variables that would point git at some other repository, index, object store
 * or configuration than the app's folder. A server started from inside a git
 * hook, or with GIT_DIR exported, must not let that redirect the Code tab.
 * Matched in any letter case (Windows treats names that way). GIT_CONFIG*
 * (GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM...)
 * is dropped as a whole family.
 */
const GIT_STRIPPED_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);

/** The environment every git process gets: the server's, minus its secrets and repo-redirecting variables, plus the no-prompt settings. */
export function gitEnv(base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(withoutServerSecrets(base))) {
    const upper = name.toUpperCase();
    if (GIT_STRIPPED_ENV.has(upper) || upper.startsWith('GIT_CONFIG')) continue;
    out[name] = value;
  }
  return { ...out, ...GIT_ENV_EXTRAS };
}

/**
 * The one fixed prefix on every git call: no pager; literal pathspecs, so a
 * file named `[a].txt` or `*.md` is that file and not a pattern; unquoted
 * paths; no fsmonitor, which a repo's config could otherwise use to run a
 * program on every `status`; no colour codes. Hooks and clean/smudge filters
 * stay enabled, as when the user runs git in a terminal (a documented known
 * gap, not closed here).
 */
const GIT_PREFIX = [
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'color.ui=false',
];

/** Reads and short writes get the default; fetch/push/pull talk to a network, so they get longer. */
const NETWORK_TIMEOUT_MS = 120_000;
/** Most untracked files a whole-tree diff will spawn git for. */
const MAX_UNTRACKED_DIFFS = 200;
const UNTRACKED_PARALLELISM = 8;
export const DIFF_TRUNCATED_MARKER = '... diff truncated';
const NOT_A_REPO = 'Not a git repository (the app folder must be the top folder of its repository)';

let gitExe: string | undefined;
/** Resolved once per process: `where` is a synchronous spawn, too slow to repeat for every call. */
function gitExecutable(): string {
  if (gitExe === undefined) {
    try {
      gitExe = resolveExecutable('git');
    } catch (err) {
      if (err instanceof ExecutableNotFoundError) throw gitMissing();
      throw err;
    }
  }
  return gitExe;
}

function gitMissing(): GitError {
  return new GitError('git-missing', 'Git is not installed, or is not on the PATH.');
}

/** Every git invocation goes through here, so the prefix, environment and error mapping are applied exactly once. */
async function run(root: string, args: string[], opts: { timeoutMs?: number; okCodes?: number[] } = {}): Promise<RunResult> {
  const exe = gitExecutable();
  let result: RunResult;
  try {
    result = await runProcess(exe, [...GIT_PREFIX, ...args], {
      cwd: root,
      env: gitEnv(),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch (err) {
    if (err instanceof ExecutableMissingError) throw gitMissing();
    // A .cmd/.bat shim that cannot be spawned directly (EINVAL), EACCES, and the like.
    const reason = err instanceof Error ? err.message : String(err);
    throw new GitError('git-failed', `Could not start git: ${redactUrls(reason)}`);
  }
  if (result.timedOut) throw new GitError('git-failed', `git ${args[0] ?? ''} timed out.`, redactUrls(result.stderr));
  if (result.code !== 0 && !(opts.okCodes ?? []).includes(result.code ?? -1)) {
    const stderr = redactUrls(result.stderr);
    if (/not a git repository/i.test(stderr)) throw new GitError('not-a-repo', NOT_A_REPO, stderr);
    throw new GitError('git-failed', firstLine(stderr) || `git ${args[0] ?? ''} failed.`, stderr);
  }
  return result;
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
}

const canonical = (p: string): string => {
  const real = realpathSync.native(p);
  return process.platform === 'win32' ? real.toLowerCase() : real;
};

/**
 * The app's folder must be its repository's top level. git would otherwise
 * quietly work on a parent repository when the app folder is a plain folder
 * inside one, committing and diffing files the app never owned.
 */
async function requireTopLevel(root: string): Promise<void> {
  const r = await run(root, ['rev-parse', '--show-toplevel']);
  let same = false;
  try {
    same = canonical(r.stdout.trim()) === canonical(root);
  } catch {
    same = false;
  }
  if (!same) throw new GitError('not-a-repo', NOT_A_REPO);
}

/**
 * containPath is only the yes/no check. What git receives is the path as the
 * user wrote it, relative to the root as given, with `/` separators:
 * containPath returns the symlink-resolved target, which would make git act on
 * a link's target, and would not even be relative to the root when the root
 * itself is reached through a junction.
 */
function pathspec(root: string, candidate: string): string {
  try {
    containPath(root, candidate);
  } catch {
    throw new GitError('bad-path', `"${candidate}" is outside the project folder.`);
  }
  const rel = relative(resolve(root), resolve(root, candidate));
  return rel === '' ? '.' : rel.split(sep).join('/');
}

async function checkBranch(root: string, name: string): Promise<void> {
  if (name === '' || name.startsWith('-')) throw new GitError('bad-branch', `"${name}" is not a valid branch name.`);
  const r = await run(root, ['check-ref-format', '--branch', name], { okCodes: [1, 128] });
  if (r.code !== 0) throw new GitError('bad-branch', `"${name}" is not a valid branch name.`, r.stderr);
}

async function hasHead(root: string): Promise<boolean> {
  const r = await run(root, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1] });
  return r.code === 0;
}

/**
 * Flags every diff here passes. The `a/`/`b/` prefixes are pinned because the
 * web's `parseUnifiedDiff` reads paths from them, and a user's
 * `diff.mnemonicPrefix` (`i/`, `w/`, `c/`) or `diff.noprefix` would otherwise
 * change them (spec 2026-10-20-code-tab-design, Goal 2: the git panel shows
 * each file's real diff).
 */
const DIFF_FLAGS = ['diff', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

/** A new file has no diff against HEAD; show it the way git would against an empty file. */
async function untrackedDiff(root: string, spec: string): Promise<string> {
  // `--no-index` exits 1 when the files differ, which is the normal case here.
  const r = await run(root, [...DIFF_FLAGS, '--no-index', '--', '/dev/null', spec], { okCodes: [1] });
  return r.stdout;
}

export const git = {
  async status(root: string): Promise<GitStatus> {
    await requireTopLevel(root);
    const r = await run(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z']);
    // A cut-off record would parse as a wrong path; refuse rather than show half a list.
    if (r.truncated) throw new GitError('git-failed', 'status output too large');
    return parseStatusV2(r.stdout);
  },

  /**
   * Unified diff vs HEAD, staged changes included, plus untracked files. The
   * whole result is bounded: stdout is capped, at most MAX_UNTRACKED_DIFFS
   * untracked files are diffed, and a cut ends with DIFF_TRUNCATED_MARKER so
   * the UI can say so.
   */
  async diff(root: string, path?: string): Promise<string> {
    await requireTopLevel(root);
    const spec = path === undefined ? undefined : pathspec(root, path);
    const scope = spec === undefined ? [] : ['--', spec];
    // Unborn branch: there is no HEAD to compare to, so the staged diff is all there is.
    const base = (await hasHead(root)) ? [...DIFF_FLAGS, 'HEAD'] : [...DIFF_FLAGS, '--cached'];
    const tracked = await run(root, [...base, ...scope]);
    let out = tracked.stdout;
    let truncated = tracked.truncated;

    const others = await run(root, ['ls-files', '--others', '--exclude-standard', '-z', ...scope]);
    // Entries ending in "/" are untracked nested repositories, not files.
    const files = others.stdout.split('\0').filter((f) => f !== '' && !f.endsWith('/'));
    const over = files.length > MAX_UNTRACKED_DIFFS;
    let cut = false;
    const wanted = files.slice(0, MAX_UNTRACKED_DIFFS);
    for (let i = 0; i < wanted.length && !cut; i += UNTRACKED_PARALLELISM) {
      const parts = await Promise.all(wanted.slice(i, i + UNTRACKED_PARALLELISM).map((f) => untrackedDiff(root, f)));
      for (const part of parts) {
        if (Buffer.byteLength(out) + Buffer.byteLength(part) > STDOUT_CAP_BYTES) {
          cut = true;
          break;
        }
        out += part;
      }
    }
    if (!truncated && !cut && !over) return out;
    return `${out}${out === '' || out.endsWith('\n') ? '' : '\n'}${DIFF_TRUNCATED_MARKER}\n`;
  },

  async commit(root: string, message: string, paths: string[] | 'all'): Promise<{ sha: string }> {
    if (message.trim() === '') throw new GitError('git-failed', 'A commit needs a message.');
    await requireTopLevel(root);
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
    await requireTopLevel(root);
    const r = await run(root, ['pull', '--ff-only'], { timeoutMs: NETWORK_TIMEOUT_MS });
    return { output: redactUrls((r.stdout + r.stderr).trim()) };
  },

  async push(root: string, opts: { setUpstream?: boolean } = {}): Promise<{ output: string }> {
    await requireTopLevel(root);
    const args = opts.setUpstream ? ['push', '-u', 'origin', 'HEAD'] : ['push'];
    const r = await run(root, args, { timeoutMs: NETWORK_TIMEOUT_MS });
    return { output: redactUrls((r.stdout + r.stderr).trim()) };
  },

  async branches(root: string): Promise<{ name: string; current: boolean }[]> {
    await requireTopLevel(root);
    const r = await run(root, ['branch', '--format=%(HEAD)%00%(refname:short)']);
    return parseBranches(r.stdout);
  },

  async checkout(root: string, branch: string): Promise<void> {
    await requireTopLevel(root);
    await checkBranch(root, branch);
    await run(root, ['switch', branch]);
  },

  async createBranch(root: string, branch: string): Promise<void> {
    await requireTopLevel(root);
    await checkBranch(root, branch);
    await run(root, ['switch', '-c', branch]);
  },

  async remotes(root: string): Promise<{ name: string; url: string }[]> {
    await requireTopLevel(root);
    const r = await run(root, ['remote', '-v']);
    return parseRemotes(r.stdout);
  },
};
