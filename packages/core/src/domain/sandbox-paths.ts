import { sandboxFileAccess } from '../ports/sandbox.js';
import type { FsMode } from '../types/config.js';
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
/** Characters Windows doesn't allow in a name (the separators are handled by splitting). */
const FORBIDDEN_IN_NAME = /[<>:"|?*/]/;
/** A UTF-16 surrogate with no partner: it would reach the distro as U+FFFD. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** The whole path, in UTF-8 bytes. Matches MAX_PATH_BYTES in packages/sandbox/resources/mount.sh. */
const MAX_PATH_BYTES = 1024;

/**
 * The one rule set for a path that may be mounted, shared with mount.sh (which
 * is the strict gate and applies it to what we hand it; the shared vectors in
 * packages/sandbox/test/fixtures/sandbox-path-vectors.json run against both):
 * `X:\` then segments separated by single backslashes, no trailing one. A
 * segment is not empty, not `.` or `..`, has no control character and none of
 * `< > : " / \ | ? * , ;` (drvfs's option string can't carry the last two),
 * and doesn't end in a dot or space. Anything else (non-ASCII included, but
 * no lone surrogate) is allowed. At most 1024 bytes in all.
 */
function parseMountable(path: string): { drive: string; segments: string[] } {
  if (CONTROL.test(path)) throw new SandboxPathError(path, 'it contains control characters.');
  if (/^[\\/]{2}[?.][\\/]/.test(path)) throw new SandboxPathError(path, "device and \\\\?\\ paths can't be mounted.");
  if (/^[\\/]{2}/.test(path)) throw new SandboxPathError(path, "network (UNC) paths can't be mounted; use a folder on a local drive.");
  if (new TextEncoder().encode(path).length > MAX_PATH_BYTES) throw new SandboxPathError(path, `it is longer than ${String(MAX_PATH_BYTES)} bytes.`);
  if (LONE_SURROGATE.test(path)) throw new SandboxPathError(path, 'it contains a character that is not valid text (a lone surrogate).');
  const match = /^([A-Za-z]):\\([\s\S]*)$/.exec(path);
  if (!match) throw new SandboxPathError(path, 'only absolute paths on a drive letter (like C:\\Users\\you\\project) can be mounted.');
  const rest = match[2] ?? '';
  const segments = rest === '' ? [] : rest.split('\\');
  for (const s of segments) {
    if (s === '') throw new SandboxPathError(path, 'it has an empty segment or a trailing separator.');
    if (s === '.' || s === '..') throw new SandboxPathError(path, 'it contains . or .. segments.');
    if (FORBIDDEN_IN_NAME.test(s)) throw new SandboxPathError(path, 'a name in it has a character Windows does not allow (one of < > : " / | ? *).');
    if (/[,;]/.test(s)) throw new SandboxPathError(path, "commas and semicolons can't be mounted in the sandbox (a name in it has one).");
    if (/[. ]$/.test(s)) throw new SandboxPathError(path, 'a name in it ends in a dot or a space.');
  }
  return { drive: match[1] ?? '', segments };
}

/**
 * A drive-letter path tidied: upper-case drive, backslashes, no repeated or
 * trailing separators (`C:\` keeps its one). Forward slashes and repeated or
 * trailing separators are accepted here and only here; the result is checked
 * by the same rules as toSandboxPath.
 */
export function normaliseWindowsPath(path: string): string {
  if (CONTROL.test(path)) throw new SandboxPathError(path, 'it contains control characters.');
  if (/^[\\/]{2}[?.][\\/]/.test(path)) throw new SandboxPathError(path, "device and \\\\?\\ paths can't be mounted.");
  if (/^[\\/]{2}/.test(path)) throw new SandboxPathError(path, "network (UNC) paths can't be mounted; use a folder on a local drive.");
  const match = /^([A-Za-z]):[\\/]([\s\S]*)$/.exec(path);
  if (!match) throw new SandboxPathError(path, 'only absolute paths on a drive letter (like C:\\Users\\you\\project) can be mounted.');
  const segments = (match[2] ?? '').split(/[\\/]+/).filter((s) => s.length > 0);
  const tidy = `${(match[1] ?? '').toUpperCase()}:\\${segments.join('\\')}`;
  parseMountable(tidy);
  return tidy;
}

/**
 * Where a Windows folder appears in the sandbox: `E:\Git\Grunt` -> `/mnt/e/Git/Grunt`.
 * Strict: the path must already be in the form mount.sh accepts (backslashes,
 * no repeated or trailing separators); use normaliseWindowsPath first for a path
 * from outside. Throws SandboxPathError.
 */
export function toSandboxPath(windowsPath: string): string {
  const { drive, segments } = parseMountable(windowsPath);
  return segments.length === 0 ? `/mnt/${drive.toLowerCase()}` : `/mnt/${drive.toLowerCase()}/${segments.join('/')}`;
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
 * The system-prompt block for a profile whose shell runs in the sandbox but
 * whose file access is off: the sandbox gives its commands none of the chat's
 * folders (SandboxRunRequest.fs), so the block names none.
 */
export const SANDBOX_NO_FILES_PROMPT = [
  '# Sandbox',
  "run_command runs bash in a Linux sandbox, not on this machine, and Windows programs aren't available there. File access is off for this profile, so the sandbox has none of this chat's folders: not the workspace, not the extra folders, nothing else from this machine. Each command starts in its own home folder (~), which keeps what is put there for the rest of the chat; work there or in $TMPDIR. Reaching a host that isn't on the allowlist asks the user first.",
].join('\n');

/**
 * The sandbox block for a profile's file access (`ToolPolicy.fs`): with it
 * off, SANDBOX_NO_FILES_PROMPT; otherwise sandboxFoldersPrompt.
 */
export function sandboxPrompt(fs: FsMode, workspaceRoot: string, folders: readonly ResolvedFolder[], canonical?: (path: string) => string): string {
  return sandboxFileAccess(fs) === 'off' ? SANDBOX_NO_FILES_PROMPT : sandboxFoldersPrompt(workspaceRoot, folders, canonical);
}

/**
 * The system-prompt block for a profile whose shell runs in the sandbox (with
 * file access): what run_command is, and where the workspace and each extra
 * folder are in it.
 * `canonical` gives a folder's real path (its on-disk case), which is where
 * the sandbox mounts it: the VM's paths are case-sensitive, so a folder typed
 * in another case must still be announced at the path that exists there.
 */
export function sandboxFoldersPrompt(workspaceRoot: string, folders: readonly ResolvedFolder[], canonical: (path: string) => string = (p) => p): string {
  const where = (root: string): string => {
    try {
      return `is ${toSandboxPath(normaliseWindowsPath(canonical(root)))} in the sandbox`;
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
