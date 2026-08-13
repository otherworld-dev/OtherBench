import { constants as fsConstants, lstatSync } from 'node:fs';
import { mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
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

async function runTool<T>(fn: () => Promise<T>): Promise<T | ToolError> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PathEscapeError) return toolError('path_escape', err.message);
    if (err instanceof ToctouGuardError) return toolError('toctou_guard', err.message);
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
// TOCTOU mitigation
// ---------------------------------------------------------------------------
//
// containPath() (packages/core/src/domain/paths.ts) validates a candidate
// path and returns the resolved, contained path -- but a known, previously
// ACCEPTED risk is that nothing stops the filesystem from changing between
// that check and whatever the caller does with the returned path next (e.g.
// an ancestor directory swapped for a junction/symlink after the check).
// That acceptance was explicitly conditioned on revisiting it "the moment a
// link-creating or shell tool lands" -- this package (task 23/24) is that
// moment, so every fs tool that touches file CONTENT goes through
// openVerified() below rather than resolving a path and separately
// acting on it later.
//
// openVerified() collapses "resolve, then act" into "resolve, snapshot an
// identity immediately, act, and verify the identity didn't change":
//
//   1. containPath() resolves and validates the candidate (T0).
//   2. Immediately (the very next statements, no intervening I/O other than
//      mkdir for brand-new parents, which only ever creates directories we
//      ourselves just made and so cannot have been swapped) we lstat
//      whichever of {the target itself, its nearest existing ancestor}
//      exists at T0 and remember its identity (device + inode).
//   3. We open the target with O_NOFOLLOW where the platform supports it
//      (POSIX; verified absent on this project's Windows Node build, see
//      below) and fstat the resulting handle at T1.
//   4. If the resolved target existed at T0, its T1 handle identity must
//      match the T0 snapshot exactly, or we refuse (ToctouGuardError).
//      Empirically verified (see task-22-24-report.md) that this DOES
//      detect the exact scenario the original ruling described -- an
//      ancestor directory replaced by a junction between check and use,
//      redirecting a literal in-workspace path string to a target outside
//      the workspace -- because re-opening that same literal path after the
//      swap yields a file whose fstat identity differs from what the T0
//      lstat recorded, even though both lstat and fstat expose ino/dev
//      identically on this platform (also verified empirically; this is
//      NOT a POSIX-only technique here).
//   5. If the resolved target did NOT exist at T0 (a brand new file being
//      created by write_file), there is no prior file identity to compare;
//      instead the NEAREST EXISTING ANCESTOR's identity is snapshotted and
//      re-checked after the open, which catches the same ancestor-swap
//      class of attack for new-file writes too.
//
// What this does NOT close (accepted residual risk, precisely scoped, not
// the vague "nothing creates links" statement the original comment made):
//   - O_NOFOLLOW is unavailable on this Windows Node build (fs.constants
//     has no O_NOFOLLOW key at all here -- verified empirically). The
//     final-path-component symlink race therefore relies ENTIRELY on the
//     post-open identity comparison in step 4, not on the OS refusing to
//     follow the link. That comparison is still sound (see above) but it
//     means a swapped-final-component open briefly succeeds against the
//     WRONG file before being caught and closed, rather than failing to
//     open at all. On POSIX platforms where O_NOFOLLOW is defined, it is
//     included and fails the open() outright, so this gap is Windows-only.
//   - A swap that happens strictly BETWEEN this function's own snapshot and
//     its own open()/fstat() calls -- a handful of synchronous statements
//     with no scheduling point in between for anything else to run. Node
//     exposes no portable "resolve and open atomically beneath a given
//     root" primitive (no openat2(RESOLVE_BENEATH) equivalent), so this is
//     the tightest window achievable without shelling out to
//     platform-specific syscalls. The window has gone from "however long it
//     takes an LLM turn to get around to using a previously-resolved path"
//     to "a few synchronous statements of pure computation" -- treated as
//     acceptable.
//   - list_dir and the filename/glob side of search_files never hold an
//     open handle to verify against (Node's readdir has no O_NOFOLLOW or
//     fstat-by-handle equivalent for directory identity that's portable
//     here). A swap can misdirect a LISTING (the model sees filenames from
//     the wrong directory) but cannot itself leak or corrupt file content,
//     because content access always goes through openVerified regardless of
//     how a path was discovered (search_files' content-grep branch reuses
//     it per matched file). Documented, not closed: disproportionate effort
//     for the residual severity.

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

function presentSync(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingAncestorSync(p: string): string {
  let cur = p;
  while (!presentSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

interface VerifiedOpen {
  handle: FileHandle;
  resolved: string;
  /** Whether `resolved` already existed at containment-check time. */
  existed: boolean;
}

/**
 * Resolves+validates `candidate` via containPath, opens it with the given
 * flags, and verifies the opened target's identity has not changed since
 * the check -- see the module-level TOCTOU comment above for the full
 * reasoning and precisely what this does and does not cover.
 *
 * `__raceHookForTests`, when supplied, runs after the T0 identity snapshot
 * and before the open() call -- i.e. exactly the window this function
 * exists to narrow. It is a deliberate test-only seam (not part of
 * `ToolSpec`'s public surface, and never wired to model-controlled input)
 * that lets fs-tools.test.ts perform a REAL filesystem swap deterministically
 * inside that window and assert the guard actually fires, rather than only
 * asserting on the identity-comparison logic in isolation. Undefined in
 * every real call site below.
 */
async function openVerified(
  workspaceRoot: string | null,
  candidate: string,
  flags: number,
  opts: { createParents?: boolean; __raceHookForTests?: () => void | Promise<void> } = {}
): Promise<VerifiedOpen> {
  const resolved = containPath(workspaceRoot, candidate);
  const existed = presentSync(resolved);
  const snapshotPath = existed ? resolved : nearestExistingAncestorSync(resolved);
  const before = presentSync(snapshotPath) ? lstatSync(snapshotPath) : null;

  if (opts.createParents) {
    await mkdir(dirname(resolved), { recursive: true });
  }

  if (opts.__raceHookForTests) await opts.__raceHookForTests();

  const handle = await open(resolved, flags | NOFOLLOW);

  try {
    if (existed) {
      const after = await handle.stat();
      if (!before || after.ino !== before.ino || after.dev !== before.dev) {
        throw new ToctouGuardError(candidate);
      }
    } else if (before) {
      const after = presentSync(snapshotPath) ? lstatSync(snapshotPath) : null;
      if (!after || after.ino !== before.ino || after.dev !== before.dev) {
        throw new ToctouGuardError(candidate);
      }
    }
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }

  return { handle, resolved, existed };
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
      const resolved = containPath(ctx.workspaceRoot, path);
      const dirents = await readdir(resolved, { withFileTypes: true });
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
          dirents = await readdir(dir, { withFileTypes: true });
        } catch {
          return; // vanished mid-walk, or unreadable -- skip rather than fail the whole search
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

      const { handle, resolved } = await openVerified(
        ctx.workspaceRoot,
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
        { createParents: true }
      );
      try {
        const buf = Buffer.from(content, 'utf8');
        await handle.write(buf, 0, buf.length, 0);
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

// Re-exported for tests that want to assert on the TOCTOU guard specifically.
export { ToctouGuardError };

/**
 * Test-only access to internals that have no seam on the public `ToolSpec`
 * surface (`execute(args, ctx)` takes no race hook, deliberately -- it must
 * never be reachable from model-controlled input). Used exclusively by
 * fs-tools.test.ts to drive openVerified's TOCTOU guard with a real,
 * deterministic filesystem race. Not part of this package's public API.
 */
export const __testing = { openVerified };
