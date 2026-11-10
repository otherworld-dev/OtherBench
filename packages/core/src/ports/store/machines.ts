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
  /**
   * `nodeId`'s paths that were set through this store's own `setPath`, never one that arrived by sync. Called with
   * this machine's id: the folders a paired machine may browse here (a peer can fill in this machine's path for a
   * location that has none, so a synced one could name any folder).
   */
  pathsSetHere(nodeId: string): LocationPath[];
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
