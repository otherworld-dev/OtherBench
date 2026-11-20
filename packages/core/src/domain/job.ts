/**
 * Job chats (docs/features/jobs.md): the fixed rules a job chat runs
 * under, whatever profile, app or request says otherwise.
 *
 * A job's brief can carry text strangers wrote (an issue on a public
 * repository, say), so a job chat is treated as running untrusted
 * instructions. Nothing here trusts the model: the policy is a constant
 * applied by `TurnRunner` to every turn in a job chat (it is never stored, so
 * no profile edit can weaken it), and the broker's job rules
 * (`permissions/job.ts`) refuse what a job may never do before any grant,
 * card or classifier is consulted.
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathSegments } from './agent-tools.js';
import type { ResolvedProfile, ToolPolicy } from '../types/config.js';

/**
 * The policy every turn in a job chat runs under. File tools read and write
 * the job folder (through `containPath`, as always); the shell is the
 * sandboxed `run_command`, with no host on its allowlist; everything that
 * reaches past the folder (MCP, web, the browser, computer use, recall,
 * other chats, artifacts, sub-agents, generation, the user's own Claude
 * Code settings) is off.
 */
export const JOB_POLICY: Readonly<ToolPolicy> = Object.freeze({
  fs: 'readwrite',
  shell: true,
  shellRuns: 'sandbox',
  sandboxHosts: Object.freeze([]) as unknown as string[],
  mcpServerIds: Object.freeze([]) as unknown as string[],
  approvalMode: 'ask_on_mutate',
  agentWeb: false,
  agentMcp: false,
  agentUserSettings: false,
  artifacts: false,
  recall: false,
  chatMessages: false,
  subagents: false,
  browser: false,
  computer: false,
});

/** A fresh, mutable copy of the job policy (callers may hand it on to code that copies or spreads it). */
export function jobPolicy(): ToolPolicy {
  return { ...JOB_POLICY, sandboxHosts: [], mcpServerIds: [] };
}

/**
 * The profile a job turn runs as: the chosen profile's connection, model and
 * model parameters, with the job policy and none of its own instructions,
 * global memory or browser sites.
 */
export function jobProfile(profile: ResolvedProfile): ResolvedProfile {
  return { ...profile, systemPrompt: null, toolPolicy: jobPolicy(), useGlobalMemory: false, browserAllowedSites: [] };
}

/**
 * Files a job may never write, by any tool: anything under a `.git` or
 * `.claude` folder, Claude Code's own config files, and the files the
 * sandbox protects because something on Windows runs them when the folder is
 * next used (git, VS Code, JetBrains, the shell). Matched per segment the way
 * Windows opens a name (case, trailing dots and spaces, NTFS streams), and
 * any segment that looks like an 8.3 short name counts too, since it could
 * be any of these.
 */
const PROTECTED_FOLDERS = new Set(['.git', '.claude', '.vscode', '.idea']);
const PROTECTED_FILES = new Set([
  '.gitmodules',
  '.gitconfig',
  '.mcp.json',
  'claude.md',
  'claude.local.md',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.ripgreprc',
]);

/** Whether a path relative to the job folder is one a job may never write (see PROTECTED_FOLDERS/FILES). */
export function isJobProtectedPath(relPath: string): boolean {
  const segments = pathSegments(relPath);
  if (segments.length === 0) return true;
  if (segments.some((s) => /~\d/.test(s))) return true;
  if (segments.some((s) => PROTECTED_FOLDERS.has(s))) return true;
  const last = segments[segments.length - 1] ?? '';
  return PROTECTED_FILES.has(last);
}

/**
 * Programs Claude Code or OtherBench may start by bare name on this machine
 * while a job folder is the working folder. Windows looks in the working
 * folder before PATH, so a job's sandboxed command could plant one there
 * (`git.exe`) for this machine to run. Matched without case, bare or with an
 * extension Windows runs.
 */
const SPAWNED_BY_NAME = ['git', 'where', 'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'node', 'npm', 'npx', 'gh', 'rg', 'claude', 'wsl', 'reg', 'findstr', 'tasklist', 'taskkill', 'wmic', 'code', 'cygpath', 'uname', 'git-lfs', 'ssh'];
/**
 * Extensions Windows runs a bare name with: the default PATHEXT, plus this
 * machine's own. Observed 2026-11-20 (docs/features/jobs.md, fix 1):
 * cmd.exe ran a planted `git.com` from the working folder for `git`, while
 * Claude Code runs git by absolute path and Node's spawn never looks there.
 */
const PATHEXT = [
  ...new Set(['.com', '.exe', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msc', '.py', '.pyw', '.cpl', ...(process.env['PATHEXT'] ?? '').toLowerCase().split(';').filter((e) => /^\.[a-z0-9]{1,8}$/.test(e))]),
];
const RUNNABLE = new RegExp(`^(.+?)(${PATHEXT.map((e) => e.replace('.', '\\.')).join('|')})?$`, 'i');

/** The first entry of a folder's top level that could stand in for a program started by name (see SPAWNED_BY_NAME), or null. */
export function plantedCommandIn(names: readonly string[]): string | null {
  for (const name of names) {
    const base = RUNNABLE.exec(name.replace(/[. ]+$/, ''))?.[1]?.toLowerCase();
    if (base !== undefined && SPAWNED_BY_NAME.includes(base)) return name;
  }
  return null;
}

/** Why a job's folder can't be used while it holds such a file. */
export function plantedCommandReason(name: string): string {
  return `This job's folder has a file named ${name} at its top level, which Windows could run in place of the real program. OtherBench won't start anything in it until the file is gone.`;
}

/**
 * Entries in a job folder's `.git` that send git to config or a repository somewhere else: `commondir` (git reads
 * config, and more, from the folder it names, in any repository, not only a linked worktree), `config.worktree`, and
 * `worktrees`. None is in a clone OtherBench made, and the sandbox only guards `.git/config` and `.git/hooks` itself,
 * so a command in a job could plant one, and the next host git in the folder (Claude Code's own, at a turn's start)
 * would then run a filter or pager that config names.
 */
export const JOB_GIT_REDIRECTS: readonly string[] = ['commondir', 'config.worktree', 'worktrees'];

/**
 * Why a job folder's `.git` can't be trusted for host git, or null when it is a plain folder (or there is none).
 * A `.git` file (`gitdir:` pointing elsewhere) or a link is refused, as is any entry in JOB_GIT_REDIRECTS.
 */
export function jobGitProblem(folder: string): string | null {
  const dotGit = join(folder, '.git');
  let st;
  try {
    st = lstatSync(dotGit);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return "This job's folder has a .git that isn't a plain folder, so OtherBench won't run git there.";
  for (const name of JOB_GIT_REDIRECTS) {
    try {
      lstatSync(join(dotGit, name));
    } catch {
      continue;
    }
    return `This job's folder has .git/${name}, which sends git somewhere OtherBench doesn't guard, so it won't run git there.`;
  }
  return null;
}

/** What a refused write in a job chat tells the model. */
export function jobProtectedReason(path: string): string {
  return `jobs can't change ${path}: files under .git and .claude, and editor, shell and Claude Code config files, are off limits in a job.`;
}

/** What any other refused call in a job chat tells the model. */
export const JOB_TOOL_REFUSAL =
  'This is a job: only the file tools in this folder, run_command in the sandbox, and the checklist and status tools are available. Do the work with those.';

/** A sandboxed command's network request in a job chat. */
export const JOB_NETWORK_REFUSAL = "This is a job: commands in the sandbox can't reach the network. Work with what is in the folder.";
