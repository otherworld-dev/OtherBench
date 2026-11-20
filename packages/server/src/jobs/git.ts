import { appendFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';
import { jobGitProblem, plantedCommandIn, plantedCommandReason } from '@otherbench/core/domain/job.js';
import { appRepoGitArgs, hardenedGitArgs, UNSAFE_GIT_ENV } from '@otherbench/core/domain/hardened-git.js';
import { ExecutableNotFoundError, resolveExecutable } from '@otherbench/tools/mcp/spawn.js';
import { runProcess, type RunResult } from '../code/process.js';

/**
 * Git on this machine for job folders (docs/features/jobs.md).
 * A job's sandboxed commands can write anything in its folder that the
 * sandbox doesn't protect, so every call here:
 *
 *   - starts the git found on PATH from OtherBench's own folder, never from
 *     the job folder (Windows would look for `git.exe` there first), and
 *     refuses a job folder whose top level holds a file that could stand in
 *     for a program (`plantedCommandIn`);
 *   - names the repository with `--git-dir`, after checking `.git` is a real
 *     folder (not a link, a junction or a `gitdir:` file pointing elsewhere),
 *     and never lets git look upwards for one;
 *   - runs with `hardenedGitArgs`: hooks from an empty folder, no
 *     fsmonitor, no credential helper, no ext:: protocol;
 *   - drops every environment variable that would steer git or start a
 *     program (`UNSAFE_GIT_ENV`), and turns prompts and the pager off.
 *
 * On a job folder only read-only commands that never read the working tree
 * run (`rev-parse`, `log`, `diff` between two commits with `--no-ext-diff
 * --no-textconv`), so no clean or smudge filter ever runs. The only other
 * calls are the clone that makes the folder (from the app's own repository,
 * before any job has touched it) and `fetchInto`, which fetches one branch
 * from the job folder into the app's repository and touches nothing else.
 */

/** A git ref name a job may use: letters, digits and `. _ / -`, as the contract allows, and nothing git would read as an option or a range. */
export function isSafeBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//') || name.split('/').some((s) => s === '' || s.startsWith('.'))) return false;
  return name !== 'HEAD' && name !== '@';
}

/** The sandbox's protected paths at a folder's top level (sandbox/resources/agent-core.mjs PROTECTED_PATHS), as exclude patterns. */
export const SANDBOX_PLACEHOLDERS: readonly string[] = [
  '/.gitconfig',
  '/.gitmodules',
  '/.bashrc',
  '/.bash_profile',
  '/.profile',
  '/.zshrc',
  '/.zprofile',
  '/.ripgreprc',
  '/.mcp.json',
  '/CLAUDE.md',
  '/CLAUDE.local.md',
  '/.vscode/',
  '/.idea/',
  '/.claude/',
];

/** A commit id as git prints it: lowercase hex, 7 to 64 characters. */
export const COMMIT_ID = /^[0-9a-f]{7,64}$/;

export class JobGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobGitError';
  }
}

export interface CommitSummary {
  sha: string;
  subject: string;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  text: string;
}

const MAX_COMMITS = 200;
const DIFFSTAT_TEXT_MAX = 20_000;
const MINUTE = 60_000;
/** The publish step's push and its ls-remote reads. */
const PUSH_TIMEOUT_MS = 120_000;
/** The base branch's fetch from the app's remote. */
const FETCH_TIMEOUT_MS = 90_000;

/** A git remote name OtherBench will pass to git: letters, digits and `. _ -`, not starting with `-` or `.`. */
export function isSafeRemoteName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name);
}

export interface JobGitOptions {
  /** OtherBench's own folder for job git: holds the empty hooks folder, and is every call's working folder. */
  root: string;
  /**
   * The first part of every job branch this JobGit makes, fetches or pushes (`<prefix>/<job id>`), fixed by
   * OtherBench for whoever uses it (an add-on gets its own). Lower case letters, digits and dashes.
   */
  branchPrefix: string;
  /** Tests: a runner in place of `runProcess`. */
  run?: typeof runProcess;
  /** Tests: the git to run. Defaults to the one on PATH. */
  gitPath?: string;
}

export class JobGit {
  readonly noHooksDir: string;
  private readonly root: string;
  private readonly run: typeof runProcess;
  private gitPath: string | null;
  readonly branchPrefix: string;

  constructor(o: JobGitOptions) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(o.branchPrefix)) throw new JobGitError(`"${o.branchPrefix}" is not a job branch prefix OtherBench accepts.`);
    this.branchPrefix = o.branchPrefix;
    this.root = o.root;
    this.noHooksDir = join(o.root, 'no-git-hooks');
    this.run = o.run ?? runProcess;
    this.gitPath = o.gitPath ?? null;
  }

  /**
   * The empty hooks folder, made if need be and emptied if anything is in it
   * (nothing but OtherBench should ever write there). Called before every use.
   */
  /** The branch a job's work goes on: `<prefix>/<job id>`. */
  jobBranchFor(jobId: string): string {
    return `${this.branchPrefix}/${jobId}`;
  }

  ensureNoHooksDir(): string {
    mkdirSync(this.noHooksDir, { recursive: true });
    for (const name of readdirSync(this.noHooksDir)) rmSync(join(this.noHooksDir, name), { recursive: true, force: true });
    return this.noHooksDir;
  }

  /** The environment every job git call gets: the server's minus its secrets and anything that steers git. */
  env(): Record<string, string> {
    const base = withoutServerSecrets(process.env);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) if (value !== undefined && !UNSAFE_GIT_ENV.test(key)) env[key] = value;
    return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never', NoDefaultCurrentDirectoryInExePath: '1' };
  }

  private git(): string {
    if (this.gitPath !== null) return this.gitPath;
    try {
      this.gitPath = resolveExecutable('git');
    } catch (err) {
      if (err instanceof ExecutableNotFoundError) throw new JobGitError('Git is not installed on this machine (it is not on PATH).');
      throw err;
    }
    return this.gitPath;
  }

  /** One git call: hardened, from OtherBench's own folder unless `cwd` (a folder OtherBench trusts) is given. */
  private async exec(args: string[], o: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    const noHooks = this.ensureNoHooksDir();
    return this.run(this.git(), [...hardenedGitArgs(noHooks), '--no-pager', ...args], { cwd: o.cwd ?? this.root, timeoutMs: o.timeoutMs ?? MINUTE, env: this.env() });
  }

  private async must(args: string[], what: string, o: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
    const r = await this.exec(args, o);
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `exit ${String(r.code)}`;
      throw new JobGitError(`${what} failed${r.timedOut ? ' (timed out)' : ''}: ${why}`);
    }
    return r.stdout;
  }

  /**
   * The job folder's `.git`, once it is known to be a real folder in a folder
   * whose top level holds nothing that could stand in for a program. Throws otherwise.
   */
  private gitDirOf(folder: string): string {
    const gitDir = join(folder, '.git');
    let st;
    try {
      st = lstatSync(gitDir);
    } catch {
      throw new JobGitError(`${folder} has no .git folder.`);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new JobGitError(`${folder}'s .git is not a plain folder, so OtherBench won't read it.`);
    const problem = jobGitProblem(folder);
    if (problem !== null) throw new JobGitError(problem);
    const planted = plantedCommandIn(readdirSync(folder));
    if (planted !== null) throw new JobGitError(plantedCommandReason(planted));
    return gitDir;
  }

  /** A read-only command on a job folder's repository, with no working tree. */
  private readJob(folder: string, args: string[]): Promise<string> {
    const gitDir = this.gitDirOf(folder);
    return this.must([`--git-dir=${gitDir}`, ...args], `git ${args[0] ?? ''}`);
  }

  /**
   * The commit a new job starts from, fresh where it can be: `baseBranch` is
   * fetched from the app repository's `remote` into that remote's
   * remote-tracking ref only (never a local branch, the working tree or a
   * checkout), with the user's own credentials, hooks and fsmonitor off, and
   * a time limit. If the fetch fails (offline, the remote down, no such
   * remote) the local branch is used instead, and the note says so. Runs
   * before any job has touched anything; both names are checked first, so no
   * text from a job ever reaches git as anything but a plain branch name.
   */
  async baseFor(o: { appRepo: string; remote: string; baseBranch: string }): Promise<{ commit: string; fetch: { ok: boolean; note: string } }> {
    if (!isSafeBranchName(o.baseBranch)) throw new JobGitError(`"${o.baseBranch}" is not a branch name OtherBench accepts.`);
    const short = (sha: string): string => sha.slice(0, 7);
    let why: string;
    if (!isSafeRemoteName(o.remote)) {
      why = `"${o.remote}" is not a remote name OtherBench accepts`;
    } else {
      const remotes = (await this.execApp(o.appRepo, ['remote'])).stdout.split(/\r?\n/).map((r) => r.trim());
      if (!remotes.includes(o.remote)) {
        why = `the app's repository has no remote called ${o.remote}`;
      } else {
        const tracking = `refs/remotes/${o.remote}/${o.baseBranch}`;
        const fetched = await this.execApp(o.appRepo, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--quiet', '--', o.remote, `+refs/heads/${o.baseBranch}:${tracking}`], FETCH_TIMEOUT_MS);
        if (fetched.code === 0) {
          const sha = (await this.execApp(o.appRepo, ['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`])).stdout.trim();
          if (COMMIT_ID.test(sha)) return { commit: sha, fetch: { ok: true, note: `${o.remote}/${o.baseBranch} at ${short(sha)}` } };
          why = `${tracking} couldn't be read after the fetch`;
        } else {
          why = fetched.timedOut ? 'the fetch timed out' : (fetched.stderr || fetched.stdout).trim().split(/\r?\n/).slice(-1)[0]?.slice(0, 300) || `the fetch failed (exit ${String(fetched.code)})`;
        }
      }
    }
    const local = (await this.execApp(o.appRepo, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.baseBranch}^{commit}`])).stdout.trim();
    if (!COMMIT_ID.test(local)) throw new JobGitError(`Couldn't fetch ${o.baseBranch} (${why}), and the app's repository has no local branch ${o.baseBranch} either.`);
    return { commit: local, fetch: { ok: false, note: `Couldn't fetch ${o.baseBranch} from ${o.remote} (${why}); started from the local branch at ${short(local)}.` } };
  }

  /** A call on the app's own repository: trusted, so its credentials work, but still no hook, fsmonitor or ext:: protocol. */
  private async execApp(appRepo: string, args: string[], timeoutMs = MINUTE, env: Record<string, string> = {}): Promise<RunResult> {
    const noHooks = this.ensureNoHooksDir();
    return this.run(this.git(), [...appRepoGitArgs(noHooks), '--no-pager', '-C', appRepo, ...args], { cwd: this.root, timeoutMs, env: { ...this.env(), ...env } });
  }

  /**
   * Makes a job's folder: a local clone of the app's repository (objects
   * copied, never hard-linked, so nothing the job does to them reaches the
   * app's repository), checked out as LF as stored, on a new branch cut at
   * `startCommit` (from `baseFor`), with no remotes, and committing as the
   * app's repository does. `dest` must not exist yet. Returns the base commit.
   */
  async cloneForJob(o: { source: string; dest: string; startCommit: string; branch: string }): Promise<{ baseCommit: string }> {
    if (!isSafeBranchName(o.branch)) throw new JobGitError(`"${o.branch}" is not a branch name OtherBench accepts.`);
    assertCommit(o.startCommit);
    await this.must(['-C', o.source, 'cat-file', '-e', `${o.startCommit}^{commit}`], "Finding the base commit in the app's repository");
    mkdirSync(dirname(o.dest), { recursive: true });
    await this.must(['clone', '--local', '--no-hardlinks', '--no-checkout', '--no-tags', '--config', 'core.autocrlf=false', '--', o.source, o.dest], 'Cloning the app', {
      cwd: dirname(o.dest),
      timeoutMs: 10 * MINUTE,
    });
    const name = (await this.exec(['-C', o.source, 'config', '--get', 'user.name'])).stdout.trim() || 'OtherBench';
    const email = (await this.exec(['-C', o.source, 'config', '--get', 'user.email'])).stdout.trim() || 'otherbench@localhost';
    const gitDir = this.gitDirOf(o.dest);
    const inDest = (args: string[]): string[] => [`--git-dir=${gitDir}`, `--work-tree=${o.dest}`, ...args];
    await this.must(inDest(['checkout', '-q', '-b', o.branch, o.startCommit]), `Making branch ${o.branch}`, { cwd: dirname(o.dest) });
    for (const remote of (await this.must(inDest(['remote']), 'Listing remotes')).split('\n').map((r) => r.trim()).filter(Boolean)) {
      await this.must(inDest(['remote', 'remove', '--', remote]), `Removing remote ${remote}`);
    }
    await this.must(inDest(['config', 'user.name', name]), 'Setting the commit name');
    await this.must(inDest(['config', 'user.email', email]), 'Setting the commit email');
    // While a sandboxed command runs, the sandbox puts placeholders over the protected paths it keeps the command
    // off (.gitconfig, .bashrc, CLAUDE.md, .vscode…), which git there sees as new files: kept out of `git add -A`.
    appendFileSync(join(gitDir, 'info', 'exclude'), `\n# Sandbox placeholders (OtherBench, job)\n${SANDBOX_PLACEHOLDERS.join('\n')}\n`);
    const baseCommit = (await this.readJob(o.dest, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (!COMMIT_ID.test(baseCommit)) throw new JobGitError(`git gave an odd base commit: ${baseCommit.slice(0, 80)}`);
    return { baseCommit };
  }

  /** The commit a branch of the job folder is at, or null when it has none. */
  async headOf(folder: string, branch: string): Promise<string | null> {
    if (!isSafeBranchName(branch)) throw new JobGitError(`"${branch}" is not a branch name OtherBench accepts.`);
    const gitDir = this.gitDirOf(folder);
    const r = await this.exec([`--git-dir=${gitDir}`, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    const sha = r.stdout.trim();
    return r.code === 0 && COMMIT_ID.test(sha) ? sha : null;
  }

  /** The commits on `head` that `base` doesn't have, newest first, at most 200. */
  async commits(folder: string, base: string, head: string): Promise<CommitSummary[]> {
    assertCommit(base);
    assertCommit(head);
    const out = await this.readJob(folder, ['log', '--no-decorate', '--no-show-signature', '--no-color', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%s', `${base}..${head}`]);
    return out
      .split('\n')
      .filter((line) => line.includes('\x1f'))
      .map((line) => {
        const [sha = '', subject = ''] = line.split('\x1f');
        return { sha: sha.trim(), subject: subject.trim() };
      })
      .filter((c) => COMMIT_ID.test(c.sha));
  }

  /** `diff --stat base...head`, with its totals. Two commits only: the working tree is never read. */
  async diffstat(folder: string, base: string, head: string): Promise<DiffStat> {
    assertCommit(base);
    assertCommit(head);
    const range = `${base}...${head}`;
    const numstat = await this.readJob(folder, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--numstat', range]);
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      files += 1;
      if (m[1] !== '-') insertions += Number(m[1]);
      if (m[2] !== '-') deletions += Number(m[2]);
    }
    const text = await this.readJob(folder, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--stat=120', '--stat-count=200', range]);
    return { files, insertions, deletions, text: text.length > DIFFSTAT_TEXT_MAX ? `${text.slice(0, DIFFSTAT_TEXT_MAX)}\n... cut` : text.trimEnd() };
  }

  /**
   * The repository's own rules: `CLAUDE.md` and `.claude/CLAUDE.md` as they are
   * in `commit`, read as objects (`cat-file blob`: never the working tree, which
   * the job can change, and no filter), with the files they import by `@path`
   * (Claude Code's syntax, outside code), resolved inside the same commit and
   * the repository only, up to four imports deep, all within `max` characters.
   * Null when the commit has neither file.
   */
  async repoRules(folder: string, commit: string, max = RULES_MAX): Promise<{ text: string; files: string[]; cut: boolean } | null> {
    assertCommit(commit);
    const gitDir = this.gitDirOf(folder);
    const read = async (path: string): Promise<string | null> => {
      const r = await this.exec([`--git-dir=${gitDir}`, 'cat-file', 'blob', `${commit}:${path}`]);
      return r.code === 0 ? r.stdout : null;
    };
    const parts: string[] = [];
    const files: string[] = [];
    const seen = new Set<string>();
    let size = 0;
    let cut = false;
    const add = async (path: string, from: string | null, depth: number): Promise<void> => {
      if (cut || seen.has(path) || depth > 4) return;
      seen.add(path);
      const text = await read(path);
      if (text === null) return;
      files.push(path);
      const heading = `### ${path}${from ? ` (imported by ${from})` : ''}\n\n`;
      const room = max - size - heading.length;
      if (room <= 0) {
        cut = true;
        return;
      }
      const body = text.length > room ? text.slice(0, room) : text;
      if (body.length < text.length) cut = true;
      parts.push(`${heading}${body.trimEnd()}`);
      size += heading.length + body.length;
      for (const imported of importsOf(text)) {
        const resolved = resolveImport(path, imported);
        if (resolved !== null) await add(resolved, path, depth + 1);
      }
    };
    await add('CLAUDE.md', null, 0);
    await add('.claude/CLAUDE.md', null, 0);
    return files.length === 0 ? null : { text: parts.join('\n\n'), files, cut };
  }

  /**
   * Publishes a finished job's branch (docs/features/jobs.md,
   * "Publishing"): the job folder's `branch` must be exactly at `headCommit`;
   * that commit is fetched into the app repository under a private ref
   * (`refs/otherbench-jobs/<prefix>/<jobId>`: no local branch, no checkout, no working tree or
   * index touched, hooks off, verified after) and pushed from there to
   * `remote` as `refs/heads/<branch>` and nothing else: no tags, no other
   * refs, no submodules, no push options, no LFS, hooks off, no prompt, a time
   * limit. Never forced: the push carries a lease that the remote ref must not
   * exist, so it can only ever create it; one already at `headCommit` is
   * "already there", one at any other commit is refused. The remote ref is read
   * back before success is claimed. `remote` must be one of the app
   * repository's own remotes; the branch is OtherBench's own (`<prefix>/<id>`),
   * and nothing here takes a ref, remote or URL from the job.
   */
  async publish(o: { appRepo: string; folder: string; jobId: string; branch: string; headCommit: string; remote: string }): Promise<{ ok: true; already: boolean } | { ok: false; note: string }> {
    const fail = (note: string): { ok: false; note: string } => ({ ok: false, note: scrubCredentials(note).slice(0, 1000) });
    if (!/^[a-z0-9]{10,40}$/.test(o.jobId)) return fail('The job id is not one OtherBench accepts.');
    if (!isSafeBranchName(o.branch) || o.branch !== this.jobBranchFor(o.jobId)) return fail(`"${o.branch}" is not a job branch.`);
    if (!COMMIT_ID.test(o.headCommit) || o.headCommit.length !== 40) return fail('The commit to push is not a full commit id.');
    if (!isSafeRemoteName(o.remote)) return fail(`"${o.remote}" is not a remote name OtherBench accepts.`);
    const remotes = (await this.execApp(o.appRepo, ['remote'])).stdout.split(/\r?\n/).map((r) => r.trim());
    if (!remotes.includes(o.remote)) return fail(`The app's repository has no remote called ${o.remote}.`);

    // 3. The job folder's branch is exactly the reviewed commit (guarded, object-level, no working tree).
    let tip: string | null;
    try {
      tip = await this.headOf(o.folder, o.branch);
    } catch (err) {
      return fail(`The job folder couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (tip === null) return fail(`The job folder has no branch ${o.branch}.`);
    if (tip !== o.headCommit) return fail(`${o.branch} in the job folder is at ${tip.slice(0, 7)}, not the reviewed ${o.headCommit.slice(0, 7)}: it moved after the result was sent, so nothing was pushed.`);

    // 4. Into the app repository, under a private ref only: fetched, never checked out or merged.
    const privateRef = `refs/otherbench-jobs/${this.branchPrefix}/${o.jobId}`;
    const gitDir = this.gitDirOf(o.folder);
    const fetched = await this.exec(['-C', o.appRepo, 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--quiet', '--', gitDir, `+refs/heads/${o.branch}:${privateRef}`], { timeoutMs: 5 * MINUTE });
    if (fetched.code !== 0) return fail(`Fetching ${o.branch} from the job folder failed: ${(fetched.stderr || fetched.stdout).trim().slice(-300)}`);
    const inApp = (await this.execApp(o.appRepo, ['rev-parse', '--verify', '--quiet', `${privateRef}^{commit}`])).stdout.trim();
    if (inApp !== o.headCommit) return fail(`The fetched ${privateRef} is at ${inApp.slice(0, 7) || 'nothing'}, not ${o.headCommit.slice(0, 7)}.`);

    // 5. The remote's ref first: there at the commit is success, there at anything else is refused.
    const dest = `refs/heads/${o.branch}`;
    const before = await this.remoteRef(o.appRepo, o.remote, dest);
    if ('error' in before) return fail(before.error);
    if (before.sha === o.headCommit) return { ok: true, already: true };
    if (before.sha !== null) return fail(`${o.remote} already has ${o.branch} at ${before.sha.slice(0, 7)}, not ${o.headCommit.slice(0, 7)}. OtherBench never overwrites a branch, so nothing was pushed.`);
    const pushed = await this.execApp(
      o.appRepo,
      [
        '-c', 'push.followTags=false',
        '-c', 'push.recurseSubmodules=no',
        '-c', 'push.pushOption=',
        '-c', 'push.gpgSign=false',
        'push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--no-signed',
        `--force-with-lease=${dest}:`,
        '--', o.remote, `${o.headCommit}:${dest}`,
      ],
      PUSH_TIMEOUT_MS,
      { GIT_LFS_SKIP_PUSH: '1' }
    );
    if (pushed.code !== 0) {
      return fail(`Pushing to ${o.remote} failed${pushed.timedOut ? ' (timed out)' : ''}: ${(pushed.stderr || pushed.stdout).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 600)}`);
    }

    // 6. Read back: success only if the remote has it at exactly the commit.
    const after = await this.remoteRef(o.appRepo, o.remote, dest);
    if ('error' in after) return fail(`The push seemed to work, but ${o.remote} couldn't be read back: ${after.error}`);
    if (after.sha !== o.headCommit) return fail(`After the push ${o.remote} has ${o.branch} at ${after.sha?.slice(0, 7) ?? 'nothing'}, not ${o.headCommit.slice(0, 7)}.`);
    return { ok: true, already: false };
  }

  /** One ref on a remote, by `ls-remote` (the user's own credentials, hooks off). `sha` null when it isn't there. */
  private async remoteRef(appRepo: string, remote: string, ref: string): Promise<{ sha: string | null } | { error: string }> {
    const r = await this.execApp(appRepo, ['ls-remote', '--refs', '--', remote, ref], PUSH_TIMEOUT_MS);
    if (r.code !== 0) return { error: `Reading ${ref} on ${remote} failed${r.timedOut ? ' (timed out)' : ''}: ${scrubCredentials((r.stderr || r.stdout).trim()).slice(-300)}` };
    for (const line of r.stdout.split(/\r?\n/)) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha && COMMIT_ID.test(sha)) return { sha };
    }
    return { sha: null };
  }

  /**
   * Fetches `branch` from the job folder into the app's repository, as a
   * branch of the same name, fast-forward only. Never checks it out and never
   * merges it. The app's repository is OtherBench's to trust; the job folder
   * only serves its objects (git's upload-pack ignores a repository's own
   * pack hooks), and is checked as every job git call checks it.
   */
  async fetchInto(o: { appRepo: string; folder: string; branch: string }): Promise<string> {
    if (!isSafeBranchName(o.branch) || !o.branch.startsWith(`${this.branchPrefix}/`)) throw new JobGitError(`"${o.branch}" is not a job branch.`);
    this.gitDirOf(o.folder);
    await this.must(['-C', o.appRepo, 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--', o.folder, `refs/heads/${o.branch}:refs/heads/${o.branch}`], `Fetching ${o.branch}`, {
      timeoutMs: 5 * MINUTE,
    });
    const sha = (await this.must(['-C', o.appRepo, 'rev-parse', '--verify', `refs/heads/${o.branch}^{commit}`], 'Reading the fetched branch')).trim();
    if (!COMMIT_ID.test(sha)) throw new JobGitError('git gave an odd commit for the fetched branch.');
    return sha;
  }
}

/** The most of the repository's own rules a job's message carries. */
export const RULES_MAX = 16_000;

/** The `@path` imports in a CLAUDE.md, outside fenced code and inline code, as Claude Code reads them. */
export function importsOf(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const plain = line.replace(/`[^`]*`/g, '');
    for (const m of plain.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      const path = (m[1] ?? '').replace(/[),.;:]+$/, '');
      if (path) out.push(path);
    }
  }
  return out;
}

/**
 * An import's path in the repository, relative to the importing file's folder,
 * or null when it points outside the repository (home, absolute, `..` past the
 * top) or isn't a plain path.
 */
export function resolveImport(from: string, imported: string): string | null {
  if (imported.startsWith('~') || imported.startsWith('/') || /^[A-Za-z]:/.test(imported) || imported.includes('\\') || imported.includes(':')) return null;
  const segments = from.split('/').slice(0, -1);
  for (const s of imported.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(s);
  }
  const path = segments.join('/');
  return path === '' ? null : path;
}

/** A URL's user and password, as git can print them in an error (`https://user:token@host/…`), masked. */
export function scrubCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@');
}

function assertCommit(sha: string): void {
  if (!COMMIT_ID.test(sha)) throw new JobGitError(`"${sha.slice(0, 80)}" is not a commit id.`);
}

/**
 * Hosts the install command may reach, for that step only: package
 * registries, and the GitHub download hosts Composer fetches packages from.
 * The job's own turn and its test command reach nothing.
 */
export const INSTALL_HOSTS: readonly string[] = [
  'registry.npmjs.org',
  'repo.packagist.org',
  'packagist.org',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
];
