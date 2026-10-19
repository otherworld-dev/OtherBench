import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Project } from '@otherbench/core/ports/store.js';
import type { FolderView } from '@otherbench/core/types/workspace.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import type { UsageRollup } from '@otherbench/core/domain/usage-rollup.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { Inspector } from './Inspector.js';
import { useOtherBenchStore } from '../state/store.js';
import { COLLAPSED_GROUPS_STORAGE_KEY, groupDomId, resetSidebarGroupsForTests } from '../state/sidebarGroups.js';
import { INSPECTOR_SECTIONS_STORAGE_KEY, resetInspectorSectionsForTests } from '../state/inspectorSections.js';

vi.mock('../desktop/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../desktop/bridge.js')>()),
  isDesktop: vi.fn(() => false),
  pickFolder: vi.fn(),
  openTerminal: vi.fn(),
}));

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      usage: {
        get: vi.fn(),
      },
      mcpServers: {
        list: vi.fn(),
        refresh: vi.fn(),
      },
      grants: {
        list: vi.fn(),
        revoke: vi.fn(),
      },
      audit: {
        list: vi.fn(),
      },
      health: vi.fn(),
      chats: {
        patch: vi.fn(),
      },
      projects: {
        patch: vi.fn(),
      },
      profiles: {
        patch: vi.fn(),
      },
    },
  };
});

vi.mock('./InspectorMemory.js', () => ({
  InspectorMemory: ({ project }: { project: { id: string } }) => <div data-testid="inspector-memory">memory for {project.id}</div>,
}));

import { isDesktop, openTerminal, pickFolder } from '../desktop/bridge.js';
import { ApiError, api } from '../state/api.js';

const mockedUsageGet = vi.mocked(api.usage.get);
const mockedMcpList = vi.mocked(api.mcpServers.list);
const mockedMcpRefresh = vi.mocked(api.mcpServers.refresh);
const mockedGrantsList = vi.mocked(api.grants.list);
const mockedGrantsRevoke = vi.mocked(api.grants.revoke);
const mockedAuditList = vi.mocked(api.audit.list);
const mockedHealth = vi.mocked(api.health);
const mockedChatsPatch = vi.mocked(api.chats.patch);
const mockedProjectsPatch = vi.mocked(api.projects.patch);
const mockedProfilesPatch = vi.mocked(api.profiles.patch);
const mockedIsDesktop = vi.mocked(isDesktop);
const mockedPickFolder = vi.mocked(pickFolder);
const mockedOpenTerminal = vi.mocked(openTerminal);

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    title: 'Chat 1',
    profileId: 'p1',
    headMessageId: null,
    workspace: null,
    runsOn: 'node-self',
    workspaceRoot: null,
    pinned: false,
    projectPinned: false,
    unread: false,
    autoMode: false,
    projectId: null,
    memoryCursor: null,
    memoryExcluded: false,
    sortOrder: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'p1',
    name: 'Default',
    description: null,
    colour: null,
    connectionId: 'c1',
    modelId: 'mock-standard',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: true,
    archivedAt: null,
    ...overrides,
  };
}

function makeRollup(overrides: Partial<UsageRollup> = {}): UsageRollup {
  return {
    profiles: [],
    chats: [],
    buckets: [],
    totalMeasuredCost: 0,
    totalCancelledCount: 0,
    totalUnmeasuredErrorCount: 0,
    ...overrides,
  };
}

function makeMessage(id: string, overrides: Partial<CanonMessage> = {}): CanonMessage {
  return {
    id,
    chatId: 'chat-1',
    parentId: 'user-1',
    role: 'assistant',
    parts: [],
    status: 'streaming',
    error: null,
    producedBy: { profileId: 'p1', profileName: 'Alpha', connectionId: 'c1', modelId: 'mock-standard' },
    createdAt: 0,
    ...overrides,
  };
}

const SECTION_TITLES = ['Workspace', 'Other folders', 'Profile', 'Claude Code session', 'Tool grants', 'MCP servers', 'Audit trail', 'Project memory', 'Spend'];

/** Opens every collapsible section, as if by hand, so a test can reach into any of them. */
function openAllSections(): void {
  window.localStorage.setItem(INSPECTOR_SECTIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(SECTION_TITLES.map((t) => [t, true]))));
  resetInspectorSectionsForTests();
}

/** A section by its title; its heading also carries the section's summary. */
function sectionNamed(title: string): HTMLElement {
  return screen.getByRole('heading', { name: new RegExp(`^${title}\\b`) }).closest('section')!;
}

// Applies to every test in this file: the three new honest-state sections
// (MCP health, grants, audit) mount unconditionally alongside session spend,
// so every test needs SOME resolved value for them, not just the ones that
// specifically exercise those sections below.
beforeEach(() => {
  openAllSections();
  mockedMcpList.mockReset().mockResolvedValue([]);
  mockedMcpRefresh.mockReset().mockResolvedValue(undefined);
  mockedGrantsList.mockReset().mockResolvedValue([]);
  mockedGrantsRevoke.mockReset().mockResolvedValue(undefined);
  mockedAuditList.mockReset().mockResolvedValue([]);
  mockedHealth.mockReset().mockResolvedValue({ status: 'ok', time: '', platform: 'win32' });
  mockedChatsPatch.mockReset();
  mockedProjectsPatch.mockReset();
  mockedProfilesPatch.mockReset();
});

describe('Inspector collapsed strip', () => {
  afterEach(cleanup);

  it('a disabled strip says why and does nothing when clicked', async () => {
    const onToggle = vi.fn();
    render(<Inspector chat={null} profile={null} collapsed disabled onToggleCollapsed={onToggle} />);
    const strip = screen.getByRole('button', { name: 'Expand inspector' });
    expect(strip).toHaveAttribute('aria-disabled', 'true');
    expect(strip).toHaveAttribute('title', 'Select a chat to see its details');
    await userEvent.setup().click(strip);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('Inspector session spend', () => {
  beforeEach(() => {
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    mockedUsageGet.mockReset();
  });
  afterEach(cleanup);

  it('shows "No chat selected" when there is no active chat', () => {
    render(<Inspector chat={null} profile={null} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const spendSection = sectionNamed('Spend');
    expect(within(spendSection).getByText('No chat selected.')).toBeInTheDocument();
    expect(mockedUsageGet).not.toHaveBeenCalled();
  });

  it('fetches and renders the per-profile spend rollup for the active chat', async () => {
    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 4.5,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'model-x', currency: 'USD', measuredCost: 4.5, tokensIn: 100, tokensOut: 50, tokensCached: 0, tokensReasoning: 0, completeCount: 2, cancelledCount: 0, unmeasuredErrorCount: 0, subagentCount: 0, backgroundCount: 0 }],
      })
    );

    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledWith('chat-1'));
    expect(await screen.findByTestId('session-spend')).toHaveTextContent('$4.50');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('surfaces cancelled and unmeasured-error calls as separate honest callouts, not folded into the total', async () => {
    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 2,
        totalCancelledCount: 1,
        totalUnmeasuredErrorCount: 1,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'model-x', currency: 'USD', measuredCost: 2, tokensIn: 10, tokensOut: 10, tokensCached: 0, tokensReasoning: 0, completeCount: 1, cancelledCount: 1, unmeasuredErrorCount: 1, subagentCount: 0, backgroundCount: 0 }],
      })
    );

    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    const section = await screen.findByTestId('session-spend');
    expect(section).toHaveTextContent('$2.00');
    expect(section).toHaveTextContent('1 cancelled call');
    expect(section).toHaveTextContent('1 failed call');
  });

  it('shows an honest empty state when nothing has run in this chat yet', async () => {
    mockedUsageGet.mockResolvedValue(makeRollup());
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    expect(await screen.findByText('No usage recorded in this chat yet.')).toBeInTheDocument();
  });

  it('shows an error state when the usage fetch fails, without throwing', async () => {
    mockedUsageGet.mockRejectedValue(new Error('network down'));
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    expect(await screen.findByText(/couldn.t load spend for this chat\./i)).toBeInTheDocument();
  });

  it('re-fetches when an assistant message in this chat reaches a terminal status (a new usage row may now exist)', async () => {
    mockedUsageGet.mockResolvedValue(makeRollup());
    useOtherBenchStore.getState().registerMessage(makeMessage('m1', { status: 'streaming' }));

    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('No usage recorded in this chat yet.')).toBeInTheDocument();

    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 3,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'model-x', currency: 'USD', measuredCost: 3, tokensIn: 10, tokensOut: 10, tokensCached: 0, tokensReasoning: 0, completeCount: 1, cancelledCount: 0, unmeasuredErrorCount: 0, subagentCount: 0, backgroundCount: 0 }],
      })
    );
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'm1', type: 'status', status: 'complete' });

    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('session-spend')).toHaveTextContent('$3.00');
  });

  it('re-fetches when switching to a different chat', async () => {
    mockedUsageGet.mockResolvedValue(makeRollup());
    const { rerender } = render(<Inspector chat={makeChat({ id: 'chat-1' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledWith('chat-1'));

    rerender(<Inspector chat={makeChat({ id: 'chat-2' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledWith('chat-2'));
  });
});

const mcpHealthSection = (): HTMLElement => sectionNamed('MCP servers');
const grantsSection = (): HTMLElement => sectionNamed('Tool grants');
const auditSection = (): HTMLElement => sectionNamed('Audit trail');
const workspaceSection = (): HTMLElement => sectionNamed('Workspace');
const foldersSection = (): HTMLElement => sectionNamed('Other folders');

describe('Inspector runs on', () => {
  afterEach(cleanup);

  it('is hidden until a machine is paired, then lists this machine and each paired one, and moves the chat', async () => {
    useOtherBenchStore.setState({ machines: null });
    const { unmount } = render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Runs on' })).toBeNull();
    unmount();

    useOtherBenchStore.setState({
      machines: {
        self: { id: 'node-self', name: 'Laptop', fingerprint: 'A' },
        listening: { running: true, addresses: [] },
        peers: [{ nodeId: 'node-pc', name: 'PC', fingerprint: 'f', addresses: [], platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1, status: 'reachable', since: 0, lastSyncedAt: null, syncError: null }],
      },
    });
    mockedChatsPatch.mockResolvedValue(makeChat({ runsOn: 'node-pc' }));
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    const select = screen.getByRole('combobox', { name: 'Runs on' });
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['Laptop (this machine)', 'PC (connected)']);
    await userEvent.selectOptions(select, 'node-pc');
    await waitFor(() => expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', { runsOn: 'node-pc' }));
    useOtherBenchStore.setState({ machines: null });
  });
});

describe('Inspector also active elsewhere', () => {
  afterEach(() => {
    cleanup();
    useOtherBenchStore.setState({ machines: null, chats: [] });
  });

  it("says when the other machine has a reply running in another chat in this chat's folder", () => {
    const workspace = { kind: 'location' as const, locationId: 'nc', subpath: 'Testing' };
    const chat = makeChat({ workspace, workspaceRoot: 'C:\\Users\\Adam\\Nextcloud\\Testing' });
    useOtherBenchStore.setState({
      chats: [chat, makeChat({ id: 'chat-pc', title: 'Refactor', workspace })],
      machines: {
        self: { id: 'node-self', name: 'Laptop', fingerprint: 'A' },
        listening: { running: true, addresses: [] },
        peers: [{ nodeId: 'node-pc', name: 'PC', fingerprint: 'f', addresses: [], platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1, status: 'reachable', since: 0, lastSyncedAt: null, syncError: null, activeChats: ['chat-pc'] }],
      },
    });
    render(<Inspector chat={chat} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    expect(within(workspaceSection()).getByTestId('workspace-also-active')).toHaveTextContent('Also active on PC: "Refactor" has a reply running in this folder.');
  });
});

describe('Inspector workspace root', () => {
  afterEach(cleanup);

  it('shows an honest empty state, and that tools are unavailable, when no workspace is set', async () => {
    render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(await within(workspaceSection()).findByText(/no workspace folder is set/i)).toBeInTheDocument();
    expect(within(workspaceSection()).getByText(/filesystem and shell tools are unavailable/i)).toBeInTheDocument();
  });

  it('says a Claude Code chat with no folder is a plain chat with web and MCP tools only', async () => {
    useOtherBenchStore.setState({ connections: [{ id: 'c1', name: 'Claude Code', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null }] });
    render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(await within(workspaceSection()).findByText('No folder: a plain chat. Web and MCP tools only; set a folder to let Claude Code use your files.')).toBeInTheDocument();
    expect(within(workspaceSection()).queryByText(/filesystem and shell tools are unavailable/i)).not.toBeInTheDocument();
    useOtherBenchStore.setState({ connections: [] });
  });

  it('shows the current workspace path and the concrete consequence for this profile when one is set', async () => {
    render(
      <Inspector
        chat={makeChat({ workspaceRoot: 'E:\\Git\\OtherBench' })}
        profile={makeProfile({ toolPolicy: { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'always_ask' } })}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />
    );
    expect(await within(workspaceSection()).findByTestId('workspace-root-value')).toHaveTextContent('E:\\Git\\OtherBench');
    expect(within(workspaceSection()).getByText(/can read and write files.*run shell commands/i)).toBeInTheDocument();
  });

  it('flags when the profile has fs/shell turned off by policy even though a workspace is configured', async () => {
    render(
      <Inspector
        chat={makeChat({ workspaceRoot: 'E:\\Git\\OtherBench' })}
        profile={makeProfile({ toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } })}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />
    );
    expect(await within(workspaceSection()).findByText(/turned off by policy/i)).toBeInTheDocument();
  });

  it('in the desktop app, Choose folder… fills the field from the native picker; a browser has only the field', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await user.click(await within(workspaceSection()).findByRole('button', { name: /set workspace/i }));
    expect(within(workspaceSection()).queryByRole('button', { name: 'Choose folder…' })).not.toBeInTheDocument();
    unmount();

    mockedIsDesktop.mockReturnValue(true);
    mockedPickFolder.mockResolvedValue('E:\\Work\\App');
    render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await user.click(await within(workspaceSection()).findByRole('button', { name: /set workspace/i }));
    await user.click(within(workspaceSection()).getByRole('button', { name: 'Choose folder…' }));
    await waitFor(() => expect(within(workspaceSection()).getByRole('textbox', { name: 'Workspace folder' })).toHaveValue('E:\\Work\\App'));
    mockedIsDesktop.mockReturnValue(false);
  });

  it('in the desktop app, Open terminal opens one in the folder; a browser has no such button', async () => {
    const user = userEvent.setup();
    const chat = makeChat({ workspaceRoot: 'E:\\Git\\OtherBench', workspaceStatus: { status: 'ok', root: 'E:\\Git\\OtherBench' } });
    const { unmount } = render(<Inspector chat={chat} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await within(workspaceSection()).findByTestId('workspace-root-value');
    expect(within(workspaceSection()).queryByRole('button', { name: 'Open terminal' })).toBeNull();
    unmount();

    mockedIsDesktop.mockReturnValue(true);
    mockedOpenTerminal.mockReset().mockResolvedValue(undefined);
    render(<Inspector chat={chat} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await user.click(await within(workspaceSection()).findByRole('button', { name: 'Open terminal' }));
    expect(mockedOpenTerminal).toHaveBeenCalledWith('E:\\Git\\OtherBench');
    mockedIsDesktop.mockReturnValue(false);
  });

  it("offers no terminal for a chat that runs on another machine, or whose folder isn't here", async () => {
    mockedIsDesktop.mockReturnValue(true);
    useOtherBenchStore.setState({ machines: { self: { id: 'node-self', name: 'Laptop', fingerprint: 'A' }, listening: { running: true, addresses: [] }, peers: [] } });
    const { unmount } = render(
      <Inspector chat={makeChat({ runsOn: 'node-pc', workspaceRoot: 'D:\\Work' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />
    );
    await within(workspaceSection()).findByTestId('workspace-root-value');
    expect(within(workspaceSection()).queryByRole('button', { name: 'Open terminal' })).toBeNull();
    unmount();

    render(
      <Inspector
        chat={makeChat({ workspaceRoot: null, workspaceStatus: { status: 'unresolved', reason: 'missing', hint: { nodeId: 'node-self', path: 'E:\\Gone' } } })}
        profile={makeProfile()}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />
    );
    await within(workspaceSection()).findByTestId('workspace-unresolved');
    expect(within(workspaceSection()).queryByRole('button', { name: 'Open terminal' })).toBeNull();
    useOtherBenchStore.setState({ machines: null });
    mockedIsDesktop.mockReturnValue(false);
  });

  it("says so when the terminal won't open", async () => {
    mockedIsDesktop.mockReturnValue(true);
    mockedOpenTerminal.mockReset().mockRejectedValue('No terminal found: tried wt.exe and powershell.exe.');
    const user = userEvent.setup();
    render(<Inspector chat={makeChat({ workspaceRoot: 'E:\\Git\\OtherBench' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await user.click(await within(workspaceSection()).findByRole('button', { name: 'Open terminal' }));
    expect(await within(workspaceSection()).findByTestId('workspace-root-error')).toHaveTextContent("Couldn't open a terminal: No terminal found: tried wt.exe and powershell.exe.");
    mockedIsDesktop.mockReturnValue(false);
  });

  it('rejects a Git-Bash-style path on a Windows server with a specific, actionable message, and never saves it', async () => {
    mockedHealth.mockResolvedValue({ status: 'ok', time: '', platform: 'win32' });
    const user = userEvent.setup();
    render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await user.click(await within(workspaceSection()).findByRole('button', { name: /set workspace/i }));
    await user.type(within(workspaceSection()).getByLabelText('Workspace folder'), '/e/Git/OtherBench');
    await user.click(within(workspaceSection()).getByRole('button', { name: /^save$/i }));

    expect(await within(workspaceSection()).findByTestId('workspace-root-error')).toHaveTextContent(/git-bash/i);
    expect(within(workspaceSection()).getByTestId('workspace-root-error')).toHaveTextContent(/E:\\/);
    expect(mockedChatsPatch).not.toHaveBeenCalled();
  });

  it('accepts a native Windows absolute path and saves it', async () => {
    mockedHealth.mockResolvedValue({ status: 'ok', time: '', platform: 'win32' });
    mockedChatsPatch.mockResolvedValue(makeChat({ workspaceRoot: 'E:\\Git\\OtherBench' }));
    const user = userEvent.setup();
    render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await user.click(await within(workspaceSection()).findByRole('button', { name: /set workspace/i }));
    await user.type(within(workspaceSection()).getByLabelText('Workspace folder'), 'E:\\Git\\OtherBench');
    await user.click(within(workspaceSection()).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', { workspaceRoot: 'E:\\Git\\OtherBench' }));
    expect(await within(workspaceSection()).findByTestId('workspace-root-value')).toHaveTextContent('E:\\Git\\OtherBench');
  });

  it('Clear removes the workspace root without requiring the edit form', async () => {
    mockedChatsPatch.mockResolvedValue(makeChat({ workspaceRoot: null }));
    const user = userEvent.setup();
    render(<Inspector chat={makeChat({ workspaceRoot: 'E:\\Git\\OtherBench' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await user.click(await within(workspaceSection()).findByRole('button', { name: /^clear$/i }));

    await waitFor(() => expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', { workspaceRoot: null }));
    expect(await within(workspaceSection()).findByText(/no workspace folder is set/i)).toBeInTheDocument();
  });

  it('surfaces a server-rejected save instead of throwing', async () => {
    mockedChatsPatch.mockRejectedValue(new ApiError(400, 'workspaceRoot must be an absolute path'));
    const user = userEvent.setup();
    render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await user.click(await within(workspaceSection()).findByRole('button', { name: /set workspace/i }));
    await user.type(within(workspaceSection()).getByLabelText('Workspace folder'), 'E:\\Git\\OtherBench');
    await user.click(within(workspaceSection()).getByRole('button', { name: /^save$/i }));

    expect(await within(workspaceSection()).findByTestId('workspace-root-error')).toHaveTextContent('workspaceRoot must be an absolute path');
  });
});

describe('Inspector MCP server health', () => {
  afterEach(cleanup);

  it('shows an honest empty state when no servers are configured', async () => {
    mockedMcpList.mockResolvedValue([]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(await within(mcpHealthSection()).findByText('No MCP servers are configured.')).toBeInTheDocument();
  });

  it('renders each server\'s live status and tool count, and lets a manual refresh be triggered', async () => {
    mockedMcpList.mockResolvedValue([
      { id: 'srv-1', name: 'Filesystem MCP', transport: 'stdio', enabled: true, status: 'ok', lastError: null, toolCount: 3, auth: null },
      { id: 'srv-2', name: 'Broken Server', transport: 'http', enabled: true, status: 'error', lastError: 'connection refused', toolCount: 0, auth: null },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    const section = await within(mcpHealthSection()).findByTestId('mcp-health');
    expect(within(section).getByText('Filesystem MCP')).toBeInTheDocument();
    expect(within(section).getByText('3 tools')).toBeInTheDocument();
    expect(within(section).getByText(/connection refused/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(mcpHealthSection()).getByRole('button', { name: 'Refresh Filesystem MCP' }));
    expect(mockedMcpRefresh).toHaveBeenCalledWith('srv-1');
  });

  it('shows a server that needs sign-in, with a pointer to Settings', async () => {
    mockedMcpList.mockResolvedValue([
      { id: 'srv-h', name: 'Hosted Docs', transport: 'http', enabled: true, status: 'needs_auth', lastError: 'This server needs you to sign in.', toolCount: 0, auth: { state: 'needs_sign_in', account: null, signedInAt: null, pending: false, error: null } },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    const section = await within(mcpHealthSection()).findByTestId('mcp-health');
    expect(within(section).getByText('needs sign-in')).toBeInTheDocument();
    expect(within(section).getByText('Hosted Docs: needs sign-in (Settings > MCP servers).')).toBeInTheDocument();
    expect(within(section).getByTestId('mcp-status-dot')).toHaveAttribute('data-status', 'needs_auth');
  });

  it('shows an error state, not a crash, when the health fetch fails', async () => {
    mockedMcpList.mockRejectedValue(new Error('down'));
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(await within(mcpHealthSection()).findByText(/couldn.t load mcp server health/i)).toBeInTheDocument();
  });
});

describe("Inspector MCP servers on the chat's profile", () => {
  afterEach(cleanup);

  const servers = [
    { id: 'srv-1', name: 'nextcloud', transport: 'stdio' as const, enabled: true, status: 'ok' as const, lastError: null, toolCount: 73, auth: null },
    { id: 'srv-2', name: 'blender', transport: 'stdio' as const, enabled: true, status: 'ok' as const, lastError: null, toolCount: 9, auth: null },
  ];
  const opus = (mcpServerIds: string[]) =>
    makeProfile({ name: 'Claude Opus 5.5', toolPolicy: { fs: 'off', shell: false, mcpServerIds, approvalMode: 'ask_on_mutate' } });

  it("ticks the servers that are on for the chat's profile, and says whose list it is", async () => {
    mockedMcpList.mockResolvedValue(servers);
    render(<Inspector chat={makeChat()} profile={opus(['srv-1'])} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(await within(mcpHealthSection()).findByRole('checkbox', { name: 'Use nextcloud in Claude Opus 5.5' })).toBeChecked();
    expect(within(mcpHealthSection()).getByRole('checkbox', { name: 'Use blender in Claude Opus 5.5' })).not.toBeChecked();
    expect(mcpHealthSection()).toHaveTextContent('Ticked servers are on for Claude Opus 5.5, in every chat that uses it.');
  });

  it('turning a server on or off saves the change to the profile and the store', async () => {
    const profile = opus(['srv-1']);
    useOtherBenchStore.setState({ profiles: [profile] });
    mockedMcpList.mockResolvedValue(servers);
    mockedProfilesPatch.mockImplementation(async (_id, body) => ({ ...profile, toolPolicy: { ...profile.toolPolicy, mcpServerIds: body.toolPolicy!.mcpServerIds! } }));
    const user = userEvent.setup();
    render(<Inspector chat={makeChat()} profile={profile} collapsed={false} onToggleCollapsed={vi.fn()} />);

    const blender = await within(mcpHealthSection()).findByRole('checkbox', { name: 'Use blender in Claude Opus 5.5' });
    await user.click(blender);
    expect(mockedProfilesPatch).toHaveBeenCalledWith('p1', { toolPolicy: { mcpServerIds: ['srv-1', 'srv-2'] } });
    await waitFor(() => expect(useOtherBenchStore.getState().profiles.find((p) => p.id === 'p1')!.toolPolicy.mcpServerIds).toEqual(['srv-1', 'srv-2']));
    expect(blender).toBeChecked();

    await user.click(within(mcpHealthSection()).getByRole('checkbox', { name: 'Use nextcloud in Claude Opus 5.5' }));
    expect(mockedProfilesPatch).toHaveBeenLastCalledWith('p1', { toolPolicy: { mcpServerIds: ['srv-2'] } });
    await waitFor(() => expect(useOtherBenchStore.getState().profiles.find((p) => p.id === 'p1')!.toolPolicy.mcpServerIds).toEqual(['srv-2']));
  });

  it('flips the box back and says why when the save fails', async () => {
    mockedMcpList.mockResolvedValue(servers);
    mockedProfilesPatch.mockRejectedValue(new ApiError(500, 'disk full'));
    const user = userEvent.setup();
    render(<Inspector chat={makeChat()} profile={opus([])} collapsed={false} onToggleCollapsed={vi.fn()} />);

    const blender = await within(mcpHealthSection()).findByRole('checkbox', { name: 'Use blender in Claude Opus 5.5' });
    await user.click(blender);
    expect(await within(mcpHealthSection()).findByRole('alert')).toHaveTextContent("Couldn't save the change to Claude Opus 5.5: disk full");
    expect(blender).not.toBeChecked();
  });

  it('shows no toggles when the profile is not loaded', async () => {
    mockedMcpList.mockResolvedValue(servers);
    render(<Inspector chat={makeChat()} profile={null} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(await within(mcpHealthSection()).findByText('nextcloud')).toBeInTheDocument();
    expect(within(mcpHealthSection()).queryByRole('checkbox')).toBeNull();
  });
});

describe('Inspector tool grants', () => {
  afterEach(cleanup);

  it('lists active grants for the chat and revoking one removes it immediately, without waiting for the next poll', async () => {
    mockedGrantsList.mockResolvedValue([
      { id: 'g1', chatId: 'chat-1', profileId: null, toolName: 'write_file', source: 'fs', scope: 'chat', constraint: null, expiresAt: null },
      { id: 'g2', chatId: null, profileId: null, toolName: 'run_command', source: 'shell', scope: 'always', constraint: { commandPrefix: 'npm test' }, expiresAt: null },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await within(grantsSection()).findByTestId('grant-g1');
    expect(within(grantsSection()).getByText('write_file')).toBeInTheDocument();
    expect(within(grantsSection()).getByText(/npm test/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(grantsSection()).getByRole('button', { name: 'Revoke grant for run_command' }));
    expect(mockedGrantsRevoke).toHaveBeenCalledWith('g2');
    // Gone from the DOM right away -- optimistic removal, not "eventually, on the next poll".
    expect(within(grantsSection()).queryByTestId('grant-g2')).not.toBeInTheDocument();
    expect(within(grantsSection()).getByTestId('grant-g1')).toBeInTheDocument();
  });

  it('shows the site a browser grant is for', async () => {
    mockedGrantsList.mockResolvedValue([
      { id: 'g4', chatId: null, profileId: null, toolName: 'browser', source: 'browser', scope: 'always', constraint: { host: 'example.com' }, expiresAt: null },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await within(grantsSection()).findByTestId('grant-g4');
    expect(within(grantsSection()).getByText(/example\.com/)).toBeInTheDocument();
  });

  it('shows the program a computer-use grant is for, in full, so two apps can be told apart', async () => {
    mockedGrantsList.mockResolvedValue([
      { id: 'g5', chatId: null, profileId: null, toolName: 'computer', source: 'computer', scope: 'always', constraint: { app: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE' }, expiresAt: null },
      { id: 'g6', chatId: 'chat-1', profileId: null, toolName: 'computer', source: 'computer', scope: 'chat', constraint: { app: 'C:\\Program Files\\Notepad++\\notepad.exe' }, expiresAt: null },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const excel = await within(grantsSection()).findByTestId('grant-g5');
    expect(excel).toHaveTextContent('always · C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE');
    expect(within(excel).getByText('C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE').tagName).toBe('BDI');
    expect(within(grantsSection()).getByTestId('grant-g6')).toHaveTextContent('this chat · C:\\Program Files\\Notepad++\\notepad.exe');
  });

  it("spells out hidden characters in a stored grant's app rather than letting them reorder or hide text", async () => {
    mockedGrantsList.mockResolvedValue([
      { id: 'g7', chatId: null, profileId: null, toolName: 'computer', source: 'computer', scope: 'always', constraint: { app: 'C:\\Apps\\exe.\u202eTXT\u200b.exe' }, expiresAt: null },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const row = await within(grantsSection()).findByTestId('grant-g7');
    expect(row).toHaveTextContent('C:\\Apps\\exe.<U+202E>TXT<U+200B>.exe');
    expect(row.textContent).not.toContain('\u202e');
    expect(row.textContent).not.toContain('\u200b');
  });

  it('shows the pinned command for a commandExact grant (the default shape for an "Always allow" shell grant)', async () => {
    mockedGrantsList.mockResolvedValue([
      { id: 'g3', chatId: null, profileId: null, toolName: 'run_command', source: 'shell', scope: 'always', constraint: { commandExact: 'npm test' }, expiresAt: null },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await within(grantsSection()).findByTestId('grant-g3');
    expect(within(grantsSection()).getByText(/npm test/)).toBeInTheDocument();
  });

  it('shows the host of a network grant, so it can be seen and revoked', async () => {
    mockedGrantsList.mockResolvedValue([
      { id: 'g4', chatId: null, profileId: null, toolName: 'sandbox_network', source: 'network', scope: 'always', constraint: { host: 'pypi.org' }, expiresAt: null },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const row = await within(grantsSection()).findByTestId('grant-g4');
    expect(row).toHaveTextContent('pypi.org');
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Revoke grant for sandbox_network' }));
    expect(mockedGrantsRevoke).toHaveBeenCalledWith('g4');
  });

  it('shows which live artifact call a live grant is for', async () => {
    mockedGrantsList.mockResolvedValue([
      { id: 'g4', chatId: 'chat-1', profileId: 'p1', toolName: 'mcp__Live__lookup', source: 'mcp', scope: 'chat', constraint: { live: { artifactId: 'art', callId: 'value', hash: 'h', serverId: 'srv-live' } }, expiresAt: null },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const row = await within(grantsSection()).findByTestId('grant-g4');
    expect(row).toHaveTextContent('this chat · live artifact call value');
  });

  it('shows an honest empty state with no chat selected, and never calls the API', () => {
    render(<Inspector chat={null} profile={null} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(within(grantsSection()).getByText('No chat selected.')).toBeInTheDocument();
    expect(mockedGrantsList).not.toHaveBeenCalled();
  });
});

describe('Inspector audit trail', () => {
  afterEach(cleanup);

  it('lists recorded tool calls, newest first, with a summary that never includes raw content', async () => {
    mockedAuditList.mockResolvedValue([
      { id: 'a1', chatId: 'chat-1', messageId: 'm1', toolName: 'write_file', argsRedacted: { path: 'x.txt', content: '[redacted]' }, resultSummary: 'ok (2 fields)', durationMs: 12, grantedBy: 'ask:once', createdAt: 1000 },
      { id: 'a2', chatId: 'chat-1', messageId: 'm1', toolName: 'run_command', argsRedacted: { command: 'npm test' }, resultSummary: 'ok (5 fields)', durationMs: 4000, grantedBy: 'ask:chat', createdAt: 5000 },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    const list = await within(auditSection()).findByTestId('audit-trail');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Newest (createdAt: 5000) first.
    expect(items[0]).toHaveTextContent('run_command');
    expect(items[1]).toHaveTextContent('write_file');
    expect(list).not.toHaveTextContent('[redacted]'); // the redaction happened server-side; this just must not defeat it by rendering raw args
  });

  it('labels a live artifact call', async () => {
    mockedAuditList.mockResolvedValue([{ id: 'l1', chatId: 'chat-1', messageId: 'm1', toolName: 'mcp__Live__lookup', argsRedacted: {}, resultSummary: 'ok', durationMs: 1, grantedBy: 'live:3aa2d2fd', createdAt: 1000 }]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const list = await within(auditSection()).findByTestId('audit-trail');
    expect(within(within(list).getByTestId('audit-l1')).getByText('live artifact')).toHaveAttribute('title', 'live:3aa2d2fd');
  });

  it('shows short labels for how each call was authorised, keeping the raw value in a tooltip', async () => {
    const raws = ['auto_read', 'policy', 'grant:3aa2d2fd-fccb-4d62-a505-86f4357ae984', 'ask:once', 'ask:chat', 'ask:always', 'deny:policy', 'deny:user', 'deny:cancelled', 'auto', 'deny:auto', 'deny:unattended', 'weird:thing'];
    mockedAuditList.mockResolvedValue(
      raws.map((grantedBy, i) => ({ id: `g${i}`, chatId: 'chat-1', messageId: 'm1', toolName: 't', argsRedacted: {}, resultSummary: 'ok', durationMs: 1, grantedBy, createdAt: 1000 + i })),
    );
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const list = await within(auditSection()).findByTestId('audit-trail');
    await userEvent.setup().click(within(auditSection()).getByRole('button', { name: 'Show all (13)' }));
    const labels = ['auto-read', 'policy', 'grant', 'asked: once', 'asked: this chat', 'asked: always', 'denied by policy', 'denied by you', 'stopped (not denied)', 'auto mode', 'blocked by auto mode', 'refused: nobody to approve (scheduled run)', 'weird:thing'];
    raws.forEach((raw, i) => {
      const label = within(within(list).getByTestId(`audit-g${i}`)).getByText(labels[i]!);
      expect(label).toHaveAttribute('title', raw);
    });
    expect(list).not.toHaveTextContent('3aa2d2fd');
  });

  it('shows the newest 5 entries, with Show all / Show fewer', async () => {
    mockedAuditList.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, chatId: 'chat-1', messageId: 'm1', toolName: `tool${i}`, argsRedacted: {}, resultSummary: 'ok', durationMs: 1, grantedBy: 'policy', createdAt: 1000 + i })),
    );
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const list = await within(auditSection()).findByTestId('audit-trail');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('tool7');

    const user = userEvent.setup();
    await user.click(within(auditSection()).getByRole('button', { name: 'Show all (8)' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    await user.click(within(auditSection()).getByRole('button', { name: 'Show fewer' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  });

  it('has no Show all button when there are 5 or fewer entries', async () => {
    mockedAuditList.mockResolvedValue([{ id: 'a1', chatId: 'chat-1', messageId: 'm1', toolName: 't', argsRedacted: {}, resultSummary: 'ok', durationMs: 1, grantedBy: 'policy', createdAt: 1 }]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await within(auditSection()).findByTestId('audit-trail');
    expect(within(auditSection()).queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
  });

  it('shows an honest empty state when nothing has been audited yet', async () => {
    mockedAuditList.mockResolvedValue([]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(await within(auditSection()).findByText('No tool calls recorded in this chat yet.')).toBeInTheDocument();
  });
});

describe('Inspector project', () => {
  beforeEach(() => {
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    mockedUsageGet.mockReset().mockResolvedValue(makeRollup());
    window.localStorage.clear();
    resetSidebarGroupsForTests();
  });
  afterEach(cleanup);

  it('says "No project" for a chat outside any project, or whose project is gone', () => {
    render(<Inspector chat={makeChat({ projectId: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(screen.getByTestId('inspector-project')).toHaveTextContent('No project');
    cleanup();

    render(<Inspector chat={makeChat({ projectId: 'deleted' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(screen.getByTestId('inspector-project')).toHaveTextContent('No project');
  });

  it("links to the chat's project: clicking expands its sidebar group and scrolls to it", async () => {
    useOtherBenchStore.setState({ projects: [{ id: 'p-w', name: 'Website', description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
    window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(['p-w']));
    const target = document.createElement('div');
    target.id = groupDomId('p-w');
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);

    render(<Inspector chat={makeChat({ projectId: 'p-w' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Website' }));

    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)!)).toEqual([]);
    target.remove();
  });

  it("shows whether the chat's profile gets global memory", () => {
    render(<Inspector chat={makeChat({ projectId: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(screen.getByTestId('profile-global-memory')).toHaveTextContent('on');
    cleanup();
    render(<Inspector chat={makeChat({ projectId: null })} profile={makeProfile({ useGlobalMemory: false })} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(screen.getByTestId('profile-global-memory')).toHaveTextContent('off');
  });

  it("shows the project's description and opens its settings", async () => {
    useOtherBenchStore.setState({
      projects: [{ id: 'p-w', name: 'Website', description: 'The marketing site', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }],
    });
    render(<Inspector chat={makeChat({ projectId: 'p-w' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    expect(screen.getByTestId('inspector-project-description')).toHaveTextContent('The marketing site');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Project settings…' }));
    expect(useOtherBenchStore.getState().projectPage).toEqual({ mode: 'edit', projectId: 'p-w' });
  });

  it("moves focus to the project's group heading button after revealing it", async () => {
    useOtherBenchStore.setState({ projects: [{ id: 'p-w', name: 'Website', description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
    const target = document.createElement('div');
    target.id = groupDomId('p-w');
    target.scrollIntoView = vi.fn();
    const headingButton = document.createElement('button');
    headingButton.setAttribute('data-heading-main', '');
    target.appendChild(headingButton);
    document.body.appendChild(target);

    render(<Inspector chat={makeChat({ projectId: 'p-w' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Website' }));

    expect(headingButton).toHaveFocus();
    target.remove();
  });

  it('shows a Project memory section only for a chat in a loaded project', () => {
    useOtherBenchStore.setState({ projects: [{ id: 'p-w', name: 'Website', description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
    render(<Inspector chat={makeChat({ projectId: 'p-w' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(sectionNamed('Project memory')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-memory')).toHaveTextContent('memory for p-w');
    cleanup();

    render(<Inspector chat={makeChat({ projectId: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: /^Project memory/ })).toBeNull();
    cleanup();

    render(<Inspector chat={makeChat({ projectId: 'deleted' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(screen.queryByTestId('inspector-memory')).toBeNull();
  });
});

describe('Inspector other folders', () => {
  const refs = { kind: 'machine' as const, nodeId: 'node-self', root: 'E:\\Refs' };
  const refsView: FolderView = { workspace: refs, access: 'read', root: 'E:\\Refs', status: { status: 'ok', root: 'E:\\Refs' } };
  const workspace = { kind: 'machine' as const, nodeId: 'node-self', root: 'E:\\Git\\OtherBench' };
  const withFolders = (views: FolderView[]): Chat =>
    makeChat({ workspace, workspaceRoot: 'E:\\Git\\OtherBench', folders: views.map((v) => ({ workspace: v.workspace, access: v.access })), folderViews: views });

  beforeEach(() => {
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    mockedUsageGet.mockReset().mockResolvedValue(makeRollup());
  });
  afterEach(cleanup);

  it("lists the chat's folders; adding, changing access and removing each save the whole list, keeping folders in their stored form", async () => {
    mockedChatsPatch.mockResolvedValue(withFolders([refsView]));
    const user = userEvent.setup();
    render(<Inspector chat={withFolders([refsView])} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const section = foldersSection();
    expect(within(section).getByTestId('extra-folder')).toHaveTextContent('E:\\Refs');
    expect(within(section).getByRole('combobox', { name: 'Access to E:\\Refs' })).toHaveValue('read');

    await user.type(within(section).getByRole('textbox', { name: 'Add a folder for this chat' }), 'E:\\Scratch');
    await user.selectOptions(within(section).getByRole('combobox', { name: 'Access to the new folder for this chat' }), 'readwrite');
    await user.click(within(section).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', {
        folders: [
          { workspace: refs, access: 'read' },
          { path: 'E:\\Scratch', access: 'readwrite' },
        ],
      })
    );
    await waitFor(() => expect(within(section).getByRole('textbox', { name: 'Add a folder for this chat' })).toHaveValue(''));

    await user.selectOptions(within(section).getByRole('combobox', { name: 'Access to E:\\Refs' }), 'readwrite');
    await waitFor(() => expect(mockedChatsPatch).toHaveBeenLastCalledWith('chat-1', { folders: [{ workspace: refs, access: 'readwrite' }] }));

    await user.click(within(section).getByRole('button', { name: 'Remove E:\\Refs' }));
    await waitFor(() => expect(mockedChatsPatch).toHaveBeenLastCalledWith('chat-1', { folders: [] }));
  });

  it('refuses a relative path without saving, and shows what the server refused', async () => {
    const user = userEvent.setup();
    render(<Inspector chat={withFolders([])} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const section = foldersSection();
    expect(within(section).getByText('None.')).toBeInTheDocument();
    const input = within(section).getByRole('textbox', { name: 'Add a folder for this chat' });

    await user.type(input, 'refs{Enter}');
    expect(await within(section).findByRole('alert')).toBeInTheDocument();
    expect(mockedChatsPatch).not.toHaveBeenCalled();

    mockedChatsPatch.mockRejectedValue(new ApiError(400, '"folders[0]" is the workspace folder itself; it\'s already available.'));
    await user.clear(input);
    await user.type(input, 'E:\\Git\\OtherBench{Enter}');
    await waitFor(() => expect(within(section).getByRole('alert')).toHaveTextContent('is the workspace folder itself'));
    // A refused folder stays in the field, to fix and try again.
    expect(input).toHaveValue('E:\\Git\\OtherBench');
  });

  it("marks a folder that isn't on the machine running the chat, by where it's known to be", () => {
    const away: FolderView = {
      workspace: { kind: 'machine', nodeId: 'node-pc', root: 'D:\\Shared' },
      access: 'readwrite',
      root: null,
      status: { status: 'unresolved', reason: 'other-machine', hint: { nodeId: 'node-pc', path: 'D:\\Shared' } },
    };
    render(<Inspector chat={withFolders([away])} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const row = within(foldersSection()).getByTestId('extra-folder');
    expect(row).toHaveTextContent('D:\\Shared');
    expect(row).toHaveTextContent('not on this machine');
  });

  it("for a chat in a project, also lists the project's folders and saves those on the project", async () => {
    const project: Project = {
      id: 'p-w',
      name: 'Website',
      description: '',
      instructions: '',
      workspace: null,
      workspaceRoot: null,
      defaultProfileId: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      folders: [{ workspace: refs, access: 'read' }],
      folderViews: [refsView],
    };
    useOtherBenchStore.setState({ projects: [project] });
    mockedProjectsPatch.mockResolvedValue(project);
    const user = userEvent.setup();
    render(<Inspector chat={{ ...withFolders([]), projectId: 'p-w' }} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const section = foldersSection();
    expect(within(section).getByRole('heading', { name: 'Every chat in Website' })).toBeInTheDocument();
    expect(within(section).getByRole('heading', { name: 'This chat' })).toBeInTheDocument();

    await user.type(within(section).getByRole('textbox', { name: 'Add a folder for the project' }), 'E:\\Brand{Enter}');
    await waitFor(() =>
      expect(mockedProjectsPatch).toHaveBeenCalledWith('p-w', {
        folders: [
          { workspace: refs, access: 'read' },
          { path: 'E:\\Brand', access: 'read' },
        ],
      })
    );
    expect(mockedChatsPatch).not.toHaveBeenCalled();
  });

  it('in the desktop app, Choose… adds a picked folder, but only for a chat that runs on this machine', async () => {
    mockedIsDesktop.mockReturnValue(true);
    mockedPickFolder.mockResolvedValue('E:\\Picked');
    mockedChatsPatch.mockResolvedValue(withFolders([]));
    const user = userEvent.setup();
    const { unmount } = render(<Inspector chat={withFolders([])} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await user.click(within(foldersSection()).getByRole('button', { name: 'Choose…' }));
    await waitFor(() => expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', { folders: [{ path: 'E:\\Picked', access: 'read' }] }));
    unmount();

    useOtherBenchStore.setState({ machines: { self: { id: 'node-self', name: 'Laptop', fingerprint: 'A' }, listening: { running: true, addresses: [] }, peers: [] } });
    render(<Inspector chat={{ ...withFolders([]), runsOn: 'node-pc' }} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(within(foldersSection()).queryByRole('button', { name: 'Choose…' })).toBeNull();
    mockedIsDesktop.mockReturnValue(false);
  });
});

describe('Inspector Progress', () => {
  beforeEach(() => {
    mockedUsageGet.mockReset().mockResolvedValue(makeRollup());
  });
  afterEach(cleanup);
  const todoCall = { type: 'tool-call' as const, id: 't1', name: 'update_todos', args: { todos: [{ content: 'Read', status: 'completed', activeForm: 'Reading' }, { content: 'Write', status: 'in_progress', activeForm: 'Writing' }] } };

  it("lists each running reply's checklist, named by profile in a compare, and hides once none is running", () => {
    useOtherBenchStore.setState({ messages: {
      a: makeMessage('a', { parts: [todoCall] }),
      b: makeMessage('b', { parts: [todoCall], producedBy: { profileId: 'p2', profileName: 'Beta', connectionId: 'c1', modelId: 'm' } }),
    } });
    const { rerender } = render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Progress' })).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getAllByTestId('todo-checklist')).toHaveLength(2);
    useOtherBenchStore.setState({ messages: { a: makeMessage('a', { parts: [todoCall], status: 'complete' }) } });
    rerender(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.queryByRole('heading', { name: 'Progress' })).toBeNull();
  });

  it('words a plan refusal in the audit trail', async () => {
    mockedAuditList.mockResolvedValue([{ id: 'x', chatId: 'chat-1', messageId: 'm', toolName: 'write_file', argsRedacted: {}, resultSummary: 'error: plan_mode', durationMs: 1, grantedBy: 'deny:plan', createdAt: Date.now() }] as never);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={() => {}} />);
    expect(await screen.findByText('refused: no plan approved yet')).toBeInTheDocument();
  });
});

describe('Inspector condensed sections', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetInspectorSectionsForTests();
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    mockedUsageGet.mockReset().mockResolvedValue(makeRollup());
  });
  afterEach(cleanup);

  const toggle = (title: string): HTMLElement => within(sectionNamed(title)).getByRole('button', { name: new RegExp(`^${title}`) });

  it('opens only Workspace by default; the rest are closed but say what they hold', async () => {
    mockedGrantsList.mockResolvedValue([{ id: 'g1', chatId: 'chat-1', profileId: null, toolName: 'write_file', source: 'fs', scope: 'chat', constraint: null, expiresAt: null }]);
    mockedAuditList.mockResolvedValue([{ id: 'a1', chatId: 'chat-1', messageId: 'm1', toolName: 't', argsRedacted: {}, resultSummary: 'ok', durationMs: 1, grantedBy: 'policy', createdAt: 1 }]);
    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 4.5,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'model-x', currency: 'USD', measuredCost: 4.5, tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0, completeCount: 1, cancelledCount: 0, unmeasuredErrorCount: 0, subagentCount: 0, backgroundCount: 0 }],
      })
    );
    render(<Inspector chat={makeChat({ workspaceRoot: 'E:\\Git\\OtherBench' })} profile={makeProfile({ name: 'Sonnet' })} collapsed={false} onToggleCollapsed={vi.fn()} />);

    expect(toggle('Workspace')).toHaveAttribute('aria-expanded', 'true');
    expect(toggle('Workspace')).toHaveAccessibleName('Workspace OtherBench');
    await waitFor(() => expect(toggle('Tool grants')).toHaveAccessibleName('Tool grants 1 active'));
    await waitFor(() => expect(toggle('Audit trail')).toHaveAccessibleName('Audit trail 1 call'));
    await waitFor(() => expect(toggle('Spend')).toHaveAccessibleName('Spend $4.50'));
    expect(toggle('Profile')).toHaveAccessibleName('Profile Sonnet');
    for (const title of ['Other folders', 'Profile', 'Tool grants', 'MCP servers', 'Audit trail', 'Spend']) {
      expect(toggle(title)).toHaveAttribute('aria-expanded', 'false');
    }
    expect(within(grantsSection()).getByTestId('grant-g1')).not.toBeVisible();

    await userEvent.setup().click(toggle('Tool grants'));
    expect(within(grantsSection()).getByTestId('grant-g1')).toBeVisible();
  });

  it("opens MCP servers by itself when a server the profile uses needs sign-in, but not for one it doesn't use", async () => {
    mockedMcpList.mockResolvedValue([
      { id: 'srv-1', name: 'Hosted Docs', transport: 'http', enabled: true, status: 'needs_auth', lastError: null, toolCount: 0, auth: null },
      { id: 'srv-2', name: 'Broken', transport: 'stdio', enabled: true, status: 'error', lastError: 'boom', toolCount: 0, auth: null },
    ]);
    const profile = makeProfile({ toolPolicy: { fs: 'off', shell: false, mcpServerIds: ['srv-1'], approvalMode: 'always_ask' } });
    render(<Inspector chat={makeChat()} profile={profile} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await waitFor(() => expect(toggle('MCP servers')).toHaveAccessibleName('MCP servers 1 of 2 on · 1 needs sign-in'));
    expect(toggle('MCP servers')).toHaveAttribute('aria-expanded', 'true');
    expect(within(mcpHealthSection()).getByRole('checkbox', { name: 'Use Hosted Docs in Default' })).toBeVisible();
  });

  it('flags a workspace folder that is not found on this machine', () => {
    render(
      <Inspector
        chat={makeChat({ workspaceRoot: null, workspaceStatus: { status: 'unresolved', reason: 'other-machine', hint: { nodeId: 'node-pc', path: 'D:\\Work' } } })}
        profile={makeProfile()}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />
    );
    expect(toggle('Workspace')).toHaveAccessibleName('Workspace not found here');
    expect(within(sectionNamed('Workspace')).getByText('not found here')).toHaveAttribute('data-tone', 'warn');
  });

  it('puts Runs on inside the Workspace section once a machine is paired', () => {
    useOtherBenchStore.setState({
      machines: {
        self: { id: 'node-self', name: 'Laptop', fingerprint: 'A' },
        listening: { running: true, addresses: [] },
        peers: [{ nodeId: 'node-pc', name: 'PC', fingerprint: 'f', addresses: [], platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1, status: 'reachable', since: 0, lastSyncedAt: null, syncError: null }],
      },
    });
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(within(workspaceSection()).getByRole('combobox', { name: 'Runs on' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: /^Runs on/ })).toBeNull();
  });
});
