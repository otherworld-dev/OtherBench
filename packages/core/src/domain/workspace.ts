import type { LocationPath, Workspace, WorkspaceStatus } from '../types/workspace.js';

/** The fields a chat or project carries for its folder: the stored one and the API-only view of it. */
interface WorkspaceFields {
  workspace?: Workspace | null;
  workspaceRoot?: string | null;
  workspaceStatus?: WorkspaceStatus;
}

/**
 * A chat or project (or a patch to one) as a store keeps it: without the
 * API-only `workspaceRoot`/`workspaceStatus`, and with a bare `workspaceRoot`
 * (the pre-locations shape, still accepted from callers that don't classify)
 * turned into a folder bound to this machine. An explicit `workspace` wins.
 */
export function toStoredWorkspace<T extends WorkspaceFields>(c: T, selfNodeId: string): Omit<T, 'workspaceRoot' | 'workspaceStatus'> {
  const { workspaceRoot, workspaceStatus: _view, ...rest } = c;
  if (rest.workspace === undefined && workspaceRoot !== undefined) {
    return { ...rest, workspace: workspaceRoot ? { kind: 'machine', nodeId: selfNodeId, root: workspaceRoot } : null };
  }
  return rest;
}

/**
 * Resolving portable workspaces per machine (v2 plan, Task 43). Pure: the
 * caller supplies this machine's id, the known location paths and an
 * existence check, so it's testable for any platform on any platform.
 */

/** True for a Windows-style absolute path (drive letter or UNC). */
function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//');
}

/** Path segments, ignoring separators of either kind and trailing ones. */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

/** Whether `a` and `b` are the same path segment: case-insensitive for Windows paths. */
function sameSegment(a: string, b: string, windows: boolean): boolean {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * If `abs` is `root` or inside it, the remaining segments; otherwise null.
 * Compares whole segments, so `E:\Next` never matches `E:\Nextcloud`.
 */
export function relativeSegments(root: string, abs: string): string[] | null {
  const windows = isWindowsPath(root) || isWindowsPath(abs);
  const r = segments(root);
  const a = segments(abs);
  if (r.length === 0 || a.length < r.length) return null;
  for (let i = 0; i < r.length; i++) if (!sameSegment(r[i]!, a[i]!, windows)) return null;
  return a.slice(r.length);
}

/** Joins a location path and a `/`-separated subpath with the location path's own separator. */
export function joinSubpath(root: string, subpath: string): string {
  const parts = segments(subpath);
  if (parts.length === 0) return root;
  const sep = isWindowsPath(root) ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + parts.join(sep);
}

/**
 * How to store a folder chosen on this machine: inside one of this machine's
 * location paths (the longest that matches wins) it becomes location-relative,
 * so it resolves on every machine that knows the location; anywhere else it
 * is bound to this machine.
 */
export function classifyPath(abs: string, selfNodeId: string, paths: LocationPath[]): Workspace {
  let best: { locationId: string; rest: string[]; depth: number } | null = null;
  for (const p of paths) {
    if (p.nodeId !== selfNodeId) continue;
    const rest = relativeSegments(p.path, abs);
    if (rest === null) continue;
    const depth = segments(p.path).length;
    if (!best || depth > best.depth) best = { locationId: p.locationId, rest, depth };
  }
  if (best) return { kind: 'location', locationId: best.locationId, subpath: best.rest.join('/') };
  return { kind: 'machine', nodeId: selfNodeId, root: abs };
}

/** Whether a chat's folder is usable on this machine (see `WorkspaceStatus`). */
export function resolveWorkspace(
  ws: Workspace | null,
  selfNodeId: string,
  paths: LocationPath[],
  exists: (p: string) => boolean
): WorkspaceStatus {
  if (ws === null) return { status: 'none' };
  if (ws.kind === 'machine') {
    if (ws.nodeId !== selfNodeId) return { status: 'unresolved', reason: 'other-machine', hint: { nodeId: ws.nodeId, path: ws.root } };
    return exists(ws.root) ? { status: 'ok', root: ws.root } : { status: 'unresolved', reason: 'missing', hint: { nodeId: selfNodeId, path: ws.root } };
  }
  const here = paths.find((p) => p.locationId === ws.locationId && p.nodeId === selfNodeId);
  if (!here) {
    const elsewhere = paths.find((p) => p.locationId === ws.locationId);
    return {
      status: 'unresolved',
      reason: 'no-location-path',
      ...(elsewhere ? { hint: { nodeId: elsewhere.nodeId, path: joinSubpath(elsewhere.path, ws.subpath) } } : {}),
    };
  }
  const root = joinSubpath(here.path, ws.subpath);
  return exists(root) ? { status: 'ok', root } : { status: 'unresolved', reason: 'missing', hint: { nodeId: selfNodeId, path: root } };
}

/** A pair of folders that are the same place on two machines, inferred from a folder known on both. */
export interface InferredMapping {
  /** The location's root on the machine the folder came from. */
  fromRoot: string;
  /** The location's root on this machine. */
  toRoot: string;
  /** The folder's segments below the roots (the same on both). */
  tail: string[];
  /** A name for the location: the root's own folder name. */
  name: string;
}

/** Whether `s` is a drive (`E:`), which is never part of a folder's own name. */
function isDrive(s: string): boolean {
  return /^[A-Za-z]:$/.test(s);
}

/** `p`'s first `count` segments as a path in `p`'s own style. */
function prefixPath(p: string, count: number): string {
  const parts = segments(p).slice(0, count);
  if (!isWindowsPath(p)) return '/' + parts.join('/');
  if (p.startsWith('\\\\') || p.startsWith('//')) return '\\\\' + parts.join('\\');
  return parts.length === 1 ? `${parts[0]}\\` : parts.join('\\');
}

/**
 * The location a folder on another machine (`from`) and the same folder here
 * (`to`) imply (v2 plan, Task 44): the longest run of trailing folder names
 * they share, rooted at its first name. `E:\Nextcloud\phd` and
 * `C:\Users\Adam\Nextcloud\phd` give `E:\Nextcloud` and
 * `C:\Users\Adam\Nextcloud`. Names compare ignoring case when either path is
 * a Windows one. Null when even the last names differ.
 */
export function inferLocationMapping(from: string, to: string): InferredMapping | null {
  const windows = isWindowsPath(from) || isWindowsPath(to);
  const f = segments(from);
  const t = segments(to);
  let shared = 0;
  while (shared < f.length && shared < t.length) {
    const a = f[f.length - 1 - shared]!;
    const b = t[t.length - 1 - shared]!;
    if (isDrive(a) || isDrive(b) || !sameSegment(a, b, windows)) break;
    shared++;
  }
  if (shared === 0) return null;
  const fromRootLength = f.length - shared + 1;
  const toRootLength = t.length - shared + 1;
  return {
    fromRoot: prefixPath(from, fromRootLength),
    toRoot: prefixPath(to, toRootLength),
    tail: f.slice(fromRootLength),
    name: t[toRootLength - 1]!,
  };
}

/**
 * `ws` moved into a location, if it's a folder bound to `nodeId` at or under
 * `fromRoot` (that machine's path for the location); otherwise null.
 */
export function adoptIntoLocation(ws: Workspace | null, nodeId: string, fromRoot: string, locationId: string): Workspace | null {
  if (ws?.kind !== 'machine' || ws.nodeId !== nodeId) return null;
  const rest = relativeSegments(fromRoot, ws.root);
  return rest === null ? null : { kind: 'location', locationId, subpath: rest.join('/') };
}
