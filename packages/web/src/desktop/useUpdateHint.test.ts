import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bridge.js', () => ({ isDesktop: () => true, checkForUpdates: vi.fn(async () => {}) }));

import type { PeersOverview, PeerView, VersionMismatchView } from '../state/api.js';
import { useToasts } from '../lib/toasts.js';
import { useOtherBenchStore } from '../state/store.js';
import { checkForUpdates } from './bridge.js';
import { HINT_EVERY_MS, useUpdateHint } from './useUpdateHint.js';

const checked = vi.mocked(checkForUpdates);

function mismatch(over: Partial<VersionMismatchView> = {}): VersionMismatchView {
  return { peerAppVersion: '0.2.0-beta.44', peerSchemaVersion: 35, peerProtocolVersion: 1, thisMachineOlder: true, at: 1, ...over };
}

function overview(...peers: Partial<PeerView>[]): PeersOverview {
  return {
    self: { id: 'node-laptop', name: 'Laptop', fingerprint: 'A' },
    listening: { running: true, addresses: [] },
    peers: peers.map((p) => ({
      nodeId: 'node-pc', name: 'Megabyte', fingerprint: 'f', addresses: [], platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1,
      status: 'reachable', since: 0, lastSyncedAt: null, syncError: 'different version', ...p,
    })),
  };
}

const toastTexts = (): string[] => useToasts.getState().toasts.map((t) => t.text);

beforeEach(() => {
  vi.useFakeTimers();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useToasts.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  checked.mockClear();
  vi.useRealTimers();
});

describe('useUpdateHint', () => {
  it('checks for an update when a paired machine is ahead, then no more than every 10 minutes', () => {
    expect(HINT_EVERY_MS).toBe(600_000);
    renderHook(() => useUpdateHint());
    act(() => useOtherBenchStore.getState().setMachines(overview({ versionMismatch: mismatch() })));
    expect(checked).toHaveBeenCalledTimes(1);
    act(() => useOtherBenchStore.getState().setMachines(overview({ versionMismatch: mismatch() })));
    expect(checked).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600_000);
    act(() => useOtherBenchStore.getState().setMachines(overview({ versionMismatch: mismatch() })));
    expect(checked).toHaveBeenCalledTimes(2);
  });

  it('says so once when the mismatch first appears', () => {
    renderHook(() => useUpdateHint());
    act(() => useOtherBenchStore.getState().setMachines(overview({ versionMismatch: mismatch() })));
    act(() => useOtherBenchStore.getState().setMachines(overview({ versionMismatch: mismatch() })));
    expect(toastTexts()).toEqual(['Megabyte runs a newer OtherBench (0.2.0-beta.44), so sync with it has stopped. Checking for an update…']);
  });

  it("doesn't check when the other machine is the older one, and says it needs updating", () => {
    renderHook(() => useUpdateHint());
    act(() => useOtherBenchStore.getState().setMachines(overview({ versionMismatch: mismatch({ peerAppVersion: '0.2.0-beta.41', thisMachineOlder: false }) })));
    expect(checked).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual(['Megabyte runs an older OtherBench (0.2.0-beta.41), so sync with it has stopped until it updates.']);
  });

  it('says nothing for machines in step', () => {
    renderHook(() => useUpdateHint());
    act(() => useOtherBenchStore.getState().setMachines(overview({ syncError: null })));
    expect(checked).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });
});
