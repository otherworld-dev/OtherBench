import type { Location, LocationPath, NodeInfo } from '../../types/workspace.js';
import type { Peer } from '../../types/peer.js';

// --- machines and locations (v2 spec §6) ------------------------------------

export interface NodeRepo {
  /** This machine: created once, with a random id, when the database is first opened. */
  self(): NodeInfo;
  rename(name: string): NodeInfo;
}

export interface LocationRepo {
  list(): Location[];
  get(id: string): Location | null;
  create(l: Location): Location;
  update(id: string, patch: Partial<Omit<Location, 'id'>>): Location;
  /** Also removes its paths; chats using it lose their folder (ON DELETE SET NULL). */
  delete(id: string): void;
  /** Every machine's path for every location. */
  allPaths(): LocationPath[];
  paths(locationId: string): LocationPath[];
  pathsForNode(nodeId: string): LocationPath[];
  /** Creates or replaces `nodeId`'s path for the location. */
  setPath(p: LocationPath): LocationPath;
  deletePath(locationId: string, nodeId: string): void;
}

/** Paired machines (v2 spec §3). Never synced. */
export interface PeerRepo {
  list(): Peer[];
  get(nodeId: string): Peer | null;
  getByFingerprint(fingerprint: string): Peer | null;
  /** A second peer with the same node id or fingerprint throws. */
  create(p: Peer): Peer;
  update(nodeId: string, patch: Partial<Omit<Peer, 'nodeId'>>): Peer;
  delete(nodeId: string): void;
}
