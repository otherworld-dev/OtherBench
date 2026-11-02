import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { containPath } from '@otherbench/core/domain/paths.js';
import type { ResolvedFolder } from '@otherbench/core/types/workspace.js';

/**
 * The user's own skills and installed plugins (their skills among them), as
 * read-only folders for a Claude Code reply. A skill reads its own files
 * (references, standards, templates) by the absolute path Claude Code gives it,
 * which is outside the chat's folder and would otherwise be refused. Only
 * `skills/` and `plugins/cache/` of the Claude config folder, never the folder
 * itself, which holds the login. A folder that doesn't exist is left out, and
 * so is one inside the workspace, which already reaches it: a deeper read-only
 * folder would win there and stop writes to it.
 */
export function claudeSkillFolders(env: NodeJS.ProcessEnv, workspaceRoot: string, home: string = homedir()): ResolvedFolder[] {
  const configDir = claudeConfigDir(env, home);
  return [join(configDir, 'skills'), join(configDir, 'plugins', 'cache')]
    .filter((root) => existsSync(root) && !inside(workspaceRoot, root))
    .map((root) => ({ root, access: 'read' as const }));
}

/**
 * Claude Code's own folder for the chat's workspace, `projects/<name>` in the
 * Claude config folder, where it keeps the workspace's transcripts and its
 * auto memory. Its `memory/` may be written, so Claude Code can keep its notes
 * as it does outside OtherBench; the rest is read-only, so a transcript Claude
 * Code would resume can't be forged. Given whether or not it exists yet
 * (Claude Code makes it when the process starts), and left out when it is
 * inside the workspace, as the skill folders are.
 */
export function claudeProjectFolders(env: NodeJS.ProcessEnv, workspaceRoot: string, home: string = homedir()): ResolvedFolder[] {
  const project = join(claudeConfigDir(env, home), 'projects', claudeProjectName(workspaceRoot));
  if (inside(workspaceRoot, project)) return [];
  return [
    { root: project, access: 'read' },
    { root: join(project, 'memory'), access: 'readwrite' },
  ];
}

/** Claude Code's longest project folder name before it cuts it and adds a hash. */
const MAX_PROJECT_NAME = 200;

/**
 * The name Claude Code gives a working folder's project folder: the folder's
 * real path with every character but an ASCII letter or digit made `-`, and,
 * past 200 characters, cut there and given a hash of the whole path (the
 * Agent SDK's own rule, copied).
 */
export function claudeProjectName(cwd: string): string {
  let real = resolve(cwd);
  try {
    real = realpathSync(real);
  } catch {
    // Not there (yet): Claude Code uses the path as given too.
  }
  real = real.normalize('NFC');
  const name = real.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= MAX_PROJECT_NAME) return name;
  let hash = 0;
  for (let i = 0; i < real.length; i++) hash = ((hash << 5) - hash + real.charCodeAt(i)) | 0;
  return `${name.slice(0, MAX_PROJECT_NAME)}-${Math.abs(hash).toString(36)}`;
}

function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  // A relative CLAUDE_CONFIG_DIR would resolve against the server's working folder, not Claude Code's: ignored.
  const set = env['CLAUDE_CONFIG_DIR']?.trim();
  return set && isAbsolute(set) ? set : join(home, '.claude');
}

function inside(workspaceRoot: string, root: string): boolean {
  try {
    containPath(workspaceRoot, root);
    return true;
  } catch {
    return false;
  }
}
