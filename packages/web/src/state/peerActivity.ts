import type { PeersOverview } from './api.js';

/** The chats a reachable paired machine says it has a reply running in (each says so whenever one starts or ends). */
export function chatsWorkingElsewhere(machines: PeersOverview | null): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const peer of machines?.peers ?? []) {
    if (peer.status !== 'reachable') continue;
    for (const id of peer.activeChats ?? []) ids.add(id);
  }
  return ids;
}

/** The chats a reachable paired machine says have background tasks running there. */
export function chatsInBackgroundElsewhere(machines: PeersOverview | null): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const peer of machines?.peers ?? []) {
    if (peer.status !== 'reachable') continue;
    for (const id of peer.backgroundChats ?? []) ids.add(id);
  }
  return ids;
}

/** The chats a reachable paired machine says are waiting on a card there. */
export function chatsWaitingElsewhere(machines: PeersOverview | null): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const peer of machines?.peers ?? []) {
    if (peer.status !== 'reachable') continue;
    for (const id of peer.waitingChats ?? []) ids.add(id);
  }
  return ids;
}

/** Since when each chat in `chatsWaitingElsewhere` has waited on its card, where the machine says (an older one doesn't). */
export function waitingSinceElsewhere(machines: PeersOverview | null): ReadonlyMap<string, number> {
  const since = new Map<string, number>();
  for (const peer of machines?.peers ?? []) {
    if (peer.status !== 'reachable') continue;
    for (const [id, at] of Object.entries(peer.waitingSince ?? {})) since.set(id, Math.min(since.get(id) ?? at, at));
  }
  return since;
}

/** The name of the paired machine with a reply running in `chatId`, or null when none is. */
export function workingElsewhere(machines: PeersOverview | null, chatId: string): string | null {
  return machines?.peers.find((p) => p.status === 'reachable' && (p.activeChats ?? []).includes(chatId))?.name ?? null;
}
