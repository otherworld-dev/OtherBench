import type { Chat } from '@otherbench/core/ports/store.js';
import type { PeersOverview } from '../../state/api.js';

/** The key of the section holding every chat that runs on a machine no longer paired. Node ids are UUIDs. */
export const UNPAIRED_MACHINE_KEY = '__unpaired__';

/** Another machine's part of the Needs you list: its chats, in queue order, under a heading of its own. */
export interface MachineQueue {
  /** The machine's node id, or `UNPAIRED_MACHINE_KEY`. */
  key: string;
  name: string;
  chats: Chat[];
}

/**
 * Splits the Needs you queue by where each chat runs: this machine's chats lead the list, and each other machine
 * with a chat waiting gets its own section after them, in the paired machines' order, with chats on machines no
 * longer paired together at the end. Each keeps the queue's order. A machine's own work is what the user is at
 * that machine for; another's would otherwise drown it out (Adam, 2026-11-06). Before the machines load, every
 * chat counts as this machine's, as before.
 */
export function splitByMachine(queue: readonly Chat[], machines: PeersOverview | null): { here: Chat[]; elsewhere: MachineQueue[] } {
  if (!machines) return { here: [...queue], elsewhere: [] };
  const here: Chat[] = [];
  const byKey = new Map<string, Chat[]>();
  const paired = new Set(machines.peers.map((p) => p.nodeId));
  for (const chat of queue) {
    if (chat.runsOn === machines.self.id) {
      here.push(chat);
      continue;
    }
    const key = paired.has(chat.runsOn) ? chat.runsOn : UNPAIRED_MACHINE_KEY;
    const list = byKey.get(key);
    if (list) list.push(chat);
    else byKey.set(key, [chat]);
  }
  const elsewhere: MachineQueue[] = [];
  for (const peer of machines.peers) {
    const chats = byKey.get(peer.nodeId);
    if (chats) elsewhere.push({ key: peer.nodeId, name: peer.name, chats });
  }
  const unpaired = byKey.get(UNPAIRED_MACHINE_KEY);
  if (unpaired) elsewhere.push({ key: UNPAIRED_MACHINE_KEY, name: 'Machines no longer paired', chats: unpaired });
  return { here, elsewhere };
}
