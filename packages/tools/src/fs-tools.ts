import { constants as fsConstants, lstatSync, statSync, type Dirent } from 'node:fs';
import { mkdir, open, readdir, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { containPath, PathEscapeError } from '@grunt/core/domain/paths.js';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';

// ---------------------------------------------------------------------------
// Shared result / error shapes
// ---------------------------------------------------------------------------

/**
 * Every fs tool resolves (never rejects) with either its data or one of
 * these -- "Every path escape must surface as a tool ERROR the model can
 * reason about, not an uncaught exception" (task 23 brief). `runTool` below
 * is the single place that enforces this: no fs tool's `execute` can let an
 * exception escape it, whatever throws internally.
 */
interface ToolError {
  error: true;
  code: string;
  message: string;
}

function toolError(code: string, message: string): ToolError {
  return { error: true, code, message };
}

class ArgsError extends Error {}
class BinaryFileError extends Error {}
class NotUniqueError extends Error {
  constructor(public readonly count: number) {
    super(`Expected exactly one occurrence of oldString, found ${count}.`);
  }
}
class FileTooLargeError extends Error {}

/**
 * See openVerified()'s doc comment for what this guards against and why.
 */
class ToctouGuardError extends Error {
  constructor(candidate: string) {
    super(
      `Refusing to access "${candidate}": its filesystem identity changed between the workspace-containment ` +
        'check and use. This is either a benign concurrent modification or an attempt to redirect a validated ' +
        'path outside the workspace after the fact; either way the operation is refused.'
    );
    this.name = 'ToctouGuardError';
  }
}

/**
 * Raised when the file behind a path has more than one directory entry
 * pointing at it (`nlink > 1`). See the HARD LINKS section of the module
 * comment below: a hard link is not a redirection that containment can
 * detect, it is a second real name for the same file, and it needs no
 * privilege to create.
 */
class HardLinkError extends Error {
  constructor(candidate: string, nlink: number) {
    super(
      `Refusing to access "${candidate}": the file it names has ${nlink} directory entries (hard links), so an ` +
        'entry inside the workspace may be a second name for a file that lives outside it. Workspace containment ' +
        'cannot tell those apart, so hard-linked files are refused. Copy the file into the workspace instead.'
    );
    this.name = 'HardLinkError';
  }
}

async function runTool<T>(fn: () => Promise<T>): Promise<T | ToolError> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PathEscapeError) return toolError('path_escape', err.message);
    if (err instanceof ToctouGuardError) return toolError('toctou_guard', err.message);
    if (err instanceof HardLinkError) return toolError('hard_link', err.message);
    if (err instanceof ArgsError) return toolError('bad_args', err.message);
    if (err instanceof BinaryFileError) return toolError('binary_file', err.message);
    if (err instanceof NotUniqueError) return toolError('not_unique', err.message);
    if (err instanceof FileTooLargeError) return toolError('file_too_large', err.message);
    const code = (err as NodeJS.ErrnoException)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'ENOENT') return toolError('not_found', message);
    if (code === 'EISDIR') return toolError('is_a_directory', message);
    if (code === 'ELOOP') return toolError('toctou_guard', `Refused to follow a symlink at the final path component: ${message}`);
    return toolError('io_error', message);
  }
}

// ---------------------------------------------------------------------------
// Containment beyond containPath: what these tools actually guarantee
// ---------------------------------------------------------------------------
//
// containPath() (packages/core/src/domain/paths.ts) resolves a candidate path
// through every symlink and returns it if the result is inside the workspace.
// That is a statement about a PATH at a MOMENT. Two separate things defeat it,
// and both are reachable by a model that has `run_command`:
//
// (1) HARD LINKS -- not a race at all. 100% reliable, no privilege needed.
//     `mklink /H` on Windows and link(2) on POSIX create a second directory
//     entry for an existing file. The entry can be created inside the
//     workspace for a file that lives outside it, on the same volume. There
//     is nothing for containPath to detect: realpath() on that entry returns
//     the entry's own in-workspace path (verified on this project's Windows
//     build), because a hard link IS the file, not a pointer to it. An
//     identity check sees a perfectly stable identity for the same reason --
//     it is the outside file from beginning to end. Demonstrated end to end
//     through these tools: read a file outside the workspace, then overwrite
//     it. One `run_command` approval buys read/write on any same-volume file
//     the user can touch, %USERPROFILE%\.ssh\id_rsa included.
//
//     The only portable signal Node exposes is the link count. openVerified()
//     therefore REFUSES any file whose opened handle reports `nlink > 1`
//     (HardLinkError). This is a blunt instrument and it will refuse
//     legitimately hard-linked files -- some package managers, some backup
//     and build tools, and CoW-style clone workflows produce them. That is
//     accepted: a false refusal is recoverable (copy the file), a false
//     accept is not. It is also not a complete answer -- a filesystem that
//     does not report link counts (some network mounts) reports 1 and the
//     check silently passes, so this narrows the attack to volumes where
//     Node cannot see link counts rather than eliminating it.
//
// (2) SWAPPING A PATH COMPONENT between the check and the use. A directory
//     inside the workspace is replaced by a junction/symlink pointing
//     outside it, so a literal in-workspace path string now names an outside
//     file. Unlike hard links this IS a race, and it is emphatically not
//     theoretical: an unprivileged racer running against the previous
//     version of this file leaked attacker-controlled content from read_file
//     20 times in 15,981 attempts, landed 184 write_file writes on an
//     outside file, and got list_dir to enumerate an outside directory 977
//     times in 39,993 (~2.4% per attempt).
//
//     The previous mitigation did not cover the window it claimed to. It
//     took its "before" identity snapshot AFTER containPath had already
//     finished -- a second, independent path traversal. A swap landing
//     between those two traversals meant the snapshot recorded the
//     ATTACKER's file, and the post-open comparison then compared the
//     attacker's file to itself and passed. The regression test hooked the
//     one sub-window where the guard did work, which is why this went
//     unnoticed. (On Windows `fs.constants.O_NOFOLLOW` is `undefined`, so
//     that flag is a no-op here and contributes nothing.)
//
//     Node has no portable "resolve and open atomically beneath this root"
//     primitive (no openat2(RESOLVE_BENEATH)), so this cannot be closed
//     here. What openVerified() does instead is BRACKET every step, so that
//     no single swap is invisible:
//
//        A  stat the candidate            (identity, following links)
//        B  containPath                   (containment verdict #1)
//        C  stat the resolved path        (identity)
//        D  open(resolved)                (binds a file; nothing after this
//                                          point can change what we read or
//                                          write -- the handle is the file)
//        E  fstat(handle)                 (identity of what we actually got)
//        F  stat the resolved path        (identity)
//        G  containPath                   (containment verdict #2)
//
//     A, C, E and F must all report the same file, and B and G must both
//     say it is inside the workspace. A swap that lands anywhere in A..F
//     changes one of those identities; a swap that is still in place at G
//     fails containment; a swap that is reverted before G disagrees with E.
//
//     Identity comparisons are not enough on their own, though, and this is
//     worth spelling out because the first version of this bracketing still
//     leaked. Comparing identities says nothing when there are no identities
//     to compare. A racer's cycle passes through a window where the
//     directory is simply ABSENT (between the rename that stashes it and the
//     junction that replaces it), and a path that names NOTHING at both A
//     and C makes every comparison between them vacuously agree:
//
//        ws/sub absent    -> A: null, C: null, parent: null. All vacuous.
//        junction appears -> D: the open succeeds against the attacker's
//                            file; E's comparison is skipped because there
//                            was nothing at C to compare it to; F compares
//                            the attacker's file to itself and agrees.
//        junction removed -> G: containPath sees a clean tree and passes.
//
//     One ordinary pass of the racer's own loop, not an exotic interleaving
//     -- and it leaked attacker content in a live run. Hence two further
//     rules: a successful open of a path that named nothing at C, when the
//     caller did not ask to create anything, is refused outright; and the
//     post-open parent-directory check for creates runs unconditionally
//     rather than only when the parent happened to exist at A.
//
//     RESIDUAL, stated plainly: an attacker who can place four toggles
//     precisely -- outside file visible at A, clean tree at B, outside file
//     again at C, D, E, F, clean tree again at G -- is still not stopped.
//     That is much harder to hit than a single well-placed swap, but a model
//     that can retry in a loop can retry this too. The honest claim is
//     "materially narrowed", not "closed". Measure it on a LOADED machine:
//     the first measurement of this code showed zero leaks on an idle one
//     and was wrong.
//
// DIRECTORY LISTINGS. list_dir and the filename-glob side of search_files
// hold no handle -- Node's readdir offers no fd-based equivalent and no
// O_NOFOLLOW -- so step D above does not exist for them and there is nothing
// that pins the directory while it is being read. They get the same A/B/C ..
// F/G bracketing (readdirVerified below), which catches a swap that is still
// in place afterwards and a swap whose revert leaves the identities
// disagreeing, but a racer that swaps a directory in and back out entirely
// within the readdir call is undetectable here. The previous comment claimed
// such a swap "can misdirect a LISTING but not leak or corrupt file
// CONTENT"; that was wrong on both counts (content leak and content
// corruption were both reproduced, via the same swap applied to read_file
// and write_file), and it is wrong about severity too: arbitrary directory
// enumeration outside the workspace, at a per-attempt success rate that a
// looping model will hit within seconds, is enumeration at will. The
// bracketing reduces the rate; it does not remove the capability.

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

interface Identity {
  dev: number;
  ino: number;
}

function presentSync(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Identity of whatever `p` names, FOLLOWING links, or null if it names
 * nothing. Following (stat, not lstat) is deliberate: the identity has to be
 * comparable with the one an open file handle reports, and a handle always
 * refers to the link's target, never to the link.
 */
function identityOf(p: string): Identity | null {
  try {
    const st = statSync(p);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

function sameIdentity(a: Identity | null, b: Identity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/** The candidate as an absolute path, WITHOUT resolving links -- just enough to stat it before containPath runs. */
function absoluteCandidate(workspaceRoot: string | null, candidate: string): string | null {
  if (candidate.includes('\0')) return null;
  if (isAbsolute(candidate)) return candidate;
  if (!workspaceRoot) return null;
  return resolvePath(workspaceRoot, candidate);
}

/**
 * Test-only seams, one per window this function brackets. Never part of
 * `ToolSpec`'s public surface and never wired to model-controlled input:
 * they exist so fs-tools.test.ts can perform a REAL filesystem swap
 * deterministically inside a chosen window. `afterContainPath` is the window
 * the previous guard silently failed to cover.
 */
interface RaceHooks {
  afterContainPath?: () => void | Promise<void>;
  afterSnapshot?: () => void | Promise<void>;
}

interface VerifiedOpen {
  handle: FileHandle;
  resolved: string;
  /** Whether `resolved` already existed at containment-check time. */
  existed: boolean;
}

/**
 * Resolves + validates `candidate` via containPath and opens it, bracketing
 * the whole sequence with identity checks and a second containment verdict
 * so that no single filesystem swap between the check and the open goes
 * unnoticed, and refusing outright any file that carries more than one
 * directory entry.
 *
 * See the module comment above for the exact bracketing, what it catches,
 * and -- importantly -- what it does not.
 */
async function openVerified(
  workspaceRoot: string | null,
  candidate: string,
  flags: number,
  opts: { createParents?: boolean; __raceHooksForTests?: RaceHooks } = {}
): Promise<VerifiedOpen> {
  // (A) Before any containment work: what does this path name right now?
  // Taken FIRST, so that a swap landing between here and containPath either
  // changes this identity (caught at C) or makes containPath itself reject.
  const candidateAbs = absoluteCandidate(workspaceRoot, candidate);
  const preTarget = candidateAbs === null ? null : identityOf(candidateAbs);
  const preParent = candidateAbs === null ? null : identityOf(dirname(candidateAbs));

  // (B) Containment verdict #1.
  const resolved = containPath(workspaceRoot, candidate);
  if (opts.__raceHooksForTests?.afterContainPath) await opts.__raceHooksForTests.afterContainPath();

  if (opts.createParents) {
    await mkdir(dirname(resolved), { recursive: true });
  }

  // (C) Same question, now against the resolved path. Any swap that landed
  // during B shows up here as a disagreement with A.
  const existed = presentSync(resolved);
  const midTarget = identityOf(resolved);
  const midParent = identityOf(dirname(resolved));
  if (existed) {
    if (!sameIdentity(preTarget, midTarget)) throw new ToctouGuardError(candidate);
  } else {
    // A file that does not exist yet has no identity to compare, so the
    // anchor is its parent directory -- which is what an ancestor swap
    // redirects. `preParent` is null when the parent did not exist at (A)
    // either, i.e. we created it ourselves via mkdir a moment ago: there is
    // no older state to compare against, and nothing an attacker could have
    // redirected, because the directory did not exist to be redirected.
    if (preParent !== null && !sameIdentity(preParent, midParent)) throw new ToctouGuardError(candidate);
  }

  if (opts.__raceHooksForTests?.afterSnapshot) await opts.__raceHooksForTests.afterSnapshot();

  // (D) Bind the file. From here on the handle, not the path, is what gets
  // read and written, so nothing that happens to the path can redirect the
  // actual I/O -- it can only make us wrong about WHICH file we bound, which
  // is what E/F/G are for.
  //
  // O_CREAT is narrowed to exactly what the caller needs, because open() is
  // the one step here that can have an effect before any check has run:
  //   - the target existed at (C): drop O_CREAT entirely. If it has vanished
  //     since, the open fails ENOENT rather than quietly creating a new file
  //     at a path that may no longer mean what it meant.
  //   - the target did not exist at (C): add O_EXCL. Without it, a create
  //     whose parent has just been redirected opens (and would go on to
  //     write to) a PRE-EXISTING file outside the workspace. With it, that
  //     case fails EEXIST and touches nothing -- and anything the open does
  //     create is guaranteed to be ours, which is what makes the cleanup
  //     below safe.
  const wantsCreate = (flags & fsConstants.O_CREAT) !== 0;
  const openFlags = wantsCreate
    ? existed
      ? flags & ~fsConstants.O_CREAT
      : flags | fsConstants.O_EXCL
    : flags;
  const handle = await open(resolved, openFlags | NOFOLLOW);
  const createdByUs = wantsCreate && !existed;
  let openedIdentity: Identity | null = null;

  try {
    // (E) What did we actually get?
    const opened = await handle.stat();
    openedIdentity = { dev: opened.dev, ino: opened.ino };

    // Hard links: see the module comment. A second directory entry for the
    // same file is indistinguishable from the file itself by every
    // path-based check there is, so the link COUNT is the only signal.
    // Directories are exempt: POSIX counts a directory's subdirectories in
    // its link count (`.` and `..` entries), so every non-empty directory
    // reports nlink > 1, and user-creatable directory hard links do not
    // exist on either platform. Callers that opened a directory by mistake
    // get the ordinary EISDIR further down.
    if (!opened.isDirectory() && opened.nlink > 1) throw new HardLinkError(candidate, opened.nlink);

    if (existed && !sameIdentity(midTarget, openedIdentity)) throw new ToctouGuardError(candidate);

    // The path named NOTHING at (C) and yet the open found a file, without us
    // asking to create one. Something materialised in between -- which is
    // exactly what a racer's cycle produces: the directory is briefly absent
    // (so A and C both see nothing and every identity comparison is vacuous),
    // then a junction to somewhere outside appears in time for the open, then
    // it is gone again before the second containment verdict. Measured: this
    // path leaked attacker content under contention while every other check
    // in this function passed. A concurrent process legitimately creating the
    // file produces the same signature and is refused too; retry succeeds.
    if (!existed && (flags & fsConstants.O_CREAT) === 0) throw new ToctouGuardError(candidate);

    // (F) The path must still name the file we bound. A swap that was
    // reverted after we opened shows up here (the path now names the
    // original in-workspace file, our handle names the attacker's).
    if (!sameIdentity(identityOf(resolved), openedIdentity)) throw new ToctouGuardError(candidate);
    // For a create, the parent is the anchor, and it is checked against (C)
    // unconditionally -- NOT only when it also existed at (A). Gating it on
    // `preParent !== null` meant that a create whose parent was absent at (A)
    // (the racer's own "briefly missing" window, or an ordinary mkdir -p) had
    // no post-open anchor check at all.
    if (!existed && !sameIdentity(identityOf(dirname(resolved)), midParent)) {
      throw new ToctouGuardError(candidate);
    }

    // (G) Containment verdict #2. A swap that is still in place fails here,
    // even if every identity above agreed (which is exactly what happens
    // when the swap lands before the first snapshot is taken).
    containPath(workspaceRoot, candidate);
  } catch (err) {
    await handle.close().catch(() => {});
    // A refusal must not leave debris where it was refused. O_EXCL above
    // guarantees a `createdByUs` file is ours, and the identity check makes
    // sure we are unlinking THAT file and not something the path has since
    // come to mean -- if the tree reverted under us, `resolved` now names a
    // legitimate in-workspace file that we did not create and must not
    // delete.
    if (createdByUs && openedIdentity !== null && sameIdentity(identityOf(resolved), openedIdentity)) {
      await unlink(resolved).catch(() => {});
    }
    throw err;
  }

  return { handle, resolved, existed };
}

/**
 * The directory-listing counterpart of openVerified: same bracketing, minus
 * the one step that actually matters. There is no handle to bind a directory
 * with in portable Node, so a swap that lands and is reverted entirely
 * inside the `readdir` call cannot be detected here -- see the DIRECTORY
 * LISTINGS paragraph of the module comment for what that means in practice.
 */
async function readdirVerified(
  workspaceRoot: string | null,
  candidate: string,
  opts: { __raceHooksForTests?: RaceHooks } = {}
): Promise<{ resolved: string; dirents: Dirent[] }> {
  const candidateAbs = absoluteCandidate(workspaceRoot, candidate);
  const pre = candidateAbs === null ? null : identityOf(candidateAbs);

  const resolved = containPath(workspaceRoot, candidate);
  if (opts.__raceHooksForTests?.afterContainPath) await opts.__raceHooksForTests.afterContainPath();

  const mid = identityOf(resolved);
  // Both null = the directory simply is not there; let readdir report that as
  // the ordinary ENOENT it is, rather than dressing a missing path up as an
  // attack. Any other disagreement between (A) and (C) is one.
  if (!(pre === null && mid === null) && !sameIdentity(pre, mid)) throw new ToctouGuardError(candidate);

  const dirents = await readdir(resolved, { withFileTypes: true });

  // Having listed it, it must still be the same directory -- and it must be a
  // directory that existed at (C), so a listing cannot be served out of
  // something that materialised in between.
  if (!sameIdentity(identityOf(resolved), mid)) throw new ToctouGuardError(candidate);
  containPath(workspaceRoot, candidate);

  return { resolved, dirents };
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

const BINARY_SNIFF_BYTES = 8000;

/** Standard heuristic (same one git/most editors use): a NUL byte in the first few KB means binary. */
function looksBinary(sample: Buffer): boolean {
  return sample.includes(0);
}

async function sniffBinary(handle: FileHandle): Promise<boolean> {
  const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
  const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0);
  return looksBinary(buf.subarray(0, bytesRead));
}

// ---------------------------------------------------------------------------
// Args helpers
// ---------------------------------------------------------------------------

function argsObject(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) {
    throw new ArgsError('Expected an object of arguments.');
  }
  return args as Record<string, unknown>;
}

function requireString(args: unknown, key: string): string {
  const value = argsObject(args)[key];
  if (typeof value !== 'string') throw new ArgsError(`"${key}" must be a string.`);
  return value;
}

function optionalString(args: unknown, key: string): string | undefined {
  const value = argsObject(args)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ArgsError(`"${key}" must be a string when present.`);
  return value;
}

function optionalPositiveInt(args: unknown, key: string): number | undefined {
  const value = argsObject(args)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ArgsError(`"${key}" must be a positive integer when present.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const MAX_READ_BYTES = 1024 * 1024; // 1MB read cap

export const readFileTool: ToolSpec = {
  name: 'read_file',
  description:
    'Reads a UTF-8 text file inside the workspace, optionally restricted to a 1-indexed inclusive line range. ' +
    'Refuses binary files. Content is capped at 1MB; larger files are truncated with a notice.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to the workspace root (or absolute).' },
      startLine: { type: 'integer', minimum: 1, description: '1-indexed first line to include (optional).' },
      endLine: { type: 'integer', minimum: 1, description: '1-indexed last line to include, inclusive (optional).' },
    },
    required: ['path'],
  },
  risk: 'read',
  source: 'fs',
  async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
    return runTool(async () => {
      const path = requireString(args, 'path');
      const startLine = optionalPositiveInt(args, 'startLine');
      const endLine = optionalPositiveInt(args, 'endLine');

      const { handle, resolved } = await openVerified(ctx.workspaceRoot, path, fsConstants.O_RDONLY);
      try {
        const stat = await handle.stat();
        if (stat.isDirectory()) throw Object.assign(new Error(`"${path}" is a directory.`), { code: 'EISDIR' });

        if (await sniffBinary(handle)) {
          throw new BinaryFileError(`"${path}" looks like a binary file and was not read.`);
        }

        const readSize = Math.min(stat.size, MAX_READ_BYTES + 1);
        const buf = Buffer.alloc(readSize);
        const { bytesRead } = await handle.read(buf, 0, readSize, 0);
        const truncated = stat.size > MAX_READ_BYTES;
        const text = buf.subarray(0, truncated ? MAX_READ_BYTES : bytesRead).toString('utf8');

        const lines = text.split('\n');
        const from = startLine ?? 1;
        const to = endLine ?? lines.length;
        const clampedFrom = Math.max(1, Math.min(from, lines.length));
        const clampedTo = Math.max(clampedFrom, Math.min(to, lines.length));
        const selected = lines.slice(clampedFrom - 1, clampedTo).join('\n');

        return {
          path: relative(ctx.workspaceRoot ?? '', resolved) || resolved,
          content: selected,
          startLine: clampedFrom,
          endLine: clampedTo,
          linesInSample: lines.length,
          truncated,
          ...(truncated
            ? { note: `File exceeds the 1MB read cap; content (and line count) reflect only the first 1MB.` }
            : {}),
        };
      } finally {
        await handle.close();
      }
    });
  },
};

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

export const listDirTool: ToolSpec = {
  name: 'list_dir',
  description: 'Lists the immediate contents (files and directories) of a directory inside the workspace.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path, relative to the workspace root (default: workspace root).' },
    },
  },
  risk: 'read',
  source: 'fs',
  async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
    return runTool(async () => {
      const path = optionalString(args, 'path') ?? '.';
      const { resolved, dirents } = await readdirVerified(ctx.workspaceRoot, path);
      const entries = dirents
        .map((d) => ({
          name: d.name,
          type: d.isDirectory() ? ('dir' as const) : d.isSymbolicLink() ? ('symlink' as const) : ('file' as const),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { path: relative(ctx.workspaceRoot ?? '', resolved) || '.', entries };
    });
  },
};

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

const MAX_SCAN_ENTRIES = 5000;
const DEFAULT_MAX_RESULTS = 200;
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);

/**
 * Converts a small glob subset (`*`, `**`, `?`) to a RegExp matched against
 * a forward-slash-normalised relative path. A `**` segment (followed by a
 * slash) matches zero or more whole path segments (standard glob
 * semantics), NOT "any characters including a slash" -- so a pattern like
 * "src, then **, then a slash, then *.ts" also matches "src/a.ts" directly,
 * with the "**" segment contributing nothing, not just deeper nested files.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === '*' && glob.charAt(i + 1) === '*') {
      i += 2;
      if (glob.charAt(i) === '/') {
        out += '(?:.*/)?';
        i += 1;
      } else {
        out += '.*';
      }
      continue;
    }
    if (c === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

interface SearchMatch {
  path: string;
  line?: number;
  preview?: string;
}

export const searchFilesTool: ToolSpec = {
  name: 'search_files',
  description:
    'Searches the workspace for files. Supply "glob" to match filenames (supports *, **, ?), "query" to grep ' +
    'file contents (plain substring), or both. Binary files are silently skipped when grepping content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to search under, relative to the workspace root (default: workspace root).' },
      glob: { type: 'string', description: 'Filename glob pattern, e.g. "src/**/*.ts".' },
      query: { type: 'string', description: 'Plain-text substring to search for inside file contents.' },
      maxResults: { type: 'integer', minimum: 1, description: `Maximum matches to return (default ${DEFAULT_MAX_RESULTS}).` },
    },
  },
  risk: 'read',
  source: 'fs',
  async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
    return runTool(async () => {
      const path = optionalString(args, 'path') ?? '.';
      const glob = optionalString(args, 'glob');
      const query = optionalString(args, 'query');
      const maxResults = optionalPositiveInt(args, 'maxResults') ?? DEFAULT_MAX_RESULTS;
      if (!glob && !query) throw new ArgsError('Provide at least one of "glob" or "query".');

      const root = containPath(ctx.workspaceRoot, path);
      const globRegExp = glob ? globToRegExp(glob) : null;
      const matches: SearchMatch[] = [];
      let scanned = 0;
      let truncated = false;

      async function walk(dir: string): Promise<void> {
        if (truncated) return;
        let dirents;
        try {
          // Every directory in the walk is re-verified, not just the root
          // the walk started from: a subdirectory listed as a real directory
          // a moment ago can be a junction out of the workspace by the time
          // we descend into it, and the walk would then enumerate whatever
          // it points at. Same bracketing (and same residual) as list_dir.
          ({ dirents } = await readdirVerified(ctx.workspaceRoot, dir));
        } catch {
          return; // vanished mid-walk, swapped, or unreadable -- skip rather than fail the whole search
        }
        for (const d of dirents) {
          if (truncated) return;
          if (d.isSymbolicLink()) continue; // never follow links out of the walk (see module TOCTOU note)
          const full = join(dir, d.name);
          if (d.isDirectory()) {
            if (SKIP_DIR_NAMES.has(d.name)) continue;
            scanned++;
            if (scanned > MAX_SCAN_ENTRIES) {
              truncated = true;
              return;
            }
            await walk(full);
            continue;
          }
          if (!d.isFile()) continue;
          scanned++;
          if (scanned > MAX_SCAN_ENTRIES) {
            truncated = true;
            return;
          }

          const relPath = relative(root, full).split(sep).join('/');
          if (globRegExp && !globRegExp.test(relPath)) continue;

          if (!query) {
            matches.push({ path: relPath });
          } else {
            const found = await grepFile(ctx.workspaceRoot, full, query);
            for (const m of found) {
              matches.push({ path: relPath, line: m.line, preview: m.preview });
              if (matches.length >= maxResults) {
                truncated = true;
                return;
              }
            }
          }
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      }

      await walk(root);
      return { matches: matches.slice(0, maxResults), truncated };
    });
  },
};

/** Greps one file's content for `query`, reusing openVerified for the same TOCTOU protection read_file gets. */
async function grepFile(
  workspaceRoot: string | null,
  absolutePath: string,
  query: string
): Promise<{ line: number; preview: string }[]> {
  let handle: FileHandle;
  try {
    ({ handle } = await openVerified(workspaceRoot, absolutePath, fsConstants.O_RDONLY));
  } catch {
    return []; // vanished/swapped mid-walk -- skip this file rather than fail the whole search
  }
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_READ_BYTES || (await sniffBinary(handle))) return [];
    const buf = Buffer.alloc(stat.size);
    await handle.read(buf, 0, stat.size, 0);
    const lines = buf.toString('utf8').split('\n');
    const out: { line: number; preview: string }[] = [];
    lines.forEach((lineText, idx) => {
      if (lineText.includes(query)) {
        out.push({ line: idx + 1, preview: lineText.trim().slice(0, 200) });
      }
    });
    return out;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export const writeFileTool: ToolSpec = {
  name: 'write_file',
  description: 'Writes (creates or overwrites) a UTF-8 text file inside the workspace, creating parent directories as needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to the workspace root (or absolute).' },
      content: { type: 'string', description: 'The full text content to write.' },
    },
    required: ['path', 'content'],
  },
  risk: 'mutate',
  source: 'fs',
  async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
    return runTool(async () => {
      const path = requireString(args, 'path');
      const content = requireString(args, 'content');

      // Deliberately NOT O_TRUNC. O_TRUNC truncates at open() -- before
      // openVerified has compared identities, before the hard-link check,
      // before the second containment verdict. The file was therefore
      // already destroyed by the time the guard refused: 13 files outside
      // the workspace were zeroed and *then* refused with `toctou_guard` in
      // the reproduction. A mitigation that destroys the thing it is
      // protecting is not a mitigation. Truncation happens below, through
      // the verified handle, once we know what we are holding.
      const { handle, resolved } = await openVerified(
        ctx.workspaceRoot,
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT,
        { createParents: true }
      );
      try {
        const buf = Buffer.from(content, 'utf8');
        await handle.write(buf, 0, buf.length, 0);
        // Shrink last, so a crash mid-write leaves a longer file rather than
        // a moment where the file is empty.
        await handle.truncate(buf.length);
        return { path: relative(ctx.workspaceRoot ?? '', resolved) || resolved, bytesWritten: buf.length };
      } finally {
        await handle.close();
      }
    });
  },
};

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export const editFileTool: ToolSpec = {
  name: 'edit_file',
  description:
    'Replaces an exact, unique substring occurrence within a text file inside the workspace. Fails if oldString ' +
    'is not found, or found more than once (ambiguous -- add surrounding context to make it unique).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to the workspace root (or absolute).' },
      oldString: { type: 'string', description: 'Exact text to find; must occur exactly once in the file.' },
      newString: { type: 'string', description: 'Text to replace it with.' },
    },
    required: ['path', 'oldString', 'newString'],
  },
  risk: 'mutate',
  source: 'fs',
  async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
    return runTool(async () => {
      const path = requireString(args, 'path');
      const oldString = requireString(args, 'oldString');
      const newString = requireString(args, 'newString');
      if (oldString === '') throw new ArgsError('"oldString" must not be empty.');

      // Held open across the whole read-modify-write so there is exactly one
      // containment check and one identity verification for the entire
      // operation, rather than a separate resolve+open for the read and
      // another for the write (which would reopen a second TOCTOU window
      // between them).
      const { handle, resolved } = await openVerified(ctx.workspaceRoot, path, fsConstants.O_RDWR);
      try {
        const stat = await handle.stat();
        if (stat.isDirectory()) throw Object.assign(new Error(`"${path}" is a directory.`), { code: 'EISDIR' });
        if (stat.size > MAX_READ_BYTES) {
          throw new FileTooLargeError(
            `"${path}" is larger than the 1MB edit cap; refusing to risk a truncated read-modify-write.`
          );
        }
        if (await sniffBinary(handle)) {
          throw new BinaryFileError(`"${path}" looks like a binary file and was not edited.`);
        }

        const buf = Buffer.alloc(stat.size);
        await handle.read(buf, 0, stat.size, 0);
        const content = buf.toString('utf8');

        const count = content.split(oldString).length - 1;
        if (count === 0) throw new Error(`oldString was not found in "${path}".`);
        if (count > 1) throw new NotUniqueError(count);

        const updated = content.split(oldString).join(newString);
        const updatedBuf = Buffer.from(updated, 'utf8');
        await handle.truncate(updatedBuf.length);
        await handle.write(updatedBuf, 0, updatedBuf.length, 0);

        return { path: relative(ctx.workspaceRoot ?? '', resolved) || resolved, replaced: true };
      } finally {
        await handle.close();
      }
    });
  },
};

// ---------------------------------------------------------------------------

export const fsTools: ToolSpec[] = [readFileTool, listDirTool, searchFilesTool, writeFileTool, editFileTool];

// Re-exported for tests that want to assert on these guards specifically.
export { ToctouGuardError, HardLinkError };

/**
 * Test-only access to internals that have no seam on the public `ToolSpec`
 * surface (`execute(args, ctx)` takes no race hooks, deliberately -- they
 * must never be reachable from model-controlled input). Used exclusively by
 * fs-tools.test.ts to drive the guards with a real, deterministic filesystem
 * race. Not part of this package's public API.
 */
export const __testing = { openVerified, readdirVerified };
