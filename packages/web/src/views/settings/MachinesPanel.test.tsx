import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      node: { rename: vi.fn() },
      peers: { overview: vi.fn(), startPairing: vi.fn(), currentPairing: vi.fn(), cancelPairing: vi.fn(), add: vi.fn(), patch: vi.fn(), remove: vi.fn(), sync: vi.fn() },
    },
  };
});

import { ApiError, api, type PeersOverview } from '../../state/api.js';
import { FIREWALL_NOTE, MachinesPanel, peerStatusText, syncText } from './MachinesPanel.js';

const at1402 = new Date(2026, 9, 5, 14, 2).getTime();
/** 14:02 as the panel shows it, in whatever locale the tests run in. */
const shown1402 = new Date(at1402).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const overview: PeersOverview = {
  self: { id: 'node-laptop', name: 'Laptop', fingerprint: 'AB12 CD34 EF56 7890' },
  listening: { running: true, addresses: ['192.168.1.30:4748'] },
  peers: [
    {
      nodeId: 'node-pc',
      name: 'PC',
      fingerprint: 'ff'.repeat(32),
      addresses: ['192.168.1.20:4748', 'pc.lan:4748'],
      platform: 'win32',
      lastSeenAt: null,
      lastSyncSeq: 0,
      pairedAt: 1,
      status: 'unreachable',
      since: at1402,
      error: 'connect ECONNREFUSED',
      lastSyncedAt: null,
      syncError: null,
    },
  ],
};

beforeEach(() => {
  vi.mocked(api.peers.overview).mockReset().mockResolvedValue(overview);
  vi.mocked(api.peers.currentPairing).mockReset().mockResolvedValue(null);
  vi.mocked(api.peers.startPairing).mockReset();
  vi.mocked(api.peers.cancelPairing).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.peers.add).mockReset();
  vi.mocked(api.peers.patch).mockReset();
  vi.mocked(api.peers.remove).mockReset().mockResolvedValue({ notified: true });
  vi.mocked(api.node.rename).mockReset();
});

afterEach(cleanup);

describe('peerStatusText', () => {
  it('connected, unreachable since a time, or still checking', () => {
    expect(peerStatusText({ status: 'reachable', since: 0 })).toBe('Connected');
    expect(peerStatusText({ status: 'unreachable', since: at1402 })).toBe(`Unreachable since ${shown1402}`);
    expect(peerStatusText({ status: 'unknown', since: 0 })).toBe('Checking…');
  });
});

describe('syncText', () => {
  it('when it last synced, why it last failed, or that it has not yet', () => {
    expect(syncText({ lastSyncedAt: 1000, syncError: null }, 1000 + 120_000)).toMatch(/^Synced 2 min/);
    expect(syncText({ lastSyncedAt: 1000, syncError: 'PC runs a different version' })).toBe('Sync failed: PC runs a different version');
    expect(syncText({ lastSyncedAt: null, syncError: null })).toBe('Not synced yet');
  });
});

describe('MachinesPanel', () => {
  it('shows this machine and each paired one with its status and addresses', async () => {
    render(<MachinesPanel />);
    const pc = await screen.findByTestId('peer-node-pc');
    expect(within(pc).getByText('PC')).toBeInTheDocument();
    expect(within(pc).getByTestId('peer-status')).toHaveTextContent(`Unreachable since ${shown1402}`);
    expect(within(pc).getByText('192.168.1.20:4748, pc.lan:4748')).toBeInTheDocument();
    expect(screen.getByTestId('this-machine')).toHaveTextContent('Laptop');
    expect(screen.getByTestId('this-machine')).toHaveTextContent('AB12 CD34 EF56 7890');
  });

  it('shows a code with the addresses, fingerprint and firewall note, and cancels it', async () => {
    vi.mocked(api.peers.startPairing).mockResolvedValue({ code: 'ABCD-EFGH', expiresAt: Date.now() + 600_000, addresses: ['192.168.1.30:4748'], fingerprint: 'AB12 CD34 EF56 7890' });
    render(<MachinesPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show a code' }));

    const shown = await screen.findByTestId('pairing-code');
    expect(shown).toHaveTextContent('ABCD-EFGH');
    expect(shown).toHaveTextContent('192.168.1.30:4748');
    expect(shown).toHaveTextContent('10 more minutes');
    expect(shown).toHaveTextContent(FIREWALL_NOTE);

    await userEvent.click(within(shown).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.peers.cancelPairing).toHaveBeenCalled());
    expect(screen.queryByTestId('pairing-code')).toBeNull();
  });

  it('adds a machine by address and code, and shows why when it fails', async () => {
    vi.mocked(api.peers.add).mockRejectedValueOnce(new ApiError(403, 'Wrong code, or something between the two machines changed the connection.'));
    render(<MachinesPanel />);
    await screen.findByTestId('peer-node-pc');

    await userEvent.type(screen.getByRole('textbox', { name: 'Address' }), '192.168.1.20:4748');
    await userEvent.type(screen.getByRole('textbox', { name: 'Code' }), 'abcd-efgh');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong code');

    vi.mocked(api.peers.add).mockResolvedValueOnce(overview.peers[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.peers.add).toHaveBeenLastCalledWith('192.168.1.20:4748', 'abcd-efgh'));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Code' })).toHaveValue(''));
  });

  it('syncs with a machine on request and shows when it last did', async () => {
    vi.mocked(api.peers.sync).mockResolvedValue({ applied: 3 });
    render(<MachinesPanel />);
    const pc = await screen.findByTestId('peer-node-pc');
    expect(within(pc).getByTestId('peer-sync')).toHaveTextContent('Not synced yet');
    await userEvent.click(within(pc).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(api.peers.sync).toHaveBeenCalledWith('node-pc'));
  });

  it('removes a machine after confirming', async () => {
    render(<MachinesPanel />);
    const pc = await screen.findByTestId('peer-node-pc');
    await userEvent.click(within(pc).getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove machine' }));
    await waitFor(() => expect(api.peers.remove).toHaveBeenCalledWith('node-pc'));
  });

  it('edits a machine name and its addresses', async () => {
    vi.mocked(api.peers.patch).mockResolvedValue(overview.peers[0]!);
    render(<MachinesPanel />);
    const pc = await screen.findByTestId('peer-node-pc');
    await userEvent.click(within(pc).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(within(pc).getByRole('textbox', { name: 'Machine name' }));
    await userEvent.type(within(pc).getByRole('textbox', { name: 'Machine name' }), 'Desktop');
    await userEvent.clear(within(pc).getByRole('textbox', { name: 'Addresses' }));
    await userEvent.type(within(pc).getByRole('textbox', { name: 'Addresses' }), 'pc.lan:4748, 10.0.0.2:4748');
    await userEvent.click(within(pc).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.peers.patch).toHaveBeenCalledWith('node-pc', { name: 'Desktop', addresses: ['pc.lan:4748', '10.0.0.2:4748'] }));
  });
});
