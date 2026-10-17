import type { Chat } from '@otherbench/core/ports/store.js';
import { api, type PeersOverview } from './api.js';
import { useOtherBenchStore, type StreamConnectionStatus } from './store.js';
export { chatsWorkingElsewhere, workingElsewhere } from './peerActivity.js';

/**
 * This machine and its paired machines, as the UI needs them to show where
 * a chat runs (v2 plan, Task 53). Reloaded at start-up and whenever the
 * events stream says a machine was paired, removed, or came or went.
 */
export function refreshMachines(): void {
  Promise.resolve()
    .then(() => api.peers.overview())
    .then((overview) => useOtherBenchStore.getState().setMachines(overview))
    .catch((err: unknown) => console.error('[otherbench-web] failed to load machines:', err));
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

const STREAM_STATUS_LABEL: Record<StreamConnectionStatus, string> = {
  idle: '',
  connecting: 'Connecting…',
  open: '',
  reconnecting: 'Reconnecting…',
};

/**
 * The header's line for the open chat's live stream. A chat that runs on a
 * machine that can't be reached never connects (its stream is forwarded
 * there), so it says so rather than flipping between connecting and
 * reconnecting; the stream keeps retrying and picks up when the machine is back.
 */
export function streamStatusText(status: StreamConnectionStatus, chat: Pick<Chat, 'runsOn'>, machines: PeersOverview | null): string {
  if (remoteUnreachable(machines, chat)) return `${machineName(machines, chat.runsOn)} isn't reachable`;
  return STREAM_STATUS_LABEL[status];
}

/**
 * Other machines with a reply running in another chat in this chat's folder
 * (the same location and subfolder). OtherBench can't lock files across machines,
 * so the workspace says so (v2 spec, "Concurrent work in the same folder").
 */
export function alsoActive(machines: PeersOverview | null, chats: Chat[], chat: Pick<Chat, 'id' | 'workspace'>): { machine: string; chatId: string; title: string }[] {
  const here = chat.workspace;
  if (!machines || here?.kind !== 'location') return [];
  const out: { machine: string; chatId: string; title: string }[] = [];
  for (const peer of machines.peers) {
    if (peer.status !== 'reachable') continue;
    for (const id of peer.activeChats ?? []) {
      if (id === chat.id) continue;
      const other = chats.find((c) => c.id === id);
      const there = other?.workspace;
      if (other && there?.kind === 'location' && there.locationId === here.locationId && there.subpath === here.subpath) {
        out.push({ machine: peer.name, chatId: other.id, title: other.title });
      }
    }
  }
  return out;
}

export function isReachablePeer(machines: PeersOverview | null, nodeId: string): boolean {
  return machines?.peers.some((p) => p.nodeId === nodeId && p.status === 'reachable') ?? false;
}
