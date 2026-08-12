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

// TOCTOU note (accepted risk for v1, not fixed here): containPath validates
// and returns a path; nothing stops the filesystem underneath that exact
// path from changing between this check and whatever the caller does with
// the return value next (e.g. a directory component swapped for a symlink
// after the check). Treated as acceptable defense-in-depth for now because
// nothing in this codebase yet creates links or shells out. Revisit this
// once link-creating or shell-executing tools land -- at that point a
// TOCTOU window here stops being purely theoretical.
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
