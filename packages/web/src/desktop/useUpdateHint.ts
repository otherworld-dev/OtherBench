import { useEffect, useRef } from 'react';
import type { PeerView } from '../state/api.js';
import { toast } from '../lib/toasts.js';
import { useOtherBenchStore, WINDOW_ROLE } from '../state/store.js';
import { checkForUpdates, isDesktop, onUpdateStatus } from './bridge.js';

/** A paired machine that stays ahead asks for an update check no more often than this. */
export const HINT_EVERY_MS = 10 * 60_000;

function mismatchNotice(peer: PeerView): string {
  const m = peer.versionMismatch!;
  const version = m.peerAppVersion ? ` (${m.peerAppVersion})` : '';
  return m.thisMachineOlder
    ? `${peer.name} runs a newer OtherBench${version}, so sync with it has stopped. Checking for an update…`
    : `${peer.name} runs an older OtherBench${version}, so sync with it has stopped until it updates.`;
}

/**
 * When sync with a paired machine stops because the two run different
 * versions, says so once, and if the other machine is ahead asks the shell's
 * updater to check now rather than at its next 4-hourly check. Runs in the
 * main window only (which keeps the machines list current).
 */
export function useUpdateHint(): void {
  const machines = useOtherBenchStore((s) => s.machines);
  const noticed = useRef(new Set<string>());
  const lastCheck = useRef<number | null>(null);

  // An update that has waited a day for a quiet moment says so once, instead of only in Settings.
  useEffect(() => {
    if (!isDesktop() || WINDOW_ROLE !== 'main') return;
    const asked = new Set<string>();
    let off: (() => void) | null = null;
    let gone = false;
    void onUpdateStatus((s) => {
      if (s.state !== 'ask' || !s.available || asked.has(s.available)) return;
      asked.add(s.available);
      toast({ text: `OtherBench ${s.available} has been waiting a day to install. Restart it from Settings → Desktop → Updates when it suits you.`, tone: 'ok' });
    }).then((unlisten) => {
      if (gone) unlisten();
      else off = unlisten;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, []);
  useEffect(() => {
    if (!isDesktop() || WINDOW_ROLE !== 'main' || !machines) return;
    let ahead = false;
    for (const peer of machines.peers) {
      if (!peer.versionMismatch) continue;
      const key = `${peer.nodeId}@${peer.versionMismatch.peerAppVersion ?? peer.versionMismatch.peerSchemaVersion}`;
      if (!noticed.current.has(key)) {
        noticed.current.add(key);
        toast({ text: mismatchNotice(peer), tone: 'ok' });
      }
      if (peer.versionMismatch.thisMachineOlder) ahead = true;
    }
    if (ahead && (lastCheck.current === null || Date.now() - lastCheck.current >= HINT_EVERY_MS)) {
      lastCheck.current = Date.now();
      checkForUpdates().catch((err: unknown) => console.error('[otherbench-web] failed to ask for an update check:', err));
    }
  }, [machines]);
}
