/** Locations, paired machines and this machine: `api.locations`, `api.peers` and `api.node`. */
import type { Location, LocationPath, NodeInfo } from '@otherbench/core/types/workspace.js';
import type { InferredMapping } from '@otherbench/core/domain/workspace.js';
import type { PeerSchedules, PublicPeer } from '@otherbench/core/types/peer.js';
import { request, post, put, patch, del } from './http.js';

/** A location with every machine's path for it (`GET /api/locations`). */
export interface LocationView extends Location {
  paths: LocationPath[];
}

export interface InferLocationResult {
  mapping: InferredMapping | null;
  /** A location that already has one of the two roots. */
  existing: Location | null;
  /** Chats and projects on that machine that adopting the mapping would move into it. */
  affected: number;
}

export interface AdoptLocationBody {
  /** An existing location; otherwise `name` creates one. */
  locationId?: string;
  name?: string;
  nodeId: string;
  fromRoot: string;
  toRoot: string;
}

export interface VersionMismatchView {
  peerAppVersion: string | null;
  peerSchemaVersion: number;
  peerProtocolVersion: number;
  /** The peer is ahead: updating this machine fixes it. */
  thisMachineOlder: boolean;
  at: number;
}

/** A paired machine as Settings → Machines shows it: the stored peer plus whether it's reachable now. */
export interface PeerView extends PublicPeer {
  status: 'unknown' | 'reachable' | 'unreachable';
  since: number;
  error?: string;
  /** When the last pull from it finished, and why the last one failed (until one succeeds). */
  lastSyncedAt: number | null;
  syncError: string | null;
  /** Sync is stopped because the two machines run different versions (server peer/syncer.ts); absent from older servers. */
  versionMismatch?: VersionMismatchView | null;
  /** Its own chats with a reply running there now, while it's reachable (#790); absent means none. */
  activeChats?: string[];
  /** Its own chats with background tasks running there now, while it's reachable; absent means none (or an older machine). */
  backgroundChats?: string[];
  /** Its own chats waiting on a card there now, while it's reachable; absent means none (or an older machine). */
  waitingChats?: string[];
  /** Since when (ms) each of `waitingChats` has waited, for the Needs you order; absent from an older machine. */
  waitingSince?: Record<string, number>;
  /**
   * The chats controlling that machine now (computer use), with their last action, while it's reachable; absent means
   * none (or an older machine). The banner shows them, and its Stop is sent there.
   */
  computerSessions?: { chatId: string; lastAction?: string }[];
}

export interface PeersOverview {
  self: NodeInfo & { fingerprint: string };
  listening: { running: boolean; addresses: string[] };
  peers: PeerView[];
}

/** A pairing code this machine is showing. */
export interface PairingView {
  code: string;
  expiresAt: number;
  addresses: string[];
  fingerprint: string;
}

/** Named places each machine keeps at its own path (v2 spec §6). */
export const locationsApi = {
  list: () => request<LocationView[]>('/locations'),
  create: (body: { name: string; path?: string | null }) => post<LocationView>('/locations', body),
  rename: (id: string, name: string) => patch<LocationView>(`/locations/${id}`, { name }),
  /** This machine's path for it; null removes it. */
  setPath: (id: string, path: string | null) => put<LocationView>(`/locations/${id}/path`, { path }),
  delete: (id: string) => del(`/locations/${id}`),
  infer: (body: { nodeId: string; fromPath: string; toPath: string }) => post<InferLocationResult>('/locations/infer', body),
  adopt: (body: AdoptLocationBody) => post<{ location: LocationView; converted: number }>('/locations/adopt', body),
};

/** Paired machines (v2 spec §3). */
export const peersApi = {
  overview: () => request<PeersOverview>('/peers'),
  /** Shows a code here for the other machine to enter. */
  startPairing: () => post<PairingView>('/peers/pairing'),
  currentPairing: () => request<PairingView | null>('/peers/pairing'),
  cancelPairing: () => del('/peers/pairing'),
  /** Enters the code the other machine is showing. */
  add: (address: string, code: string) => post<PublicPeer>('/peers', { address, code }),
  patch: (nodeId: string, body: { name?: string; addresses?: string[] }) => patch<PublicPeer>(`/peers/${nodeId}`, body),
  remove: (nodeId: string) => request<{ notified: boolean }>(`/peers/${nodeId}`, { method: 'DELETE' }),
  sync: (nodeId: string) => post<{ applied: number }>(`/peers/${nodeId}/sync`),
  /** Each paired machine's schedules, as it last said: read-only, none while it isn't reachable. */
  schedules: () => request<PeerSchedules[]>('/peers/schedules'),
};

/** This machine. */
export const nodeApi = {
  get: () => request<NodeInfo>('/node'),
  rename: (name: string) => patch<NodeInfo>('/node', { name }),
};
