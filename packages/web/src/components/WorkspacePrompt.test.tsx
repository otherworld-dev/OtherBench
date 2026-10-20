import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      health: vi.fn(),
      chats: { get: vi.fn(), patch: vi.fn() },
      locations: { list: vi.fn(), setPath: vi.fn(), infer: vi.fn(), adopt: vi.fn() },
    },
  };
});

import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { WorkspacePrompt } from './WorkspacePrompt.js';

const HERE = 'C:\\Users\\Adam\\Nextcloud';

function chat(over: Partial<Chat>): Chat {
  return {
    id: 'chat-1',
    title: 'Chat',
    profileId: 'p1',
    headMessageId: null,
    workspace: null,
    runsOn: 'node-laptop',
    workspaceRoot: null,
    pinned: false,
    projectPinned: false,
    unread: false,
    archivedAt: null,
    autoMode: false,
    projectId: null, appId: null,
    memoryCursor: null,
    memoryExcluded: false,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const resolved = chat({ workspaceRoot: `${HERE}\\phd`, workspaceStatus: { status: 'ok', root: `${HERE}\\phd` } });

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  vi.mocked(api.health).mockReset().mockResolvedValue({ status: 'ok', time: '', platform: 'win32' });
  vi.mocked(api.locations.list).mockReset().mockResolvedValue([{ id: 'nc', name: 'Nextcloud', paths: [{ locationId: 'nc', nodeId: 'node-pc', path: 'E:\\Nextcloud' }] }]);
  vi.mocked(api.locations.setPath).mockReset();
  vi.mocked(api.locations.infer).mockReset();
  vi.mocked(api.locations.adopt).mockReset();
  vi.mocked(api.chats.get).mockReset().mockResolvedValue(resolved);
  vi.mocked(api.chats.patch).mockReset();
});

afterEach(cleanup);

describe('WorkspacePrompt', () => {
  it('shows nothing when the folder resolves, or there is none', () => {
    const { container } = render(<WorkspacePrompt chat={resolved} />);
    expect(container).toBeEmptyDOMElement();
    render(<WorkspacePrompt chat={chat({ workspaceStatus: { status: 'none' } })} />);
    expect(screen.queryByTestId('workspace-prompt')).toBeNull();
  });

  it("no path for the location here: asks where it is, and sets this machine's path", async () => {
    const c = chat({
      workspace: { kind: 'location', locationId: 'nc', subpath: 'phd' },
      workspaceStatus: { status: 'unresolved', reason: 'no-location-path', hint: { nodeId: 'node-pc', path: 'E:\\Nextcloud\\phd' } },
    });
    vi.mocked(api.locations.setPath).mockResolvedValue({ id: 'nc', name: 'Nextcloud', paths: [] });
    useOtherBenchStore.setState({ chats: [c] });
    render(<WorkspacePrompt chat={c} />);

    expect(await screen.findByText('Where is Nextcloud on this machine?')).toBeInTheDocument();
    expect(screen.getByText(/"phd" in Nextcloud.*On another machine it's E:\\Nextcloud\\phd/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Location folder on this machine' }), HERE);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.locations.setPath).toHaveBeenCalledWith('nc', HERE));
    await waitFor(() => expect(useOtherBenchStore.getState().chats[0]!.workspaceStatus).toEqual({ status: 'ok', root: `${HERE}\\phd` }));
  });

  it("another machine's folder: a matching folder here offers a location, which adopts every chat from there", async () => {
    const c = chat({
      workspace: { kind: 'machine', nodeId: 'node-pc', root: 'E:\\Nextcloud\\phd' },
      workspaceStatus: { status: 'unresolved', reason: 'other-machine', hint: { nodeId: 'node-pc', path: 'E:\\Nextcloud\\phd' } },
    });
    vi.mocked(api.locations.infer).mockResolvedValue({
      mapping: { fromRoot: 'E:\\Nextcloud', toRoot: HERE, tail: ['phd'], name: 'Nextcloud' },
      existing: null,
      affected: 3,
    });
    vi.mocked(api.locations.adopt).mockResolvedValue({ location: { id: 'new', name: 'Cloud', paths: [] }, converted: 3 });
    render(<WorkspacePrompt chat={c} />);

    expect(screen.getByText("This chat's folder is on another machine")).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder on this machine' }), `${HERE}\\phd`);
    await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }));

    expect(await screen.findByText(/Make a location\? E:\\Nextcloud there is C:\\Users\\Adam\\Nextcloud here\. 3 chats and projects/)).toBeInTheDocument();
    expect(api.locations.infer).toHaveBeenCalledWith({ nodeId: 'node-pc', fromPath: 'E:\\Nextcloud\\phd', toPath: `${HERE}\\phd` });
    await userEvent.clear(screen.getByRole('textbox', { name: 'Location name' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Location name' }), 'Cloud');
    await userEvent.click(screen.getByRole('button', { name: 'Create location' }));

    await waitFor(() => expect(api.locations.adopt).toHaveBeenCalledWith({ name: 'Cloud', nodeId: 'node-pc', fromRoot: 'E:\\Nextcloud', toRoot: HERE }));
    expect(api.chats.get).toHaveBeenCalledWith('chat-1');
  });

  it("another machine's folder: Just this chat sets the folder on its own", async () => {
    const c = chat({ workspaceStatus: { status: 'unresolved', reason: 'other-machine', hint: { nodeId: 'node-pc', path: 'E:\\Nextcloud\\phd' } } });
    vi.mocked(api.locations.infer).mockResolvedValue({ mapping: { fromRoot: 'E:\\Nextcloud', toRoot: HERE, tail: ['phd'], name: 'Nextcloud' }, existing: { id: 'nc', name: 'Nextcloud' }, affected: 1 });
    vi.mocked(api.chats.patch).mockResolvedValue(resolved);
    render(<WorkspacePrompt chat={c} />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Folder on this machine' }), `${HERE}\\phd`);
    await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(await screen.findByRole('button', { name: 'Use Nextcloud' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Just this chat' }));

    await waitFor(() => expect(api.chats.patch).toHaveBeenCalledWith('chat-1', { workspacePath: `${HERE}\\phd` }));
    expect(api.locations.adopt).not.toHaveBeenCalled();
  });

  it('offers to run the chat on the machine that has the folder, when that machine is reachable', async () => {
    useOtherBenchStore.setState({
      machines: {
        self: { id: 'node-laptop', name: 'Laptop', fingerprint: 'A' },
        listening: { running: true, addresses: [] },
        peers: [{ nodeId: 'node-pc', name: 'PC', fingerprint: 'f', addresses: [], platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1, status: 'reachable', since: 0, lastSyncedAt: null, syncError: null }],
      },
    });
    const c = chat({ workspaceStatus: { status: 'unresolved', reason: 'other-machine', hint: { nodeId: 'node-pc', path: 'E:\\Git\\OtherBench' } } });
    vi.mocked(api.chats.patch).mockResolvedValue(chat({ runsOn: 'node-pc' }));
    render(<WorkspacePrompt chat={c} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run on PC' }));

    await waitFor(() => expect(api.chats.patch).toHaveBeenCalledWith('chat-1', { runsOn: 'node-pc' }));
  });

  it('a missing folder: choose where it is now, or continue without a folder', async () => {
    const c = chat({ workspaceStatus: { status: 'unresolved', reason: 'missing', hint: { nodeId: 'node-laptop', path: 'C:\\old' } } });
    vi.mocked(api.chats.patch).mockResolvedValue(chat({ workspaceStatus: { status: 'none' } }));
    render(<WorkspacePrompt chat={c} />);

    expect(screen.getByText("This chat's folder isn't here any more")).toBeInTheDocument();
    expect(screen.getByText(/C:\\old doesn't exist on this machine/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder on this machine' }), 'relative');
    await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Windows path');
    expect(api.chats.patch).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Continue without a folder' }));
    await waitFor(() => expect(api.chats.patch).toHaveBeenCalledWith('chat-1', { workspace: null }));
  });
});
