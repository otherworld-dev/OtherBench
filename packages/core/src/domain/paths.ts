import { realpathSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, relative, dirname, join, sep } from 'node:path';

export class PathEscapeError extends Error {
  constructor(public readonly candidate: string) {
    super(`Path escapes the workspace: ${candidate}`);
    this.name = 'PathEscapeError';
  }
}

function realpathNearest(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    tail.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

export function containPath(workspaceRoot: string | null, candidate: string): string {
  if (!workspaceRoot) throw new PathEscapeError(candidate);
  // An embedded NUL is treated as a string terminator by some OS-level path
  // probes (e.g. existsSync on Windows truncates at it) but not by others
  // (e.g. realpathSync validates and rejects it). That split-brain lets a
  // candidate like "<root>\ok.txt\0<absolute outside path>" look validly
  // contained under plain string comparison while its real filesystem
  // meaning is ambiguous. Refuse it outright rather than reason about it.
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
    // Any failure to resolve the candidate (e.g. platform-specific path
    // parsing quirks) must fail closed as PathEscapeError, not leak an
    // arbitrary internal error to callers that only guard against the one
    // typed error this function promises to throw.
    if (err instanceof PathEscapeError) throw err;
    throw new PathEscapeError(candidate);
  }
}
