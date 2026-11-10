import { dirname, isAbsolute, join, relative } from 'node:path';
import { containPath, PathEscapeError } from '@otherbench/core/domain/paths.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { PeerFolderListing, PeerFolderLocation } from '@otherbench/core/types/workspace.js';
import { HardLinkError, readdirVerified, ToctouGuardError } from '@otherbench/tools/fs-tools.js';

/**
 * The folder browser a paired machine may use here (HANDOVER "What is NOT built", the part of v2 Task 53 that was
 * left out): for choosing a folder for a chat that runs here from the machine whose UI it is open in. Deliberately not
 * `GET /api/fs/dirs`, which lists directories anywhere on this machine and is never on the peer listener. This lists
 * only inside this machine's OWN locations, and only those whose path was set on this machine (`pathsSetHere(self)`:
 * a paired machine's paths are its folders, not ours, and a path for this machine that a paired machine filled in by
 * sync is never listed until it is set again here), and only sub-folder names with their paths: no file names, no
 * sizes, nothing read inside a folder.
 *
 * Every path goes through `containPath` against a location root, and the listing itself through fs-tools'
 * `readdirVerified`, which brackets the `readdir` with identity checks and a second containPath verdict (read its
 * DIRECTORY LISTINGS paragraph for the residual: a swap made and undone entirely inside the `readdir` call is not
 * seen). A junction or symlink is never listed, and a path through one that leads out of the location is refused as
 * outside it. Here a residual race costs at most the names of one directory's sub-folders, and only to a paired
 * machine, which can already run a shell here once a person approves it.
 */

/** The most sub-folders one listing carries: a folder with more says so (`truncated`). */
export const MAX_LISTED_DIRS = 1000;
/** The most locations a listing carries. */
const MAX_LOCATIONS = 100;
/** The longest path and folder name taken from a paired machine's listing. */
const MAX_PATH = 4096;
const MAX_NAME = 255;

/** A refusal, as the route answers it. */
export interface LocationDirsRefusal {
  status: 400 | 403 | 404;
  kind: 'bad_path' | 'outside_locations' | 'not_found' | 'not_a_folder' | 'unreadable';
  error: string;
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' });

/**
 * This machine's locations whose path here was set HERE, by name. Not every row `pathsForNode(self)` has: a paired
 * machine may fill in this machine's path for a location that has none yet (adopting a location), and such a synced
 * row could name `C:\` and so open everything to browsing. A synced path becomes browsable only once it is set
 * again in Settings → Locations on this machine (`pathsSetHere`, the `set_here` column no peer can write).
 */
function ownLocations(store: Store): PeerFolderLocation[] {
  const self = store.nodes.self().id;
  return store.locations
    .pathsSetHere(self)
    .map((p) => ({ id: p.locationId, name: store.locations.get(p.locationId)?.name ?? 'Location', root: p.path }))
    .sort((a, b) => byName(a.name, b.name))
    .slice(0, MAX_LOCATIONS);
}

/** `root` resolved as containPath resolves it (its links followed), or null when it can't be. */
function realRoot(root: string): string | null {
  try {
    return containPath(root, root);
  } catch {
    return null;
  }
}

/**
 * The listing for `raw` (an absolute path on this machine), or for no path the list of this machine's locations;
 * a refusal for anything outside them. The innermost location that contains it wins, as when a typed path is
 * classified. Paths in the answer are written under the location's root as configured here, so a folder chosen
 * from it is stored in that location.
 */
export async function listLocationDirs(store: Store, raw: string | undefined): Promise<PeerFolderListing | LocationDirsRefusal> {
  const locations = ownLocations(store);
  if (raw === undefined || raw === '') return { path: null, parent: null, location: null, dirs: [], truncated: false, locations };
  const here = store.nodes.self().name;
  if (raw.includes('\0') || raw.length > MAX_PATH || !isAbsolute(raw)) return { status: 400, kind: 'bad_path', error: `"path" must be an absolute path on ${here}.` };

  let best: { location: PeerFolderLocation; real: string } | null = null;
  for (const location of locations) {
    const real = realRoot(location.root);
    if (real === null) continue;
    try {
      containPath(location.root, raw);
    } catch {
      continue;
    }
    if (!best || real.length > best.real.length) best = { location, real };
  }
  const outside: LocationDirsRefusal = { status: 403, kind: 'outside_locations', error: `That folder isn't in one of ${here}'s locations, so it can't be browsed from another machine.` };
  if (best === null) return outside;

  let listed: Awaited<ReturnType<typeof readdirVerified>>;
  try {
    listed = await readdirVerified(best.location.root, raw);
  } catch (err) {
    if (err instanceof PathEscapeError) return outside;
    if (err instanceof ToctouGuardError || err instanceof HardLinkError) return { status: 403, kind: 'unreadable', error: 'That folder changed while it was being read. Try again.' };
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { status: 404, kind: 'not_found', error: `No folder at "${raw}" on ${here}.` };
    if (code === 'ENOTDIR') return { status: 400, kind: 'not_a_folder', error: `"${raw}" is a file on ${here}, not a folder.` };
    if (code === 'EACCES' || code === 'EPERM') return { status: 403, kind: 'unreadable', error: `OtherBench can't read "${raw}" on ${here}.` };
    throw err;
  }

  const rest = relative(best.real, listed.resolved);
  // containPath said it is inside; a path that climbs out after all is still refused.
  if (rest.startsWith('..') || isAbsolute(rest)) return outside;
  const path = rest === '' ? best.location.root : join(best.location.root, rest);
  const names = listed.dirents.filter((d) => d.isDirectory()).map((d) => d.name).sort(byName);
  return {
    path,
    parent: rest === '' ? null : dirname(path),
    location: best.location,
    dirs: names.slice(0, MAX_LISTED_DIRS).map((name) => ({ name, path: join(path, name) })),
    truncated: names.length > MAX_LISTED_DIRS,
    locations,
  };
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

function locationOf(v: unknown): PeerFolderLocation | null {
  if (typeof v !== 'object' || v === null) return null;
  const { id, name, root } = v as Record<string, unknown>;
  return isText(id, MAX_NAME) && isText(name, MAX_NAME) && isText(root, MAX_PATH) ? { id, name, root } : null;
}

/**
 * A paired machine's listing, as far as it is one: every field the right type and bounded, at most MAX_LISTED_DIRS
 * folders (more says `truncated`) and only the fields a listing has. Null when it isn't one, so nothing of it is
 * shown. The names are only ever shown as text.
 */
export function peerFolderListingOf(said: unknown): PeerFolderListing | null {
  if (typeof said !== 'object' || said === null) return null;
  const s = said as Record<string, unknown>;
  const path = s['path'] === null ? null : isText(s['path'], MAX_PATH) ? s['path'] : undefined;
  const parent = s['parent'] === null ? null : isText(s['parent'], MAX_PATH) ? s['parent'] : undefined;
  const location = s['location'] === null ? null : locationOf(s['location']) ?? undefined;
  if (path === undefined || parent === undefined || location === undefined) return null;
  if (!Array.isArray(s['dirs']) || !Array.isArray(s['locations'])) return null;
  const dirs: { name: string; path: string }[] = [];
  for (const d of s['dirs'].slice(0, MAX_LISTED_DIRS)) {
    if (typeof d !== 'object' || d === null) return null;
    const { name, path: at } = d as Record<string, unknown>;
    if (!isText(name, MAX_NAME) || !isText(at, MAX_PATH)) return null;
    dirs.push({ name, path: at });
  }
  const locations: PeerFolderLocation[] = [];
  for (const l of s['locations'].slice(0, MAX_LOCATIONS)) {
    const kept = locationOf(l);
    if (!kept) return null;
    locations.push(kept);
  }
  return { path, parent, location, dirs, truncated: s['truncated'] === true || s['dirs'].length > MAX_LISTED_DIRS, locations };
}
