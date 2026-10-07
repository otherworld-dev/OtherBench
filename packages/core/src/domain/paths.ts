import { realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve, relative, dirname, basename, join, sep } from 'node:path';
import type { ResolvedFolder } from '../types/workspace.js';

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

// WHAT THIS FUNCTION DOES AND DOES NOT GUARANTEE
//
// containPath answers one question: "resolving this path string right now,
// following every symlink, does it land inside the workspace?" That is a
// statement about a PATH at a MOMENT. It is not a statement about the file a
// caller subsequently opens, and there are two distinct ways to be inside the
// workspace by this function's answer and outside it in fact. Both are
// reachable by a model that has `run_command` (packages/tools/src/shell-tool.ts).
//
// 1. HARD LINKS -- not a race at all, and not detectable here even in
//    principle. `mklink /H` (Windows, no elevation) and link(2) (POSIX)
//    create a second directory entry for an existing file; the entry can sit
//    inside the workspace while the file lives outside it. realpathSync on
//    that entry returns the entry's own in-workspace path, because a hard
//    link is not a pointer to the file, it IS the file under another name.
//    So this function says "contained" and is, on its own terms, correct.
//    Demonstrated end to end through the shipped tools: read a file outside
//    the workspace, then overwrite it. The only portable signal is the link
//    count on an opened handle, which is why the refusal lives in
//    fs-tools.ts's openVerified (`nlink > 1` -> HardLinkError) and not here.
//    That refusal also fires on legitimately hard-linked files; accepted.
//
// 2. SWAPPING A COMPONENT between this check and the caller's use -- the
//    classic TOCTOU. A directory inside the workspace is replaced by a
//    junction pointing outside it after containPath has returned, so the
//    literal path string this function blessed now names an outside file.
//    An earlier version of this comment called that "purely theoretical" on
//    the grounds that nothing here could act on the filesystem between check
//    and use; the shell tool ended that, and an unprivileged racer has since
//    reproduced it against the shipped tools -- leaked file CONTENT from
//    read_file, landed writes on an outside file through write_file, and
//    enumerated an outside directory through list_dir on roughly 2-4% of
//    attempts. An earlier version of this comment also claimed a swap could
//    "misdirect a LISTING but not leak or corrupt file CONTENT"; that was
//    wrong on both halves and is corrected here.
//
// Closing (2) requires binding a file, not a path, which needs an open
// handle this function has no reason to hold. That mitigation lives at the
// call sites: fs-tools.ts's openVerified brackets the whole resolve-and-open
// sequence with identity checks taken BEFORE as well as after containPath
// runs, plus a second containment verdict after the open, so that no single
// swap is invisible. Read the module comment there for the exact sequence.
//
// Residual, stated without varnish rather than as a "handful of synchronous
// statements":
//   - The window does not begin after containPath returns; it begins inside
//     containPath, at its own realpath traversal, and spans several `await`
//     boundaries in the caller (mkdir, open, fstat). It is not a run of
//     straight-line code with no scheduling point in it.
//   - The bracketing makes a successful swap require several precisely
//     placed toggles rather than one. It does not make it impossible, and a
//     model that can retry in a loop can retry this.
//   - Directory listings (list_dir, and the filename-glob side of
//     search_files) hold no handle at all, because Node exposes no portable
//     fd-based readdir. They get the same bracketing, which removed every
//     leak in a ~4,900-attempt racer run where the previous code leaked on
//     4.1% of attempts, but a swap that lands and is undone entirely inside
//     the readdir call remains undetectable. Enumeration outside the
//     workspace is narrowed, not eliminated.
//   - `fs.constants.O_NOFOLLOW` is `undefined` on this project's Windows Node
//     build, so that flag contributes nothing here; the identity bracketing
//     is doing the whole job on Windows.
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

/** Where containPathIn found a path: the resolved path, the folder it's in, and whether that folder may be written. */
export interface ContainedIn {
  path: string;
  root: string;
  writable: boolean;
}

/**
 * containPath over a chat's folders (spec 2026-10-07-extra-folders): the
 * workspace, which is writable as far as the profile allows, and each extra
 * folder with its own access. A relative candidate means the workspace, as
 * it always has. The candidate is checked with containPath against each
 * folder, unchanged, and the innermost folder that contains it wins, so a
 * read-only folder nested inside the workspace stays read-only however the
 * path is written. Throws PathEscapeError when no folder contains it.
 *
 * Like containPath, this is a verdict about a path at a moment: callers
 * still do their own verified open against the returned `root`.
 */
export function containPathIn(workspaceRoot: string | null, folders: readonly ResolvedFolder[], candidate: string): ContainedIn {
  if (!workspaceRoot) throw new PathEscapeError(candidate);
  // The workspace sees the candidate as given (so a relative path resolves
  // exactly as before); every extra folder sees it made absolute against
  // the workspace, so a relative path into a nested folder is caught too.
  const absolute = isAbsolute(candidate) ? candidate : resolve(workspaceRoot, candidate);
  const checks = [
    { root: workspaceRoot, writable: true, path: candidate },
    ...folders.map((f) => ({ root: f.root, writable: f.access === 'readwrite', path: absolute })),
  ];
  let best: (ContainedIn & { depth: number }) | null = null;
  for (const check of checks) {
    let path: string;
    let depth: number;
    try {
      path = containPath(check.root, check.path);
      depth = realpathNearest(check.root).length;
    } catch {
      // Not in this folder (or its root no longer resolves): never contained.
      continue;
    }
    if (!best || depth > best.depth) best = { path, root: check.root, writable: check.writable, depth };
  }
  if (!best) throw new PathEscapeError(candidate);
  return { path: best.path, root: best.root, writable: best.writable };
}
