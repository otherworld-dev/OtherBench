import type { ResolvedFolder } from '../types/workspace.js';

/**
 * Windows folders as Grunt's sandbox sees them (spec 2026-10-12-sandbox-design,
 * "Folders in the VM"). Pure string work, no filesystem: a folder `X:\a\b` is
 * mounted at `/mnt/x/a/b` (WSL's own convention), so paths map by rule. The
 * caller canonicalises a folder first (WslSandbox uses realpath, which gives
 * the on-disk case and turns a mapped drive into the UNC path refused here).
 */

/** Why a Windows folder can't be mounted in the sandbox. */
export class SandboxPathError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string
  ) {
    super(`${path} can't be used in the sandbox: ${reason}`);
    this.name = 'SandboxPathError';
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A drive-letter path tidied: upper-case drive, backslashes, no repeated or trailing separators (`C:\` keeps its one). */
export function normaliseWindowsPath(path: string): string {
  if (CONTROL.test(path)) throw new SandboxPathError(path, 'it contains control characters.');
  if (/^[\\/]{2}[?.][\\/]/.test(path)) throw new SandboxPathError(path, "device and \\\\?\\ paths can't be mounted.");
  if (/^[\\/]{2}/.test(path)) throw new SandboxPathError(path, "network (UNC) paths can't be mounted; use a folder on a local drive.");
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!match) throw new SandboxPathError(path, 'only absolute paths on a drive letter (like C:\\Users\\you\\project) can be mounted.');
  const segments = (match[2] ?? '').split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) throw new SandboxPathError(path, 'it contains . or .. segments.');
  return `${(match[1] ?? '').toUpperCase()}:\\${segments.join('\\')}`;
}

/** Where a Windows folder appears in the sandbox: `E:\Git\Grunt` -> `/mnt/e/Git/Grunt`. Throws SandboxPathError. */
export function toSandboxPath(windowsPath: string): string {
  const tidy = normaliseWindowsPath(windowsPath);
  const drive = tidy.charAt(0).toLowerCase();
  const rest = tidy.slice(3).split('\\').filter((s) => s.length > 0);
  return rest.length === 0 ? `/mnt/${drive}` : `/mnt/${drive}/${rest.join('/')}`;
}

/** One folder a chat with a running agent needs in the VM. */
export interface MountNeed {
  windowsPath: string;
  writable: boolean;
}

export interface PlannedMount {
  windowsPath: string;
  linuxPath: string;
  mode: 'ro' | 'rw';
}

/** Windows compares paths without case. */
const keyOf = (windowsPath: string): string => windowsPath.toLowerCase();

function isUnder(child: string, parent: string): boolean {
  const c = keyOf(child);
  const p = keyOf(parent);
  return c !== p && c.startsWith(p.endsWith('\\') ? p : `${p}\\`);
}

/**
 * The mounts the VM should have for the folders of every chat with a running
 * agent: each folder once (the first spelling seen), read-write if any chat
 * needs it writable, minus any folder already covered by a mounted parent of
 * the same or wider mode. Parents come first, so they are mounted first.
 * Throws SandboxPathError for a path that can't be mounted.
 */
export function planMounts(chats: readonly (readonly MountNeed[])[]): PlannedMount[] {
  const merged = new Map<string, { windowsPath: string; writable: boolean }>();
  for (const needs of chats) {
    for (const need of needs) {
      const windowsPath = normaliseWindowsPath(need.windowsPath);
      const prior = merged.get(keyOf(windowsPath));
      merged.set(keyOf(windowsPath), { windowsPath: prior?.windowsPath ?? windowsPath, writable: (prior?.writable ?? false) || need.writable });
    }
  }
  const all = [...merged.values()];
  const kept = all.filter((m) => !all.some((p) => isUnder(m.windowsPath, p.windowsPath) && (p.writable || !m.writable)));
  const depth = (linuxPath: string): number => linuxPath.split('/').length;
  return kept
    .map((m): PlannedMount => ({ windowsPath: m.windowsPath, linuxPath: toSandboxPath(m.windowsPath), mode: m.writable ? 'rw' : 'ro' }))
    .sort((a, b) => depth(a.linuxPath) - depth(b.linuxPath) || a.linuxPath.localeCompare(b.linuxPath));
}

/**
 * The system-prompt block for a profile whose shell runs in the sandbox: what
 * run_command is, and where the workspace and each extra folder are in it.
 */
export function sandboxFoldersPrompt(workspaceRoot: string, folders: readonly ResolvedFolder[]): string {
  const where = (root: string): string => {
    try {
      return `is ${toSandboxPath(root)} in the sandbox`;
    } catch (err) {
      return `is not available in the sandbox (${err instanceof SandboxPathError ? err.reason : String(err)})`;
    }
  };
  return [
    '# Sandbox',
    "run_command runs bash in a Linux sandbox, not on this machine. This chat's folders appear there under /mnt/<drive>/...; nothing else from this machine is there, and Windows programs aren't available. Reaching a host that isn't on the allowlist asks the user first.",
    `- The workspace ${workspaceRoot} ${where(workspaceRoot)} (commands start there).`,
    ...folders.map((f) => `- ${f.root} ${where(f.root)}${f.access === 'read' ? ' (read-only)' : ''}.`),
  ].join('\n');
}
