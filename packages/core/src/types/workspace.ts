/**
 * Machines and portable folders (v2 spec §6). Every Grunt install is a node
 * with its own id. A chat's folder is either location-relative -- a named
 * place that each machine maps to its own path, plus a subfolder -- or bound
 * to one machine's absolute path.
 */

/** A chat's folder, as stored (and synced). */
export type Workspace =
  /** Resolves on any machine that has a path for the location. `subpath` uses `/`, and is '' for the location itself. */
  | { kind: 'location'; locationId: string; subpath: string }
  /** An absolute path that only means something on `nodeId`. */
  | { kind: 'machine'; nodeId: string; root: string };

/** What the model may do in an extra folder, always within the profile's own file policy. */
export type FolderAccess = 'read' | 'readwrite';

/**
 * A folder a chat may use besides its workspace (spec 2026-10-07-extra-folders),
 * stored and synced portably like the workspace itself.
 */
export interface ExtraFolder {
  workspace: Workspace;
  access: FolderAccess;
}

/** An extra folder resolved on the machine running a turn: what its tools may reach. */
export interface ResolvedFolder {
  root: string;
  access: FolderAccess;
}

/** API only: an extra folder as it is on the machine that runs the chat. */
export interface FolderView extends ExtraFolder {
  /** Its path there, or where it's expected (null when unknown). */
  root: string | null;
  status: WorkspaceStatus;
}

/** A named place, e.g. "Nextcloud", that each machine keeps at its own path. */
export interface Location {
  id: string;
  name: string;
}

/** Where `locationId` is on `nodeId`. Each machine writes only its own rows. */
export interface LocationPath {
  locationId: string;
  nodeId: string;
  path: string;
}

/** One Grunt install. */
export interface NodeInfo {
  id: string;
  name: string;
}

/**
 * Whether a chat's folder is usable on this machine, and if not, why:
 * - `no-location-path`: the location has no path here yet ("Where is Nextcloud on this machine?").
 * - `other-machine`: the folder is bound to another machine's absolute path.
 * - `missing`: it resolves here, but the folder doesn't exist (moved or renamed).
 * `hint` says where it is elsewhere (or where it was expected here), for the prompt.
 */
export type WorkspaceStatus =
  | { status: 'none' }
  | { status: 'ok'; root: string }
  | { status: 'unresolved'; reason: 'no-location-path' | 'other-machine' | 'missing'; hint?: { nodeId: string; path: string } };
