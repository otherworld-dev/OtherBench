import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { chats: { patch: vi.fn() } } };
});

import { api, type PeersOverview } from '../state/api.js';
import { alsoActive, machineName, remoteUnreachable, streamStatusText } from '../state/machines.js';
import { useGruntStore } from '../state/store.js';
import { UnreachableBanner } from './UnreachableBanner.js';

function chat(over: Partial<Chat> = {}): Chat {
  return {
    id: 'c', title: 'T', profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-pc', workspaceRoot: null, pinned: false, archivedAt: null,
    autoMode: false, projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
  };
}

function machines(status: 'reachable' | 'unreachable' | 'unknown'): PeersOverview {
  return {
    self: { id: 'node-laptop', name: 'Laptop', fingerprint: 'AAAA' },
    listening: { running: true, addresses: [] },
    peers: [{ nodeId: 'node-pc', name: 'PC', fingerprint: 'f', addresses: [], platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1, status, since: 0, lastSyncedAt: null, syncError: null }],
  };
}

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  vi.mocked(api.chats.patch).mockReset();
});

afterEach(cleanup);

describe('where a chat runs', () => {
  it('names machines, and tells an unreachable or unpaired one from a reachable one', () => {
    const m = machines('unreachable');
    expect(machineName(m, 'node-pc')).toBe('PC');
    expect(machineName(m, 'node-laptop')).toBe('Laptop');
    expect(machineName(m, 'node-gone')).toBe('a machine no longer paired');
    expect(remoteUnreachable(m, chat())).toBe(true);
    expect(remoteUnreachable(machines('reachable'), chat())).toBe(false);
    expect(remoteUnreachable(machines('unknown'), chat())).toBe(false);
    expect(remoteUnreachable(m, chat({ runsOn: 'node-laptop' }))).toBe(false);
    expect(remoteUnreachable(m, chat({ runsOn: 'node-gone' }))).toBe(true);
  });

  it("says the chat's machine isn't reachable instead of connecting or reconnecting to it, and otherwise how its stream is doing", () => {
    expect(streamStatusText('reconnecting', chat(), machines('unreachable'))).toBe("PC isn't reachable");
    expect(streamStatusText('connecting', chat(), machines('unreachable'))).toBe("PC isn't reachable");
    expect(streamStatusText('reconnecting', chat(), machines('reachable'))).toBe('Reconnecting…');
    expect(streamStatusText('connecting', chat({ runsOn: 'node-laptop' }), machines('unreachable'))).toBe('Connecting…');
    expect(streamStatusText('open', chat(), machines('reachable'))).toBe('');
    expect(streamStatusText('reconnecting', chat(), null)).toBe('Reconnecting…');
  });

  it("finds another machine's running replies in this chat's folder: same location and subfolder, other chats only, while it's reachable", () => {
    const nc = (subpath: string) => ({ kind: 'location' as const, locationId: 'nc', subpath });
    const here = chat({ id: 'here', workspace: nc('Testing') });
    const chats = [
      here,
      chat({ id: 'same-folder', title: 'Refactor', workspace: nc('Testing') }),
      chat({ id: 'other-folder', title: 'Notes', workspace: nc('Elsewhere') }),
      chat({ id: 'machine-bound', title: 'Local', workspace: { kind: 'machine', nodeId: 'node-pc', root: 'E:\\Nextcloud\\Testing' } }),
    ];
    const withActive = (status: 'reachable' | 'unreachable', activeChats: string[]): PeersOverview => {
      const m = machines(status);
      return { ...m, peers: m.peers.map((p) => ({ ...p, activeChats })) };
    };
    const busy = ['here', 'same-folder', 'other-folder', 'machine-bound'];

    expect(alsoActive(withActive('reachable', busy), chats, here)).toEqual([{ machine: 'PC', chatId: 'same-folder', title: 'Refactor' }]);
    expect(alsoActive(withActive('unreachable', busy), chats, here)).toEqual([]);
    expect(alsoActive(withActive('reachable', busy), chats, chat({ id: 'nowhere', workspace: null }))).toEqual([]);
    expect(alsoActive(machines('reachable'), chats, here)).toEqual([]);
  });
});

describe('UnreachableBanner', () => {
  it('shows nothing while the machine is reachable, or for a chat that runs here', () => {
    useGruntStore.setState({ machines: machines('reachable') });
    const { container, unmount } = render(<UnreachableBanner chat={chat()} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    useGruntStore.setState({ machines: machines('unreachable') });
    render(<UnreachableBanner chat={chat({ runsOn: 'node-laptop' })} />);
    expect(screen.queryByTestId('unreachable-banner')).toBeNull();
  });

  it('offers to run the chat here, which moves it to this machine', async () => {
    useGruntStore.setState({ machines: machines('unreachable'), chats: [chat()] });
    vi.mocked(api.chats.patch).mockResolvedValue(chat({ runsOn: 'node-laptop' }));
    render(<UnreachableBanner chat={chat()} />);

    expect(screen.getByTestId('unreachable-banner')).toHaveTextContent("This chat runs on PC, which isn't reachable.");
    await userEvent.click(screen.getByRole('button', { name: 'Run here' }));

    await waitFor(() => expect(api.chats.patch).toHaveBeenCalledWith('c', { runsOn: 'node-laptop' }));
    await waitFor(() => expect(useGruntStore.getState().chats[0]!.runsOn).toBe('node-laptop'));
  });

  it('says where the chat runs once it has moved, until dismissed', async () => {
    useGruntStore.setState({ machines: machines('unreachable'), chats: [chat()] });
    vi.mocked(api.chats.patch).mockResolvedValue(chat({ runsOn: 'node-laptop' }));
    const { rerender } = render(<UnreachableBanner chat={chat()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run here' }));
    await waitFor(() => expect(api.chats.patch).toHaveBeenCalled());
    rerender(<UnreachableBanner chat={chat({ runsOn: 'node-laptop' })} />);

    expect(await screen.findByRole('status')).toHaveTextContent('This chat now runs on Laptop. Send a message to carry on.');
    expect(screen.queryByTestId('unreachable-banner')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("doesn't carry the note over to another chat shown in the same place", async () => {
    useGruntStore.setState({ machines: machines('unreachable'), chats: [chat()] });
    vi.mocked(api.chats.patch).mockResolvedValue(chat({ runsOn: 'node-laptop' }));
    const { rerender } = render(<UnreachableBanner chat={chat()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run here' }));
    await waitFor(() => expect(api.chats.patch).toHaveBeenCalled());
    rerender(<UnreachableBanner chat={chat({ id: 'other', runsOn: 'node-laptop' })} />);

    expect(screen.queryByRole('status')).toBeNull();
  });
});
