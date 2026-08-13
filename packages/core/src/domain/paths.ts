import { realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve, relative, dirname, basename, join, sep } from 'node:path';

export class PathEscapeError extends Error {
  constructor(public readonly candidate: string, options?: ErrorOptions) {
    super(`Path escapes the workspace: ${candidate}`, options);
    this.name = 'PathEscapeError';
  }
}

// True iff something (file, directory, or symlink/junction, dangling or
// not) exists at exactly this path. Deliberately lstat, not exists/stat:
// exists/stat FOLLOW the final symlink component, so a link whose target
// happens to be missing right now reports "not present" even though the
// link itself is a real, present filesystem entity. That matters here
// because it decides where realpathNearest's climb stops (see below) --
// getting it wrong lets an unresolved link's name pass straight through to
// the returned "contained" path with nothing ever having validated it.
function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function realpathNearest(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!present(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

// TOCTOU note -- REVISITED (was: "accepted risk for v1, not fixed here,
// because nothing in this codebase yet creates links or shells out"; that
// condition stopped holding the moment the shell tool landed, see below).
//
// containPath validates and returns a path; nothing stops the filesystem
// underneath that exact path from changing between this check and whatever
// the caller does with the return value next (e.g. a directory component
// swapped for a symlink/junction after the check). The shell tool
// (packages/tools/src/shell-tool.ts, task 24) means a model can now run
// `run_command`, which can create a symlink or race the filesystem from a
// background process during the same turn -- the assumption that made this
// "purely theoretical" (hostile path STRINGS but no primitive to act on the
// filesystem between check and use) no longer holds.
//
// This function's own contract (validate-and-return-a-path) is unchanged --
// closing the window requires the CALLER to collapse "resolve, then
// separately act" into "resolve, snapshot an identity immediately, act, and
// verify the identity didn't change", which needs an open file handle this
// function has no reason to hold. That mitigation now lives at every call
// site that touches file content: packages/tools/src/fs-tools.ts's
// openVerified() resolves via containPath, immediately snapshots the
// target's (or nearest existing ancestor's) device+inode, opens with
// O_NOFOLLOW where the platform defines it, and verifies the opened
// handle's identity against the snapshot before any read/write proceeds --
// refusing (ToctouGuardError) on a mismatch. Empirically verified (see
// task-22-24-report.md) to detect exactly the scenario described above,
// including on this project's Windows Node build where O_NOFOLLOW itself is
// undefined and the identity check is doing the entire job alone.
//
// Residual, precisely scoped (not "accepted because nothing exercises it"):
// a swap landing strictly between openVerified's own snapshot and its own
// open()/fstat() calls -- a handful of synchronous statements, no
// attacker-reachable scheduling point in between, and no portable
// "resolve-and-open-atomically-beneath-a-root" primitive exists in Node to
// close it further. Also residual: list_dir and the filename-glob side of
// search_files, which list names via readdir without ever holding a handle
// to verify against -- can misdirect a LISTING but not leak or corrupt file
// CONTENT, since content access always goes through openVerified regardless
// of how the path was discovered.
export function containPath(workspaceRoot: string | null, candidate: string): string {
  if (!workspaceRoot) throw new PathEscapeError(candidate);
  // An embedded NUL makes every OS-level presence probe on the segment that
  // contains it report "not present" (Node validates and rejects NUL paths
  // internally, including in the lstat calls realpathNearest's climb now
  // uses) even though the segment is, character for character, part of the
  // string. That is the SAME defect a dangling link exercises below: the
  // ancestor climb walks past whatever it cannot confirm and blindly copies
  // it into the resolved tail, unvalidated. Switching the climb to lstat
  // does not close this particular case on its own -- lstat rejects NUL
  // paths for a different reason (input validation, not link-following) but
  // still reports "not present", so the climb would still walk past it and
  // reconstruct it verbatim. Guard it explicitly instead of relying on the
  // climb to happen to do the right thing.
  if (workspaceRoot.includes('\0') || candidate.includes('\0')) {
    throw new PathEscapeError(candidate);
  }
  try {
    const root = realpathNearest(workspaceRoot);
    const target = realpathNearest(isAbsolute(candidate) ? candidate : resolve(root, candidate));
    const rel = relative(root, target);
    if (rel === '') return target;
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
      throw new PathEscapeError(candidate);
    }
    return target;
  } catch (err) {
    // Any failure to resolve the candidate (e.g. a dangling link realpathSync
    // can't follow, or platform-specific path parsing quirks) must fail
    // closed as PathEscapeError, not leak an arbitrary internal error to
    // callers that only guard against the one typed error this function
    // promises to throw. The original error is preserved as `cause` so a
    // transient failure (e.g. EACCES, EMFILE) isn't misdiagnosed as an
    // escape attempt by whoever ends up debugging it.
    if (err instanceof PathEscapeError) throw err;
    throw new PathEscapeError(candidate, { cause: err });
  }
}
