import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bridge.js', () => ({ setTrayStatus: vi.fn(async () => {}) }));

import { useGruntStore } from '../state/store.js';
import { setTrayStatus } from './bridge.js';
import { useTrayStatus } from './useTrayStatus.js';

const mocked = vi.mocked(setTrayStatus);

describe('useTrayStatus', () => {
  beforeEach(() => useGruntStore.setState(useGruntStore.getInitialState(), true));
  afterEach(() => mocked.mockClear());

  it('pushes the pending-approval count to the tray on mount and whenever it changes', () => {
    renderHook(() => useTrayStatus());
    expect(mocked).toHaveBeenLastCalledWith(0);

    act(() => useGruntStore.getState().applyAppEvent({ type: 'approval-requested', chatId: 'c', messageId: 'm', requestId: 'r1', toolName: 'write_file' }));
    expect(mocked).toHaveBeenLastCalledWith(1);

    act(() => useGruntStore.getState().applyAppEvent({ type: 'approval-resolved', chatId: 'c', requestId: 'r1' }));
    expect(mocked).toHaveBeenLastCalledWith(0);
    expect(mocked).toHaveBeenCalledTimes(3);
  });
});
