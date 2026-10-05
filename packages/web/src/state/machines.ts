import type { Chat } from '@grunt/core/ports/store.js';
import { api, type PeersOverview } from './api.js';
import { useGruntStore } from './store.js';

/**
 * This machine and its paired machines, as the UI needs them to show where
 * a chat runs (v2 plan, Task 53). Reloaded at start-up and whenever the
 * events stream says a machine was paired, removed, or came or went.
 */
export function refreshMachines(): void {
  Promise.resolve()
    .then(() => api.peers.overview())
    .then((overview) => useGruntStore.getState().setMachines(overview))
    .catch((err: unknown) => console.error('[grunt-web] failed to load machines:', err));
}

/** A machine's name: this one, a paired one, or a generic one for a machine no longer paired. */
export function machineName(machines: PeersOverview | null, nodeId: string): string {
  if (!machines) return 'another machine';
  if (nodeId === machines.self.id) return machines.self.name;
  return machines.peers.find((p) => p.nodeId === nodeId)?.name ?? 'a machine no longer paired';
}

/** Whether a chat runs on another machine that can't be reached now (or isn't paired any more). */
export function remoteUnreachable(machines: PeersOverview | null, chat: Pick<Chat, 'runsOn'>): boolean {
  if (!machines || chat.runsOn === machines.self.id) return false;
  const peer = machines.peers.find((p) => p.nodeId === chat.runsOn);
  return !peer || peer.status === 'unreachable';
}

export function isReachablePeer(machines: PeersOverview | null, nodeId: string): boolean {
  return machines?.peers.some((p) => p.nodeId === nodeId && p.status === 'reachable') ?? false;
}
