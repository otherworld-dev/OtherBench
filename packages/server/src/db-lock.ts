import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

/**
 * One Grunt server process per database, enforced.
 *
 * `openDatabase`'s WAL mode and busy timeout happily let a second process
 * open the same file, and `createContainer` reconciles every `streaming`
 * row as abandoned before it binds a port -- so a second launch (even one
 * about to fail with `EADDRINUSE`) used to flip a still-live first process's
 * stream to `error` underneath it (see container.ts). Since the desktop app
 * and `npm run serve` default to the same `~/.grunt/grunt.db`, that stopped
 * being a theoretical case. This lock is taken before anything touches the
 * store and held until `close()`.
 *
 * The lock is a sibling file, `<db>.lock`, created with `O_EXCL` and holding
 * `{pid, startedAt}`. A lock whose holder is no longer running is stale and
 * is taken over; so is one that can't be parsed, since that can only be a
 * crash between create and write. PID reuse can make a stale lock look live
 * -- the error names the lock file so it can be deleted by hand in that case.
 */

export class DatabaseLockedError extends Error {
  readonly lockPath: string;
  readonly holderPid: number;
  readonly holderStartedAt: number;

  constructor(dbPath: string, holderPid: number, holderStartedAt: number) {
    const lockPath = lockPathFor(dbPath);
    super(
      `Database "${dbPath}" is already in use by another Grunt server (pid ${holderPid}). ` +
        'Stop that process first. If no Grunt server is running, the lock is left over from a crash ' +
        `whose process id has since been reused: delete "${lockPath}" and try again.`
    );
    this.name = 'DatabaseLockedError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
    this.holderStartedAt = holderStartedAt;
  }
}

export interface DbLock {
  readonly path: string;
  /** Removes the lock file if it is still ours. Safe to call more than once. */
  release(): void;
}

export interface DbLockDeps {
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

interface LockContents {
  pid: number;
  startedAt: number;
}

function lockPathFor(dbPath: string): string {
  return `${dbPath}.lock`;
}

/** `kill(pid, 0)` sends nothing; it only reports whether the process exists. EPERM means it does, just not ours. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): LockContents | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      Number.isInteger((parsed as LockContents).pid) &&
      typeof (parsed as LockContents).startedAt === 'number'
    ) {
      return parsed as LockContents;
    }
    return null;
  } catch {
    return null;
  }
}

function tryCreate(path: string, contents: LockContents): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(contents));
  } finally {
    closeSync(fd);
  }
  return true;
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Takes the lock for `dbPath`, or throws {@link DatabaseLockedError} if a
 * live process holds it. Returns `null` for `:memory:`, which no other
 * process can open.
 */
export function acquireDbLock(dbPath: string, deps: DbLockDeps = {}): DbLock | null {
  if (dbPath === ':memory:') return null;

  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? processIsAlive;
  const path = lockPathFor(dbPath);
  const ours: LockContents = { pid, startedAt: (deps.now ?? Date.now)() };

  if (!tryCreate(path, ours)) {
    const holder = readLock(path);
    if (holder && isAlive(holder.pid)) {
      throw new DatabaseLockedError(dbPath, holder.pid, holder.startedAt);
    }
    // Stale: take it over. If another process took it over in between, the
    // second exclusive create fails and that process is now the live holder.
    unlinkIfPresent(path);
    if (!tryCreate(path, ours)) {
      const racer = readLock(path);
      throw new DatabaseLockedError(dbPath, racer?.pid ?? -1, racer?.startedAt ?? 0);
    }
  }

  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      const current = readLock(path);
      if (current && current.pid === ours.pid && current.startedAt === ours.startedAt) {
        unlinkIfPresent(path);
      }
    },
  };
}
