import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerFolderListing } from '@otherbench/core/types/workspace.js';
import { PeerFolderBrowser } from './PeerFolderBrowser.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, peers: { ...actual.api.peers, dirs: vi.fn() } } };
});

import { ApiError, api } from '../state/api.js';

const projects = { id: 'loc-1', name: 'Projects', root: 'E:\\Projects' };
const list: PeerFolderListing = { path: null, parent: null, location: null, dirs: [], truncated: false, locations: [projects] };
const root: PeerFolderListing = {
  path: 'E:\\Projects', parent: null, location: projects, truncated: false, locations: [projects],
  dirs: [{ name: 'alpha', path: 'E:\\Projects\\alpha' }, { name: 'beta', path: 'E:\\Projects\\beta' }],
};
const alpha: PeerFolderListing = { path: 'E:\\Projects\\alpha', parent: 'E:\\Projects', location: projects, truncated: false, locations: [projects], dirs: [] };

describe('PeerFolderBrowser', () => {
  beforeEach(() => {
    vi.mocked(api.peers.dirs).mockReset().mockImplementation(async (_nodeId, path) => (path === undefined ? list : path === 'E:\\Projects' ? root : alpha));
  });
  afterEach(cleanup);

  it("starts at that machine's locations, goes in and up, and picks the folder it is in", async () => {
    const onPick = vi.fn();
    render(<PeerFolderBrowser nodeId="node-pc" machine="PC" onPick={onPick} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('peer-folder-browser')).toHaveTextContent("Folders in PC's locations."));
    expect(api.peers.dirs).toHaveBeenCalledWith('node-pc', undefined);

    await userEvent.click(await screen.findByRole('button', { name: /Projects/ }));
    expect(await screen.findByTestId('peer-folder-path')).toHaveTextContent('E:\\Projects');
    expect(screen.queryByRole('button', { name: 'Up' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await waitFor(() => expect(screen.getByTestId('peer-folder-path')).toHaveTextContent('E:\\Projects\\alpha'));
    expect(screen.getByText('No folders in here.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(onPick).toHaveBeenCalledWith('E:\\Projects\\alpha');

    await userEvent.click(screen.getByRole('button', { name: 'Up' }));
    await waitFor(() => expect(screen.getByTestId('peer-folder-path')).toHaveTextContent(/^E:\\Projects$/));
    await userEvent.click(screen.getByRole('button', { name: 'Locations' }));
    expect(await screen.findByRole('button', { name: /Projects/ })).toBeInTheDocument();
  });

  it('says when that machine has no locations, since only they can be browsed', async () => {
    vi.mocked(api.peers.dirs).mockResolvedValue({ ...list, locations: [] });
    render(<PeerFolderBrowser nodeId="node-pc" machine="PC" onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('peer-folder-browser')).toHaveTextContent('PC has no locations yet'));
  });

  it("shows that machine's refusal, and closes", async () => {
    vi.mocked(api.peers.dirs).mockRejectedValue(new ApiError(503, "PC isn't reachable.", 'peer_unreachable'));
    const onClose = vi.fn();
    render(<PeerFolderBrowser nodeId="node-pc" machine="PC" onPick={() => {}} onClose={onClose} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("PC isn't reachable.");
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('says when a folder has more sub-folders than were listed', async () => {
    vi.mocked(api.peers.dirs).mockResolvedValue({ ...root, truncated: true });
    render(<PeerFolderBrowser nodeId="node-pc" machine="PC" onPick={() => {}} onClose={() => {}} />);
    expect(await screen.findByText(/Only the first/)).toBeInTheDocument();
  });
});
