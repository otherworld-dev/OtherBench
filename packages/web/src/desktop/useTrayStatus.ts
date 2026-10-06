import { useEffect, useState } from 'react';
import type { PeersOverview } from '../state/api.js';
import { refreshMachines } from '../state/machines.js';
import { selectPendingApprovalCount, useGruntStore } from '../state/store.js';
import { peerStatusText } from '../views/settings/MachinesPanel.js';
import { isDesktop, setTrayStatus } from './bridge.js';

/** How often the tray's "synced 2 min ago" is brought up to date (the machines list is re-read too). */
const TRAY_TICK_MS = 60_000;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `at ${clock(at)}`;
}

/**
 * One tray menu line per paired machine (v2 spec §2): "PC: connected, synced
 * 2 min ago", "PC: unreachable since 14:02", "PC: checking…".
 */
export function trayMachineLines(machines: PeersOverview | null, now: number): string[] {
  if (!machines) return [];
  return machines.peers.map((peer) => {
    const status = peerStatusText(peer);
    const line = `${peer.name}: ${status.charAt(0).toLowerCase()}${status.slice(1)}`;
    return peer.status === 'reachable' && peer.lastSyncedAt !== null ? `${line}, synced ${ago(peer.lastSyncedAt, now)}` : line;
  });
}

/**
 * Keeps the desktop tray current while the window is hidden: its tooltip
 * shows how many tool calls are waiting for approval anywhere in the app
 * (from the app-wide event stream), and its menu each paired machine's
 * status. Nothing happens in a browser.
 */
export function useTrayStatus(): void {
  const pending = useGruntStore(selectPendingApprovalCount);
  const machines = useGruntStore((s) => s.machines);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isDesktop()) return;
    // The machines list only changes on events; a sync that brought nothing
    // new sends none, so it's re-read here to keep "synced N min ago" true.
    const timer = setInterval(() => {
      setNow(Date.now());
      refreshMachines();
    }, TRAY_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const lines = trayMachineLines(machines, now);
  const linesKey = lines.join('\n');
  useEffect(() => {
    setTrayStatus(pending, lines).catch((err: unknown) => console.error('[grunt-web] failed to update the tray status:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lines` is compared by its text (linesKey), not its identity.
  }, [pending, linesKey]);
}
