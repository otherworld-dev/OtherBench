import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CoworkSessionFiles } from '@grunt/core/domain/cowork-import.js';
import { containPath } from '@grunt/core/domain/paths.js';

/**
 * Finds the Cowork sessions Claude Desktop keeps on this machine (spec
 * 2026-10-09-claude-import-design, Cowork addendum):
 * `<root>/<account>/<organisation>/local_<id>.json` beside a `local_<id>/`
 * folder whose `.claude/projects/<folder>/<cliSessionId>.jsonl` is the
 * session's transcript, and `remote-session-spaces.json` saying which space
 * each session is in. Every path is checked with `containPath`; a session
 * whose files can't be read is passed over.
 */

/** The largest transcript read, and the most all of them may add up to. */
const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** Where Claude Desktop keeps Cowork sessions on this OS. */
export function defaultCoworkRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === 'win32') return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Claude', 'local-agent-mode-sessions');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
  return join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'Claude', 'local-agent-mode-sessions');
}

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Which space each session is in, from an organisation folder's `remote-session-spaces.json`. */
async function spacesIn(org: string): Promise<Map<string, string>> {
  const spaces = new Map<string, string>();
  const raw = await readJson(join(org, 'remote-session-spaces.json'));
  const entries = raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : [];
  for (const e of entries) {
    if (e && typeof e === 'object') {
      const { sessionId, spaceId } = e as { sessionId?: unknown; spaceId?: unknown };
      if (typeof sessionId === 'string' && typeof spaceId === 'string') spaces.set(sessionId, spaceId);
    }
  }
  return spaces;
}

/** The transcript of a session, or null when it can't be found. */
async function transcriptOf(org: string, meta: { sessionId: string; cliSessionId: string }): Promise<string | null> {
  const projects = containPath(org, `${meta.sessionId}/.claude/projects`);
  for (const folder of await dirs(projects)) {
    try {
      const path = containPath(projects, `${folder}/${meta.cliSessionId}.jsonl`);
      return (await stat(path)).isFile() ? path : null;
    } catch {
      continue;
    }
  }
  return null;
}

/** Every Cowork session under `root` with its transcript, oldest folders first; [] when there are none. */
export async function readCoworkSessions(root: string): Promise<CoworkSessionFiles[]> {
  const sessions: CoworkSessionFiles[] = [];
  let total = 0;
  for (const account of await dirs(root)) {
    for (const orgName of await dirs(containPath(root, account))) {
      const org = containPath(root, `${account}/${orgName}`);
      const spaces = await spacesIn(org);
      let names: string[];
      try {
        names = (await readdir(org)).filter((n) => /^local_[^/\\]+\.json$/.test(n)).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          const meta = await readJson(containPath(org, name));
          const { sessionId, cliSessionId } = (meta ?? {}) as { sessionId?: unknown; cliSessionId?: unknown };
          if (typeof sessionId !== 'string' || typeof cliSessionId !== 'string' || !/^[\w-]+$/.test(sessionId) || !/^[\w-]+$/.test(cliSessionId)) continue;
          const path = await transcriptOf(org, { sessionId, cliSessionId });
          if (!path) continue;
          const size = (await stat(path)).size;
          if (size > MAX_TRANSCRIPT_BYTES || total + size > MAX_TOTAL_BYTES) continue;
          total += size;
          sessions.push({ meta, transcript: await readFile(path, 'utf8'), spaceId: spaces.get(sessionId) ?? null });
        } catch {
          continue;
        }
      }
    }
  }
  return sessions;
}
