import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  const configDir = env['CLAUDE_CONFIG_DIR']?.trim() || join(home, '.claude');
  return [join(configDir, 'skills'), join(configDir, 'plugins', 'cache')]
    .filter((root) => existsSync(root) && !inside(workspaceRoot, root))
    .map((root) => ({ root, access: 'read' as const }));
}

function inside(workspaceRoot: string, root: string): boolean {
  try {
    containPath(workspaceRoot, root);
    return true;
  } catch {
    return false;
  }
}
