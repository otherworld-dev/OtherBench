import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { UsageRollup } from '@grunt/core/domain/usage-rollup.js';
import type { Profile } from '@grunt/core/types/config.js';
import { Inspector } from './Inspector.js';
import { useGruntStore } from '../state/store.js';
import { COLLAPSED_GROUPS_STORAGE_KEY, groupDomId, resetSidebarGroupsForTests } from '../state/sidebarGroups.js';

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
    },
  };
});

vi.mock('./InspectorMemory.js', () => ({
  InspectorMemory: ({ project }: { project: { id: string } }) => <div data-testid="inspector-memory">memory for {project.id}</div>,
}));

import { ApiError, api } from '../state/api.js';

const mockedUsageGet = vi.mocked(api.usage.get);
const mockedMcpList = vi.mocked(api.mcpServers.list);
const mockedMcpRefresh = vi.mocked(api.mcpServers.refresh);
const mockedGrantsList = vi.mocked(api.grants.list);
const mockedGrantsRevoke = vi.mocked(api.grants.revoke);
const mockedAuditList = vi.mocked(api.audit.list);
const mockedHealth = vi.mocked(api.health);
const mockedChatsPatch = vi.mocked(api.chats.patch);

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    title: 'Chat 1',
    profileId: 'p1',
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    autoMode: false,
    projectId: null,
    memoryCursor: null,
    memoryExcluded: false,
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

// Applies to every test in this file: the three new honest-state sections
// (MCP health, grants, audit) mount unconditionally alongside session spend,
// so every test needs SOME resolved value for them, not just the ones that
// specifically exercise those sections below.
beforeEach(() => {
  mockedMcpList.mockReset().mockResolvedValue([]);
  mockedMcpRefresh.mockReset().mockResolvedValue(undefined);
  mockedGrantsList.mockReset().mockResolvedValue([]);
  mockedGrantsRevoke.mockReset().mockResolvedValue(undefined);
  mockedAuditList.mockReset().mockResolvedValue([]);
  mockedHealth.mockReset().mockResolvedValue({ status: 'ok', time: '', platform: 'win32' });
  mockedChatsPatch.mockReset();
});

describe('Inspector session spend', () => {
  beforeEach(() => {
    useGruntStore.setState(useGruntStore.getInitialState(), true);
    mockedUsageGet.mockReset();
  });
  afterEach(cleanup);

  it('shows "No chat selected" when there is no active chat', () => {
    render(<Inspector chat={null} profile={null} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const spendSection = screen.getByRole('heading', { name: 'Running session spend' }).closest('section')!;
    expect(within(spendSection).getByText('No chat selected.')).toBeInTheDocument();
    expect(mockedUsageGet).not.toHaveBeenCalled();
  });

  it('fetches and renders the per-profile spend rollup for the active chat', async () => {
    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 4.5,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'model-x', currency: 'USD', measuredCost: 4.5, tokensIn: 100, tokensOut: 50, tokensCached: 0, tokensReasoning: 0, completeCount: 2, cancelledCount: 0, unmeasuredErrorCount: 0 }],
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
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'model-x', currency: 'USD', measuredCost: 2, tokensIn: 10, tokensOut: 10, tokensCached: 0, tokensReasoning: 0, completeCount: 1, cancelledCount: 1, unmeasuredErrorCount: 1 }],
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
    useGruntStore.getState().registerMessage(makeMessage('m1', { status: 'streaming' }));

    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('No usage recorded in this chat yet.')).toBeInTheDocument();

    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 3,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'model-x', currency: 'USD', measuredCost: 3, tokensIn: 10, tokensOut: 10, tokensCached: 0, tokensReasoning: 0, completeCount: 1, cancelledCount: 0, unmeasuredErrorCount: 0 }],
      })
    );
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'status', status: 'complete' });

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

function mcpHealthSection(): HTMLElement {
  return screen.getByRole('heading', { name: 'MCP server health' }).closest('section')!;
}
function grantsSection(): HTMLElement {
  return screen.getByRole('heading', { name: 'Tool grants' }).closest('section')!;
}
function auditSection(): HTMLElement {
  return screen.getByRole('heading', { name: 'Audit trail' }).closest('section')!;
}
function workspaceSection(): HTMLElement {
  return screen.getByRole('heading', { name: 'Workspace' }).closest('section')!;
}

describe('Inspector workspace root', () => {
  afterEach(cleanup);

  it('shows an honest empty state, and that tools are unavailable, when no workspace is set', async () => {
    render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(await within(workspaceSection()).findByText(/no workspace folder is set/i)).toBeInTheDocument();
    expect(within(workspaceSection()).getByText(/filesystem and shell tools are unavailable/i)).toBeInTheDocument();
  });

  it('shows the current workspace path and the concrete consequence for this profile when one is set', async () => {
    render(
      <Inspector
        chat={makeChat({ workspaceRoot: 'E:\\Git\\Grunt' })}
        profile={makeProfile({ toolPolicy: { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'always_ask' } })}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />
    );
    expect(await within(workspaceSection()).findByTestId('workspace-root-value')).toHaveTextContent('E:\\Git\\Grunt');
    expect(within(workspaceSection()).getByText(/can read and write files.*run shell commands/i)).toBeInTheDocument();
  });

  it('flags when the profile has fs/shell turned off by policy even though a workspace is configured', async () => {
    render(
      <Inspector
        chat={makeChat({ workspaceRoot: 'E:\\Git\\Grunt' })}
        profile={makeProfile({ toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } })}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />
    );
    expect(await within(workspaceSection()).findByText(/turned off by policy/i)).toBeInTheDocument();
  });

  it('rejects a Git-Bash-style path on a Windows server with a specific, actionable message, and never saves it', async () => {
    mockedHealth.mockResolvedValue({ status: 'ok', time: '', platform: 'win32' });
    const user = userEvent.setup();
    render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await user.click(await within(workspaceSection()).findByRole('button', { name: /set workspace/i }));
    await user.type(within(workspaceSection()).getByLabelText('Workspace folder'), '/e/Git/Grunt');
    await user.click(within(workspaceSection()).getByRole('button', { name: /^save$/i }));

    expect(await within(workspaceSection()).findByTestId('workspace-root-error')).toHaveTextContent(/git-bash/i);
    expect(within(workspaceSection()).getByTestId('workspace-root-error')).toHaveTextContent(/E:\\/);
    expect(mockedChatsPatch).not.toHaveBeenCalled();
  });

  it('accepts a native Windows absolute path and saves it', async () => {
    mockedHealth.mockResolvedValue({ status: 'ok', time: '', platform: 'win32' });
    mockedChatsPatch.mockResolvedValue(makeChat({ workspaceRoot: 'E:\\Git\\Grunt' }));
    const user = userEvent.setup();
    render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await user.click(await within(workspaceSection()).findByRole('button', { name: /set workspace/i }));
    await user.type(within(workspaceSection()).getByLabelText('Workspace folder'), 'E:\\Git\\Grunt');
    await user.click(within(workspaceSection()).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', { workspaceRoot: 'E:\\Git\\Grunt' }));
    expect(await within(workspaceSection()).findByTestId('workspace-root-value')).toHaveTextContent('E:\\Git\\Grunt');
  });

  it('Clear removes the workspace root without requiring the edit form', async () => {
    mockedChatsPatch.mockResolvedValue(makeChat({ workspaceRoot: null }));
    const user = userEvent.setup();
    render(<Inspector chat={makeChat({ workspaceRoot: 'E:\\Git\\Grunt' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await user.click(await within(workspaceSection()).findByRole('button', { name: /^clear$/i }));

    await waitFor(() => expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', { workspaceRoot: null }));
    expect(await within(workspaceSection()).findByText(/no workspace folder is set/i)).toBeInTheDocument();
  });

  it('surfaces a server-rejected save instead of throwing', async () => {
    mockedChatsPatch.mockRejectedValue(new ApiError(400, 'workspaceRoot must be an absolute path'));
    const user = userEvent.setup();
    render(<Inspector chat={makeChat({ workspaceRoot: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await user.click(await within(workspaceSection()).findByRole('button', { name: /set workspace/i }));
    await user.type(within(workspaceSection()).getByLabelText('Workspace folder'), 'E:\\Git\\Grunt');
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
      { id: 'srv-1', name: 'Filesystem MCP', transport: 'stdio', enabled: true, status: 'ok', lastError: null, toolCount: 3 },
      { id: 'srv-2', name: 'Broken Server', transport: 'http', enabled: true, status: 'error', lastError: 'connection refused', toolCount: 0 },
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

  it('shows an error state, not a crash, when the health fetch fails', async () => {
    mockedMcpList.mockRejectedValue(new Error('down'));
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(await within(mcpHealthSection()).findByText(/couldn.t load mcp server health/i)).toBeInTheDocument();
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

  it('shows the pinned command for a commandExact grant (the default shape for an "Always allow" shell grant)', async () => {
    mockedGrantsList.mockResolvedValue([
      { id: 'g3', chatId: null, profileId: null, toolName: 'run_command', source: 'shell', scope: 'always', constraint: { commandExact: 'npm test' }, expiresAt: null },
    ]);
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await within(grantsSection()).findByTestId('grant-g3');
    expect(within(grantsSection()).getByText(/npm test/)).toBeInTheDocument();
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

  it('shows short labels for how each call was authorised, keeping the raw value in a tooltip', async () => {
    const raws = ['auto_read', 'policy', 'grant:3aa2d2fd-fccb-4d62-a505-86f4357ae984', 'ask:once', 'ask:chat', 'ask:always', 'deny:policy', 'deny:user', 'deny:cancelled', 'auto', 'deny:auto', 'weird:thing'];
    mockedAuditList.mockResolvedValue(
      raws.map((grantedBy, i) => ({ id: `g${i}`, chatId: 'chat-1', messageId: 'm1', toolName: 't', argsRedacted: {}, resultSummary: 'ok', durationMs: 1, grantedBy, createdAt: 1000 + i })),
    );
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const list = await within(auditSection()).findByTestId('audit-trail');
    await userEvent.setup().click(within(auditSection()).getByRole('button', { name: 'Show all (12)' }));
    const labels = ['auto-read', 'policy', 'grant', 'asked: once', 'asked: this chat', 'asked: always', 'denied by policy', 'denied by you', 'stopped (not denied)', 'auto mode', 'blocked by auto mode', 'weird:thing'];
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
    useGruntStore.setState(useGruntStore.getInitialState(), true);
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
    useGruntStore.setState({ projects: [{ id: 'p-w', name: 'Website', workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
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

  it("moves focus to the project's group heading button after revealing it", async () => {
    useGruntStore.setState({ projects: [{ id: 'p-w', name: 'Website', workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
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
    useGruntStore.setState({ projects: [{ id: 'p-w', name: 'Website', workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
    render(<Inspector chat={makeChat({ projectId: 'p-w' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Project memory' })).toBeInTheDocument();
    expect(screen.getByTestId('inspector-memory')).toHaveTextContent('memory for p-w');
    cleanup();

    render(<Inspector chat={makeChat({ projectId: null })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: 'Project memory' })).toBeNull();
    cleanup();

    render(<Inspector chat={makeChat({ projectId: 'deleted' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    expect(screen.queryByTestId('inspector-memory')).toBeNull();
  });
});
