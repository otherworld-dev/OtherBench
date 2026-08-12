import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

// `node:sqlite` has no unprefixed alias (like `node:test`, `node:sea`), and
// the vite-node version pinned transitively by vitest ^2.1.0 hardcodes its
// builtin-module allowlist with only `node:test` special-cased for this —
// `node:sqlite` isn't in it, so a plain `import { DatabaseSync } from
// 'node:sqlite'` resolves to the bare specifier "sqlite" inside vitest and
// fails ("Failed to load url sqlite"). `createRequire` bypasses vite-node's
// static import rewriting (it's a plain function call, not an import
// declaration) and hits Node's own module loader, which resolves
// `node:sqlite` correctly both under vitest and under plain `node`. Revisit
// this once vitest is upgraded past whatever version fixes vite-node's
// builtins list.
const require = createRequire(import.meta.url);
const sqliteModule = require('node:sqlite') as typeof import('node:sqlite');

/**
 * Thrown by {@link assertLocalDatabasePath} (and therefore {@link openDatabase})
 * when a database path is detected to live on a network filesystem or a UNC
 * share. SQLite's locking is unreliable over NFS/SMB and can corrupt the
 * file, so opening such a path is a hard startup failure rather than a
 * degraded-mode warning.
 */
export class NonLocalDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonLocalDatabaseError';
  }
}

const NETWORK_FS_TYPES = new Set(['nfs', 'nfs4', 'cifs', 'smbfs', 'fuse.sshfs', 'ncpfs']);

// --- Windows -----------------------------------------------------------

/**
 * True if `path` is a UNC path (`\\server\share\...` or its forward-slash
 * form), as opposed to an ordinary drive-letter path or a Windows
 * extended-length/device local path (`\\?\C:\...`, `\\.\C:\...`), which are
 * local despite starting with a double backslash.
 */
export function isUncPath(path: string): boolean {
  const normalized = path.replace(/\//g, '\\');
  if (!normalized.startsWith('\\\\')) return false;
  const rest = normalized.slice(2);
  // \\?\C:\... and \\.\C:\... are local (extended-length / device paths).
  if (/^[?.]\\[A-Za-z]:(\\|$)/.test(rest)) return false;
  return true;
}

/** True if a resolved real path (from `realpathSync.native`) is itself a UNC form. */
export function isNetworkResolvedPath(realPath: string): boolean {
  return realPath.replace(/\//g, '\\').startsWith('\\\\');
}

function findExistingAncestor(path: string): string | null {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function assertLocalWindows(path: string): void {
  if (isUncPath(path)) {
    throw new NonLocalDatabaseError(
      `Database path "${path}" is a UNC network path; refusing to open it. ` +
        'SQLite locking is unreliable over network shares and can corrupt the file.'
    );
  }

  const ancestor = findExistingAncestor(path);
  if (ancestor === null) {
    // Deliberate fail-open on a detection FAILURE (not "platform
    // unsupported" — win32 is fully supported, this branch just couldn't
    // find anything to resolve). Per decision #2, a false positive that
    // blocks startup on a real local database is worse than a missed
    // network-drive case, so this allows rather than throws. It's called
    // out explicitly, rather than folded silently into the happy path,
    // because it means the locality check did NOT actually run.
    console.warn(
      `[@grunt/store-sqlite] Could not find any existing ancestor directory of "${path}"; ` +
        'the locality check could not be completed. Allowing without verifying locality.'
    );
    return;
  }

  let real: string;
  try {
    real = realpathSync.native(ancestor);
  } catch {
    // Deliberate fail-open on a detection FAILURE, same reasoning as above:
    // this can fire on a fully-supported platform (e.g. a transient I/O
    // error resolving the native real path), not just on an exotic one, so
    // it is broader than "detection is impossible on this platform" and is
    // therefore documented here rather than assumed obvious.
    console.warn(
      `[@grunt/store-sqlite] Could not resolve the real (native) path of "${path}"; ` +
        'the locality check could not be completed. Allowing without verifying locality.'
    );
    return;
  }

  if (isNetworkResolvedPath(real)) {
    throw new NonLocalDatabaseError(
      `Database path "${path}" resolves to a network-mapped drive (native real path "${real}"); ` +
        'refusing to open it.'
    );
  }
}

// --- Linux ---------------------------------------------------------------

function unescapeMountField(field: string): string {
  // /proc/mounts escapes space, tab, newline and backslash as octal \NNN.
  return field
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\\\/g, '\\');
}

/**
 * Parses `/proc/mounts`-formatted content and returns the filesystem type of
 * the longest (most specific) mount point that is a prefix of `targetPath`,
 * or null if nothing matches. Pure and platform-independent so it can be
 * unit-tested against a fixture string on any OS.
 */
export function findMountFsType(procMounts: string, targetPath: string): string | null {
  const normalizedTarget = targetPath.replace(/\\/g, '/');
  let best: { point: string; type: string } | null = null;

  for (const line of procMounts.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 3) continue;
    const mountPoint = unescapeMountField(fields[1] ?? '');
    const fsType = fields[2] ?? '';
    if (!mountPoint) continue;

    const withSlash = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;
    const matches = normalizedTarget === mountPoint || normalizedTarget.startsWith(withSlash);
    if (matches && (!best || mountPoint.length > best.point.length)) {
      best = { point: mountPoint, type: fsType };
    }
  }

  return best ? best.type : null;
}

/** True if `fsType` (as reported by `/proc/mounts`) is a known network filesystem. */
export function isNetworkFsType(fsType: string): boolean {
  return NETWORK_FS_TYPES.has(fsType);
}

/**
 * Linux network-mount rejection logic, decoupled from reading the real
 * `/proc/mounts` (that's {@link assertLocalLinuxOnDisk}) so it can be driven
 * directly with a fixture string in tests and therefore run — and be
 * verified to actually THROW for a network mount, not just parse a fixture
 * — on any platform, not only Linux.
 *
 * Unlike the Windows check, this needs no real filesystem access: mount-
 * point matching is pure string-prefix matching against `dbPath` (the file
 * itself need not exist yet, so there's no ancestor-climb/`realpathSync`
 * step here the way there is on Windows), which is what makes this
 * deterministic enough to unit-test against a fixture.
 */
export function assertLocalLinux(dbPath: string, mountsContent: string): void {
  const fsType = findMountFsType(mountsContent, dbPath);
  if (fsType && isNetworkFsType(fsType)) {
    throw new NonLocalDatabaseError(
      `Database path "${dbPath}" is on a network filesystem (type "${fsType}"); refusing to open it.`
    );
  }
}

function assertLocalLinuxOnDisk(path: string): void {
  let mounts: string;
  try {
    mounts = readFileSync('/proc/mounts', 'utf8');
  } catch {
    // Deliberate fail-open on a detection FAILURE (not "platform
    // unsupported" — linux is fully supported, /proc/mounts is just
    // unreadable right now, e.g. a restrictive container/sandbox). This is
    // broader than the authorised "detection is impossible on this
    // platform" case: it means a real Linux deployment with a broken
    // /proc/mounts would silently allow a path the spec calls a hard
    // startup failure. Kept as fail-open anyway (blocking startup on a
    // transient read failure is worse), but made explicit here rather than
    // left implicit.
    console.warn(
      `[@grunt/store-sqlite] Could not read /proc/mounts for "${path}"; ` +
        'the locality check could not be completed. Allowing without verifying locality.'
    );
    return;
  }

  assertLocalLinux(path, mounts);
}

// --- entry point -----------------------------------------------------------

/**
 * Verifies that `path` is a local filesystem path, throwing
 * {@link NonLocalDatabaseError} for UNC shares, network-mapped drives
 * (Windows) or network filesystem mounts (Linux). `:memory:` always passes.
 *
 * If local-vs-network detection is impossible on the current platform (or
 * fails for any reason), this ALLOWS the path rather than blocking it — a
 * false positive that prevents startup is worse than a missed exotic case.
 */
export function assertLocalDatabasePath(path: string): void {
  if (path === ':memory:') return;

  if (process.platform === 'win32') {
    assertLocalWindows(path);
  } else if (process.platform === 'linux') {
    assertLocalLinuxOnDisk(path);
  } else {
    console.warn(
      `[@grunt/store-sqlite] Local-database-path verification is not implemented for platform ` +
        `"${process.platform}"; allowing "${path}".`
    );
  }
}

/**
 * Opens (creating if needed) a SQLite database at `path`, after verifying it
 * is local (see {@link assertLocalDatabasePath}). Enables WAL journaling,
 * foreign-key enforcement, and a 5-second busy timeout.
 */
export function openDatabase(path: string): DatabaseSync {
  assertLocalDatabasePath(path);

  const db = new sqliteModule.DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
