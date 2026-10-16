import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { liveLockHolder } from './db-lock.js';

/**
 * OtherBench was called Grunt until October 2026. Its data lived in
 * `~/.grunt`, with the database as `grunt.db` and its siblings named after it
 * (`-wal`, `-shm`, `.lock`, `.attachments`, `.imported`), and Claude Code kept
 * the sessions of chats without a folder under projects named for
 * `~/.grunt/claude-scratch/<chat>`. The first start of the default database
 * moves all of that to the new names, once: only while `~/.otherbench` doesn't
 * exist yet, so a second start, or someone who started fresh, is never touched.
 *
 * The database's files are renamed inside the old folder first and the folder
 * is moved last, so a failure part way leaves `~/.otherbench` absent and the
 * next start picks up where this one stopped. A server never opens a half-moved
 * folder and makes a fresh, empty database there.
 */

export const LEGACY_DIR = '.grunt';
export const LEGACY_DB = 'grunt.db';
export const DATA_DIR = '.otherbench';
export const DB_NAME = 'otherbench.db';

export class LegacyDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyDataError';
  }
}

export interface LegacyDataDeps {
  /** Claude Code's config folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  claudeConfigDir?: string;
  isAlive?: (pid: number) => boolean;
}

/** Claude Code's project folder name for a working directory: every character but a letter or digit becomes `-`. */
export function claudeProjectKey(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Moves Grunt's data under `home` to OtherBench's names. Returns a line to
 * print when it moved something, null when there was nothing to move. Throws
 * {@link LegacyDataError} when Grunt is still running or the move fails.
 */
export function adoptLegacyData(home: string, deps: LegacyDataDeps = {}): string | null {
  const oldDir = join(home, LEGACY_DIR);
  const newDir = join(home, DATA_DIR);
  if (existsSync(newDir) || !existsSync(oldDir)) return null;

  for (const db of [LEGACY_DB, DB_NAME]) {
    const pid = liveLockHolder(join(oldDir, db), deps.isAlive);
    if (pid !== null) {
      throw new LegacyDataError(
        `Grunt is still running (pid ${pid}) and using "${oldDir}". Quit it, then start OtherBench again to move its data to "${newDir}".`
      );
    }
  }

  try {
    for (const name of readdirSync(oldDir)) {
      if (name.startsWith(LEGACY_DB)) renameSync(join(oldDir, name), join(oldDir, DB_NAME + name.slice(LEGACY_DB.length)));
    }
    renameSync(oldDir, newDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    throw new LegacyDataError(
      `Couldn't move Grunt's data from "${oldDir}" to "${newDir}" (${code}). If Grunt is still running, quit it and start OtherBench again.`
    );
  }

  moveClaudeProjects(join(oldDir, 'claude-scratch'), join(newDir, 'claude-scratch'), deps.claudeConfigDir ?? join(home, '.claude'));
  return `Moved Grunt's data from "${oldDir}" to "${newDir}".`;
}

/**
 * Best effort: renames Claude Code's project folders for the old scratch
 * folders, so those chats' sessions resume. A session that can't be found
 * still works, just without its history (the engine starts it fresh), so
 * nothing here may stop the server starting.
 */
function moveClaudeProjects(oldScratch: string, newScratch: string, claudeConfigDir: string): void {
  const projects = join(claudeConfigDir, 'projects');
  const oldKey = `${claudeProjectKey(oldScratch)}-`;
  const newKey = `${claudeProjectKey(newScratch)}-`;
  let names: string[];
  try {
    names = readdirSync(projects);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(oldKey)) continue;
    const target = join(projects, newKey + name.slice(oldKey.length));
    try {
      if (!existsSync(target)) renameSync(join(projects, name), target);
    } catch {
      // Left where it is: that chat's next reply starts a fresh session.
    }
  }
}
