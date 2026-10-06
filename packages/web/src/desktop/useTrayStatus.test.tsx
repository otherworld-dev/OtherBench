import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bridge.js', () => ({ setTrayStatus: vi.fn(async () => {}), isDesktop: () => false }));

import type { PeersOverview, PeerView } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { setTrayStatus } from './bridge.js';
import { trayMachineLines, useTrayStatus } from './useTrayStatus.js';

const mocked = vi.mocked(setTrayStatus);

/** A time as the tray shows it, in whatever locale the tests run under (CI's isn't 24-hour). */
const hm = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const at1402 = new Date(2026, 9, 6, 14, 2).getTime();

function overview(...peers: Partial<PeerView>[]): PeersOverview {
  return {
    self: { id: 'node-laptop', name: 'Laptop', fingerprint: 'A' },
    listening: { running: true, addresses: [] },
    peers: peers.map((p) => ({
      nodeId: 'node-pc', name: 'PC', fingerprint: 'f', addresses: [], platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1,
      status: 'reachable', since: 0, lastSyncedAt: null, syncError: null, ...p,
    })),
  };
}

describe('useTrayStatus', () => {
  beforeEach(() => useGruntStore.setState(useGruntStore.getInitialState(), true));
  afterEach(() => mocked.mockClear());

  it('pushes the pending-approval count to the tray on mount and whenever it changes', () => {
    renderHook(() => useTrayStatus());
    expect(mocked).toHaveBeenLastCalledWith(0, []);

    act(() => useGruntStore.getState().applyAppEvent({ type: 'approval-requested', chatId: 'c', messageId: 'm', requestId: 'r1', toolName: 'write_file' }));
    expect(mocked).toHaveBeenLastCalledWith(1, []);

    act(() => useGruntStore.getState().applyAppEvent({ type: 'approval-resolved', chatId: 'c', requestId: 'r1' }));
    expect(mocked).toHaveBeenLastCalledWith(0, []);
    expect(mocked).toHaveBeenCalledTimes(3);
  });

  it("pushes each paired machine's status line, and only again when one changes", () => {
    renderHook(() => useTrayStatus());
    act(() => useGruntStore.getState().setMachines(overview({ status: 'unreachable', since: at1402 })));
    expect(mocked).toHaveBeenLastCalledWith(0, [`PC: unreachable since ${hm(at1402)}`]);
    const calls = mocked.mock.calls.length;

    act(() => useGruntStore.getState().setMachines(overview({ status: 'unreachable', since: at1402 })));
    expect(mocked).toHaveBeenCalledTimes(calls);
  });
});

describe('trayMachineLines', () => {
  const now = new Date(2026, 9, 6, 15, 0).getTime();

  it('says each machine is connected and when it last synced, unreachable since when, or still being checked', () => {
    expect(trayMachineLines(null, now)).toEqual([]);
    expect(trayMachineLines(overview({ lastSyncedAt: now - 20_000 }), now)).toEqual(['PC: connected, synced just now']);
    expect(trayMachineLines(overview({ lastSyncedAt: now - 2 * 60_000 }), now)).toEqual(['PC: connected, synced 2 min ago']);
    const at1230 = new Date(2026, 9, 6, 12, 30).getTime();
    expect(trayMachineLines(overview({ lastSyncedAt: at1230 }), now)).toEqual([`PC: connected, synced at ${hm(at1230)}`]);
    expect(trayMachineLines(overview({}), now)).toEqual(['PC: connected']);
    expect(trayMachineLines(overview({ status: 'unreachable', since: at1402, lastSyncedAt: now }), now)).toEqual([`PC: unreachable since ${hm(at1402)}`]);
    expect(trayMachineLines(overview({ status: 'unknown' }), now)).toEqual(['PC: checking…']);
  });
});
