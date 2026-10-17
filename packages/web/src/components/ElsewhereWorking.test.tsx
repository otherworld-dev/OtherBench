import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import type { PeersOverview } from '../state/api.js';
import { useChatActivity } from '../state/chatStatus.js';
import { chatsWorkingElsewhere, workingElsewhere } from '../state/machines.js';
import { useOtherBenchStore } from '../state/store.js';
import { ElsewhereWorking } from './ElsewhereWorking.js';

function machines(status: 'reachable' | 'unreachable', activeChats: string[]): PeersOverview {
  return {
    self: { id: 'node-laptop', name: 'Laptop' },
    peers: [{ nodeId: 'node-pc', name: 'PC', fingerprint: 'f', addresses: [], platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1, status, since: 0, lastSyncedAt: null, syncError: null, activeChats }],
  } as unknown as PeersOverview;
}

const streaming = (chatId: string): CanonMessage => ({ id: 'm1', chatId, parentId: null, role: 'assistant', parts: [], status: 'streaming', error: null, producedBy: null, createdAt: 1 });

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
});
afterEach(cleanup);

describe('chats a paired machine is working in', () => {
  it('are the ones a reachable machine says it has a reply running in', () => {
    expect([...chatsWorkingElsewhere(machines('reachable', ['office', 'notes']))]).toEqual(['office', 'notes']);
    expect(workingElsewhere(machines('reachable', ['office']), 'office')).toBe('PC');
    expect(workingElsewhere(machines('reachable', ['office']), 'notes')).toBeNull();
    // An unreachable machine's last word doesn't count.
    expect([...chatsWorkingElsewhere(machines('unreachable', ['office']))]).toEqual([]);
    expect(workingElsewhere(null, 'office')).toBeNull();
  });

  it("show as working in the sidebar's and tabs' dots", () => {
    useOtherBenchStore.setState({ machines: machines('reachable', ['office']) });
    const { result } = renderHook(() => useChatActivity());
    expect(result.current.working.has('office')).toBe(true);
  });
});

describe('the store hearing what paired machines are doing', () => {
  it('reloads a chat when a paired machine starts a reply in it, so the reply shows live', () => {
    const { setMachines } = useOtherBenchStore.getState();
    setMachines(machines('reachable', []));
    expect(useOtherBenchStore.getState().chatReloads['office']).toBeUndefined();
    setMachines(machines('reachable', ['office']));
    expect(useOtherBenchStore.getState().chatReloads['office']).toBe(1);
    // Still working: no reload again.
    setMachines(machines('reachable', ['office']));
    expect(useOtherBenchStore.getState().chatReloads['office']).toBe(1);
  });
});

describe('ElsewhereWorking', () => {
  it('says the PC is replying in this chat', () => {
    useOtherBenchStore.setState({ machines: machines('reachable', ['office']) });
    render(<ElsewhereWorking chat={{ id: 'office' }} />);
    expect(screen.getByTestId('elsewhere-working')).toHaveTextContent('Replying on PC…');
  });

  it('says nothing for a chat no other machine is working in, or once the reply is streaming here', () => {
    useOtherBenchStore.setState({ machines: machines('reachable', ['office']) });
    const { rerender } = render(<ElsewhereWorking chat={{ id: 'notes' }} />);
    expect(screen.queryByTestId('elsewhere-working')).not.toBeInTheDocument();
    useOtherBenchStore.setState({ messages: { m1: streaming('office') } });
    rerender(<ElsewhereWorking chat={{ id: 'office' }} />);
    expect(screen.queryByTestId('elsewhere-working')).not.toBeInTheDocument();
  });
});
