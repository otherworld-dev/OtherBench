import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, ModelInfo, Profile } from '@otherbench/core/types/config.js';
import type { McpServerHealth } from '@otherbench/tools/mcp/manager.js';
import { useOtherBenchStore } from '../../state/store.js';
import { ProfilesPanel } from './ProfilesPanel.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      profiles: { list: vi.fn(), create: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      mcpServers: { list: vi.fn() },
      sandbox: { status: vi.fn() },
      computer: { status: vi.fn() },
      connections: { mediaModels: vi.fn() },
    },
  };
});

import { api, ApiError } from '../../state/api.js';

const mockedCreate = vi.mocked(api.profiles.create);
const mockedPatch = vi.mocked(api.profiles.patch);
const mockedDelete = vi.mocked(api.profiles.delete);
const mockedMcpList = vi.mocked(api.mcpServers.list);
const mockedSandboxStatus = vi.mocked(api.sandbox.status);
const mockedComputerStatus = vi.mocked(api.computer.status);
const mockedMediaModels = vi.mocked(api.connections.mediaModels);

function makeMcpServerHealth(overrides: Partial<McpServerHealth> = {}): McpServerHealth {
  return {
    id: 'mcp-1',
    name: 'Filesystem MCP',
    transport: 'stdio',
    enabled: true,
    status: 'ok',
    lastError: null,
    toolCount: 2,
    auth: null,
    ...overrides,
  };
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'Local Ollama',
    kind: 'ollama',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'ok',
    statusMessage: null,
    checkedAt: null,
    ...overrides,
  };
}

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'model-1',
    connectionId: 'conn-1',
    modelId: 'llama3.2',
    displayName: 'llama3.2',
    source: 'discovered',
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    contextWindow: null,
    maxOutput: null,
    priceInPer1m: null,
    priceOutPer1m: null,
    priceCachedPer1m: null,
    currency: 'USD',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    name: 'Everyday',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'llama3.2',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    ...overrides,
  };
}

function reset(): void {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  mockedCreate.mockReset();
  mockedPatch.mockReset();
  mockedDelete.mockReset();
  mockedMcpList.mockReset().mockResolvedValue([]);
  mockedSandboxStatus.mockReset().mockResolvedValue({ state: 'ready', packages: [], machine: 'This machine' });
  mockedComputerStatus.mockReset().mockResolvedValue({ computerUse: false });
  mockedMediaModels.mockReset().mockResolvedValue({ models: [], checkpoints: [] });
}

describe('ProfilesPanel', () => {
  it("saves the Artifacts switch in the profile's tools, on by default", async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedCreate.mockResolvedValue(makeProfile());
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'No artifacts');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    const box = screen.getByRole('checkbox', { name: 'Artifacts' });
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: expect.objectContaining({ artifacts: false }) })));
  });

  it.each([
    ['says computerUse: false', () => mockedComputerStatus.mockResolvedValue({ computerUse: false })],
    ['answers 401', () => mockedComputerStatus.mockRejectedValue(new ApiError(401, 'Unauthorized'))],
    ['answers 404', () => mockedComputerStatus.mockRejectedValue(new ApiError(404, 'Not Found'))],
    ['cannot be reached', () => mockedComputerStatus.mockRejectedValue(new TypeError('Failed to fetch'))],
  ])('hides the Computer use switch where the server %s, and keeps a profile’s stored value', async (_label, arrange) => {
    arrange();
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', computer: true } })]);
    mockedPatch.mockResolvedValue(makeProfile());
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    await waitFor(() => expect(mockedComputerStatus).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox', { name: 'Computer use' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('profile-1', expect.objectContaining({ toolPolicy: expect.objectContaining({ computer: true }) })));
  });

  it('shows the Computer use switch, off by default, with its hint, when the server can offer it', async () => {
    mockedComputerStatus.mockResolvedValue({ computerUse: true });
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedCreate.mockResolvedValue(makeProfile());
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Hands');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    const box = await screen.findByRole('checkbox', { name: 'Computer use' });
    expect(box).not.toBeChecked();
    expect(screen.getByText("Lets the model see your screen and use apps you approve, while you're at this computer. Desktop app on Windows only.")).toBeInTheDocument();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: expect.objectContaining({ computer: true }) })));
  });

  it('shows a profile with computer use on as checked, and turning it off saves false', async () => {
    mockedComputerStatus.mockResolvedValue({ computerUse: true });
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', computer: true } })]);
    mockedPatch.mockResolvedValue(makeProfile());
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    const box = await screen.findByRole('checkbox', { name: 'Computer use' });
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('profile-1', expect.objectContaining({ toolPolicy: expect.objectContaining({ computer: false }) })));
  });

  it("saves the Search past chats switch in the profile's tools, on by default", async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedCreate.mockResolvedValue(makeProfile());
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'No recall');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    const box = screen.getByRole('checkbox', { name: 'Search past chats' });
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: expect.objectContaining({ recall: false }) })));
  });

  it("saves the Sub-agents switch for an API profile, off by default", async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedCreate.mockResolvedValue(makeProfile());
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Splitter');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    const box = screen.getByRole('checkbox', { name: 'Sub-agents' });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/hand jobs to sub-agents that work on their own/)).toBeInTheDocument();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: expect.objectContaining({ subagents: true }) })));
  });

  it('hides the Sub-agents switch for a Claude Code profile', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection({ id: 'cc', name: 'Claude Code', kind: 'claude_code' })]);
    useOtherBenchStore.getState().setModels([makeModel({ connectionId: 'cc', modelId: 'sonnet' })]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ connectionId: 'cc', modelId: 'sonnet' })]);
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    expect(screen.getByLabelText('Bash')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Sub-agents' })).not.toBeInTheDocument();
  });

  it('can turn sub-agents off again for a profile that had them on', async () => {
    const profile = makeProfile({ toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', subagents: true } });
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([profile]);
    mockedPatch.mockResolvedValue(profile);
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    const box = screen.getByRole('checkbox', { name: 'Sub-agents' });
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('profile-1', expect.objectContaining({ toolPolicy: expect.objectContaining({ subagents: false }) })));
  });

  beforeEach(reset);
  afterEach(cleanup);

  it('saves the Use global memory switch, on by default, and shows it off for a profile that has it off', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ useGlobalMemory: false })]);
    mockedCreate.mockResolvedValue(makeProfile({ id: 'new-profile' }));
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    expect(screen.getByRole('checkbox', { name: 'Use global memory' })).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Clean room');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    const box = screen.getByRole('checkbox', { name: 'Use global memory' });
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ useGlobalMemory: false })));
  });

  it('creates a new profile with connection, model and tool policy', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedCreate.mockResolvedValue(makeProfile({ id: 'new-profile', name: 'Fast local' }));
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));

    await user.type(screen.getByLabelText('Profile name'), 'Fast local');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    await user.selectOptions(screen.getByLabelText('Filesystem access'), 'read');
    await user.click(screen.getByLabelText('Shell access'));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Fast local',
          connectionId: 'conn-1',
          modelId: 'llama3.2',
          toolPolicy: { fs: 'read', shell: true, approvalMode: 'always_ask', mcpServerIds: [], artifacts: true, recall: true, browser: false, computer: false },
        })
      )
    );
  });

  it('saves the Browser switch, off by default, and its blocked sites one per line', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedCreate.mockResolvedValue(makeProfile());
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Researcher');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    const box = screen.getByRole('checkbox', { name: 'Browser' });
    expect(box).not.toBeChecked();
    expect(screen.queryByLabelText('Blocked sites')).toBeNull();
    await user.click(box);
    expect(screen.getByText("The model's own browser, with no logins. Asks before each new website.")).toBeInTheDocument();
    await user.type(screen.getByLabelText('Blocked sites'), 'ads.test{enter}{enter} tracker.example ');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: expect.objectContaining({ browser: true, browserBlockedHosts: ['ads.test', 'tracker.example'] }) }))
    );
  });

  it("pre-fills Browser and the blocked sites when editing, and doesn't send the hidden box once Browser is unticked", async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([
      makeProfile({ toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', browser: true, browserBlockedHosts: ['ads.test', 'tracker.example'] } }),
    ]);
    mockedPatch.mockResolvedValue(makeProfile());
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    expect(screen.getByRole('checkbox', { name: 'Browser' })).toBeChecked();
    expect(screen.getByLabelText('Blocked sites')).toHaveValue('ads.test\ntracker.example');

    // A bad entry typed, then Browser unticked: the box is gone, and so is what it held.
    await user.type(screen.getByLabelText('Blocked sites'), '{enter}https://not a host');
    await user.click(screen.getByRole('checkbox', { name: 'Browser' }));
    expect(screen.queryByLabelText('Blocked sites')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    const sent = mockedPatch.mock.calls[0]![1].toolPolicy as Record<string, unknown>;
    expect(sent['browser']).toBe(false);
    expect('browserBlockedHosts' in sent).toBe(false);
  });

  it('shows why the server refused a blocked site (400), in the form', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    const refusal = '"https://ads.test" isn\'t a website name. Use a name like example.com, one per line.';
    mockedCreate.mockRejectedValue(new ApiError(400, refusal));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Researcher');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    await user.click(screen.getByRole('checkbox', { name: 'Browser' }));
    await user.type(screen.getByLabelText('Blocked sites'), 'https://ads.test');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: expect.objectContaining({ browser: true, browserBlockedHosts: ['https://ads.test'] }) }));
    // The form stays open with what was typed, so it can be put right.
    expect(screen.getByLabelText('Blocked sites')).toHaveValue('https://ads.test');
    errorLog.mockRestore();
  });

  it('requires a model to be chosen before saving', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    // No models discovered yet -- the model select is empty/disabled.
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'No model yet');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // Note: the (disabled) model <option> itself also reads "Choose a
    // model" -- match the error paragraph's exact text (with its trailing
    // period) so this doesn't collide with that option.
    expect(await screen.findByText('Choose a model.')).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('numeric params are optional -- blank omits the key, a non-number is rejected', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Bad temp');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    await user.type(screen.getByLabelText('Temperature'), 'not-a-number');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/params must be numbers/i)).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('leaving every param field blank sends an empty params object', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedCreate.mockResolvedValue(makeProfile());
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Plain');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ params: {} })));
  });

  it('editing an existing profile pre-fills its fields (name, params, tool policy)', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([
      makeProfile({
        name: 'Careful reviewer',
        params: { temperature: 0.2, topP: 0.9 },
        toolPolicy: { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate' },
        isDefault: true,
      }),
    ]);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));

    expect(screen.getByLabelText('Profile name')).toHaveValue('Careful reviewer');
    expect(screen.getByLabelText('Temperature')).toHaveValue('0.2');
    expect(screen.getByLabelText('Top P')).toHaveValue('0.9');
    expect(screen.getByLabelText('Filesystem access')).toHaveValue('readwrite');
    expect(screen.getByLabelText('Shell access')).toBeChecked();
    expect(screen.getByLabelText('Approval mode')).toHaveValue('ask_on_mutate');
    expect(screen.getByLabelText('Default profile')).toBeChecked();
  });

  it('resetting the model when switching to a connection with no shared models', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection({ id: 'conn-1', name: 'Ollama' }), makeConnection({ id: 'conn-2', name: 'OpenAI' })]);
    useOtherBenchStore.getState().setModels([makeModel({ id: 'm1', connectionId: 'conn-1', modelId: 'llama3.2' })]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ connectionId: 'conn-1', modelId: 'llama3.2' })]);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    expect(screen.getByLabelText('Model')).toHaveValue('llama3.2');

    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-2');

    // conn-2 has no models at all -- the model select must not still claim "llama3.2" is selected.
    expect(screen.getByLabelText('Model')).toHaveDisplayValue(/choose a model/i);
  });

  it('deleting a profile confirms first and warns that dependent chats are deleted too', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'profile-1', name: 'Doomed' })]);
    mockedDelete.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('profile-1'));
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/this cannot be undone/i);
    expect(screen.queryByTestId('profile-row-profile-1')).not.toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  // Finding 9 regression: put the real dependent-chat count in the
  // confirmation, the same as ConnectionsPanel's delete does.
  it('the delete confirmation states the REAL dependent chat count', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'profile-1', name: 'Doomed' })]);
    useOtherBenchStore.getState().setChats([
      { id: 'chat-1', title: 'A', profileId: 'profile-1', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, archivedAt: null, createdAt: 1, updatedAt: 1 },
      { id: 'chat-2', title: 'B', profileId: 'profile-1', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, archivedAt: null, createdAt: 1, updatedAt: 1 },
      { id: 'chat-3', title: 'C', profileId: 'some-other-profile', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, archivedAt: null, createdAt: 1, updatedAt: 1 },
    ]);
    mockedDelete.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalled());
    // Exactly the 2 chats built on THIS profile, not the unrelated 3rd one.
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/2 chats/i);

    confirmSpy.mockRestore();
  });

  it('with paired machines, the delete confirmation says their copies go too, and offers archiving; a profile bound to another machine says so', async () => {
    useOtherBenchStore.setState({
      machines: {
        self: { id: 'node-self', name: 'Laptop', fingerprint: 'A' },
        listening: { running: true, addresses: [] },
        peers: [{ nodeId: 'node-pc', name: 'PC', fingerprint: 'f', addresses: [], platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1, status: 'reachable', since: 0, lastSyncedAt: null, syncError: null }],
      },
    });
    useOtherBenchStore.getState().setConnections([makeConnection({ availability: 'node-pc' })]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'profile-1', name: 'Local Llama' })]);
    useOtherBenchStore.getState().setChats([
      { id: 'chat-1', title: 'A', profileId: 'profile-1', headMessageId: null, workspace: null, runsOn: 'node-pc', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, archivedAt: null, createdAt: 1, updatedAt: 1 },
    ]);
    mockedDelete.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    expect(screen.getByTestId('profile-only-on')).toHaveTextContent('Runs on PC only');
    await user.click(screen.getByTestId('profile-row-profile-1'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/Paired machines delete them too.*Archive the profile instead/);
    confirmSpy.mockRestore();
    useOtherBenchStore.setState({ machines: null });
  });

  it('the delete confirmation omits the chat clause when no chat depends on this profile', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'profile-1', name: 'Lonely' })]);
    mockedDelete.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0]?.[0]).not.toMatch(/chat/i);

    confirmSpy.mockRestore();
  });

  it('surfaces the server error instead of throwing when delete is refused', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'profile-1' })]);
    mockedDelete.mockRejectedValue(new Error('nope'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/delete failed/i)).toBeInTheDocument();
    // The row must still be there -- the delete did not silently succeed client-side.
    expect(screen.getByTestId('profile-row-profile-1')).toBeInTheDocument();
  });

  describe('MCP server allowlist (toolPolicy.mcpServerIds)', () => {
    it('shows an honest empty state when no MCP servers are configured', async () => {
      useOtherBenchStore.getState().setConnections([makeConnection()]);
      useOtherBenchStore.getState().setModels([makeModel()]);
      const user = userEvent.setup();

      render(<ProfilesPanel />);
      await user.click(screen.getByRole('button', { name: '+ New profile' }));

      expect(await screen.findByText(/no mcp servers configured yet/i)).toBeInTheDocument();
    });

    it('lists configured MCP servers, including disabled ones, and includes checked ids on save', async () => {
      useOtherBenchStore.getState().setConnections([makeConnection()]);
      useOtherBenchStore.getState().setModels([makeModel()]);
      mockedMcpList.mockResolvedValue([
        makeMcpServerHealth({ id: 'mcp-1', name: 'Filesystem MCP', enabled: true }),
        makeMcpServerHealth({ id: 'mcp-2', name: 'Disabled Server', enabled: false }),
      ]);
      mockedCreate.mockResolvedValue(makeProfile({ id: 'new-profile', toolPolicy: { fs: 'off', shell: false, mcpServerIds: ['mcp-1'], approvalMode: 'always_ask' } }));
      const user = userEvent.setup();

      render(<ProfilesPanel />);
      await user.click(screen.getByRole('button', { name: '+ New profile' }));

      const allowlist = await screen.findByTestId('mcp-server-allowlist');
      expect(allowlist).toHaveTextContent('Filesystem MCP');
      expect(allowlist).toHaveTextContent('Disabled Server');
      expect(allowlist).toHaveTextContent(/disabled/i); // the disabled server is annotated, not hidden

      await user.type(screen.getByLabelText('Profile name'), 'Uses MCP');
      await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
      await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
      await user.click(screen.getByLabelText('Allow MCP server Filesystem MCP'));
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() =>
        expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: { fs: 'off', shell: false, approvalMode: 'always_ask', mcpServerIds: ['mcp-1'], artifacts: true, recall: true, browser: false, computer: false } }))
      );
    });

    // Finding 8 regression: a failed GET /mcp-servers left the local
    // `mcpServers` array empty forever, and the checklist keyed purely on
    // `.length === 0` -- so a profile with a real, active allowlist was told
    // "No MCP servers configured yet", an outright false statement on an
    // access-control surface. The stored mcpServerIds must stay untouched
    // either way (nothing here widens or narrows the actual policy).
    it('shows an error state, not the "no servers configured" empty state, when the MCP server list fails to load', async () => {
      useOtherBenchStore.getState().setConnections([makeConnection()]);
      useOtherBenchStore.getState().setModels([makeModel()]);
      useOtherBenchStore.getState().setProfiles([
        makeProfile({ id: 'profile-1', toolPolicy: { fs: 'off', shell: false, mcpServerIds: ['mcp-1', 'mcp-2'], approvalMode: 'always_ask' } }),
      ]);
      mockedMcpList.mockRejectedValue(new Error('network down'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const user = userEvent.setup();

      render(<ProfilesPanel />);
      await user.click(screen.getByTestId('profile-row-profile-1'));

      expect(await screen.findByTestId('mcp-allowlist-error')).toHaveTextContent(/couldn.?t load mcp servers/i);
      // It must NOT claim there are no servers -- that's false; there are two, they just couldn't be fetched to display.
      expect(screen.queryByText(/no mcp servers configured yet/i)).not.toBeInTheDocument();
      expect(screen.queryByTestId('mcp-server-allowlist')).not.toBeInTheDocument();

      consoleErrorSpy.mockRestore();
    });

    it('pre-checks the servers already in an existing profile\'s allowlist, and unchecking one removes it on save', async () => {
      useOtherBenchStore.getState().setConnections([makeConnection()]);
      useOtherBenchStore.getState().setModels([makeModel()]);
      useOtherBenchStore.getState().setProfiles([
        makeProfile({ id: 'profile-1', toolPolicy: { fs: 'off', shell: false, mcpServerIds: ['mcp-1', 'mcp-2'], approvalMode: 'always_ask' } }),
      ]);
      mockedMcpList.mockResolvedValue([
        makeMcpServerHealth({ id: 'mcp-1', name: 'Server One' }),
        makeMcpServerHealth({ id: 'mcp-2', name: 'Server Two' }),
      ]);
      mockedPatch.mockResolvedValue(makeProfile({ id: 'profile-1' }));
      const user = userEvent.setup();

      render(<ProfilesPanel />);
      await user.click(screen.getByTestId('profile-row-profile-1'));
      await screen.findByTestId('mcp-server-allowlist');

      expect(screen.getByLabelText('Allow MCP server Server One')).toBeChecked();
      expect(screen.getByLabelText('Allow MCP server Server Two')).toBeChecked();

      await user.click(screen.getByLabelText('Allow MCP server Server Two'));
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('profile-1', expect.objectContaining({ toolPolicy: expect.objectContaining({ mcpServerIds: ['mcp-1'] }) })));
    });
  });

  it('shows Claude Code tool controls and hides sampling params for a claude_code connection', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection({ id: 'cc', name: 'Claude Code', kind: 'claude_code' })]);
    useOtherBenchStore.getState().setModels([makeModel({ connectionId: 'cc', modelId: 'sonnet' })]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ connectionId: 'cc', modelId: 'sonnet' })]);
    mockedMcpList.mockResolvedValue([makeMcpServerHealth()]);
    mockedPatch.mockResolvedValue(makeProfile({ connectionId: 'cc', modelId: 'sonnet' }));
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));

    expect(screen.queryByLabelText('Temperature')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Top P')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Bash')).toBeInTheDocument();
    expect(screen.getByLabelText('Web tools')).toBeInTheDocument();
    expect(screen.getByLabelText('MCP servers from your Claude Code config (folder chats only)')).toBeInTheDocument();
    expect(screen.getByLabelText('Your own Claude Code settings (folder chats only)')).not.toBeChecked();
    // OtherBench's own MCP servers are relayed into Claude Code chats, so the checklist is there too.
    expect(await screen.findByTestId('mcp-server-allowlist')).toBeInTheDocument();
    expect(screen.getByText('MCP servers (from OtherBench)')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Web tools'));
    await user.click(screen.getByLabelText('Your own Claude Code settings (folder chats only)'));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(mockedPatch).toHaveBeenCalledWith(
        'profile-1',
        expect.objectContaining({ toolPolicy: expect.objectContaining({ agentWeb: false, agentMcp: true, agentUserSettings: true }) })
      )
    );
  });
});

describe('ProfilesPanel: where the shell runs', () => {
  beforeEach(reset);
  afterEach(cleanup);

  async function newProfileWithShell(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedCreate.mockResolvedValue(makeProfile({ id: 'new-profile' }));
    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Sandboxed');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    expect(screen.queryByLabelText('Shell runs')).toBeNull();
    await user.click(screen.getByLabelText('Shell access'));
  }

  it('choosing "in the sandbox" saves shellRuns, and leaves the default allowlist out', async () => {
    const user = userEvent.setup();
    await newProfileWithShell(user);
    await user.selectOptions(screen.getByLabelText('Shell runs'), 'sandbox');
    expect(screen.getByLabelText('The sandbox can reach')).toHaveValue('registry.npmjs.org\npypi.org\nfiles.pythonhosted.org');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: expect.objectContaining({ shell: true, shellRuns: 'sandbox' }) })));
    expect(mockedCreate.mock.calls[0]![0].toolPolicy).not.toHaveProperty('sandboxHosts');
  });

  it('saves an edited allowlist, one host per line', async () => {
    const user = userEvent.setup();
    await newProfileWithShell(user);
    await user.selectOptions(screen.getByLabelText('Shell runs'), 'sandbox');
    const hosts = screen.getByLabelText('The sandbox can reach');
    await user.clear(hosts);
    await user.type(hosts, 'pypi.org{Enter}*.example.com');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: expect.objectContaining({ sandboxHosts: ['pypi.org', '*.example.com'] }) })));
  });

  it("says when the sandbox isn't set up on this machine", async () => {
    mockedSandboxStatus.mockResolvedValue({ state: 'not_set_up', packages: [], machine: 'This machine' });
    const user = userEvent.setup();
    await newProfileWithShell(user);
    expect(screen.queryByTestId('sandbox-not-ready-note')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Shell runs'), 'sandbox');
    expect(await screen.findByTestId('sandbox-not-ready-note')).toHaveTextContent('Settings > Sandbox');
  });

  it('"Reset to defaults" on a profile with its own list sends null', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    const own = makeProfile({ toolPolicy: { fs: 'readwrite', shell: true, shellRuns: 'sandbox', sandboxHosts: ['example.org'], mcpServerIds: [], approvalMode: 'ask_on_mutate' } });
    useOtherBenchStore.getState().setProfiles([own]);
    mockedPatch.mockResolvedValue(own);
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    expect(screen.getByLabelText('The sandbox can reach')).toHaveValue('example.org');
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('profile-1', expect.objectContaining({ toolPolicy: expect.objectContaining({ shellRuns: 'sandbox', sandboxHosts: null }) })));
  });

  it('switching a sandboxed profile back to this machine saves shellRuns "host"', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    const sandboxed = makeProfile({ toolPolicy: { fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [], approvalMode: 'ask_on_mutate' } });
    useOtherBenchStore.getState().setProfiles([sandboxed]);
    mockedPatch.mockResolvedValue(sandboxed);
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    await user.selectOptions(screen.getByLabelText('Shell runs'), 'host');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('profile-1', expect.objectContaining({ toolPolicy: expect.objectContaining({ shellRuns: 'host' }) })));
  });

  it("shows the server's message when it refuses the allowlist", async () => {
    const user = userEvent.setup();
    await newProfileWithShell(user);
    mockedCreate.mockRejectedValue(new ApiError(400, '"toolPolicy.sandboxHosts": "localhost" is not a hostname the sandbox can reach.'));
    await user.selectOptions(screen.getByLabelText('Shell runs'), 'sandbox');
    const hosts = screen.getByLabelText('The sandbox can reach');
    await user.clear(hosts);
    await user.type(hosts, 'localhost');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/"localhost" is not a hostname/)).toBeInTheDocument();
  });

  it('a blank allowlist means ask for every host, and is sent as an empty list', async () => {
    const user = userEvent.setup();
    await newProfileWithShell(user);
    await user.selectOptions(screen.getByLabelText('Shell runs'), 'sandbox');
    await user.clear(screen.getByLabelText('The sandbox can reach'));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: expect.objectContaining({ shellRuns: 'sandbox', sandboxHosts: [] }) })));
  });

  it('a Claude Code profile can run its shell in the sandbox too', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection({ id: 'cc', name: 'Claude Code', kind: 'claude_code' })]);
    useOtherBenchStore.getState().setModels([makeModel({ connectionId: 'cc', modelId: 'sonnet' })]);
    mockedCreate.mockResolvedValue(makeProfile({ id: 'new-profile' }));
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Claude sandboxed');
    await user.selectOptions(screen.getByLabelText('Connection'), 'cc');
    await user.click(screen.getByLabelText('Bash'));
    await user.selectOptions(screen.getByLabelText('Shell runs'), 'sandbox');
    const hosts = screen.getByLabelText('The sandbox can reach');
    await user.clear(hosts);
    await user.type(hosts, 'example.org');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ toolPolicy: expect.objectContaining({ shell: true, shellRuns: 'sandbox', sandboxHosts: ['example.org'], agentWeb: true }) })
      )
    );
  });
});

describe('ProfilesPanel generation', () => {
  beforeEach(reset);
  afterEach(cleanup);

  const comfy = makeConnection({ id: 'comfy', name: 'Studio ComfyUI', kind: 'comfyui' });
  const a1111 = makeConnection({ id: 'a1', name: 'Forge', kind: 'a1111' });

  async function openNew(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Painter');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
  }

  function arrange(): void {
    useOtherBenchStore.getState().setConnections([makeConnection(), comfy, a1111]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedMediaModels.mockImplementation(async (id) =>
      id === 'comfy'
        ? { models: [{ id: 'builtin:sdxl-txt2img', label: 'SDXL text to image' }, { id: 'w1', label: 'My flow' }], checkpoints: [] }
        : { models: [{ id: 'sdxl-base', label: 'SDXL base' }], checkpoints: [] }
    );
  }

  it('keeps generation connections out of the chat connection picker, and video to ComfyUI', async () => {
    arrange();
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    const chat = within(screen.getByLabelText('Connection')).getAllByRole('option').map((o) => o.textContent);
    expect(chat).not.toContain('Studio ComfyUI');
    expect(chat).not.toContain('Forge');
    const image = within(screen.getByLabelText('Image connection')).getAllByRole('option').map((o) => o.textContent);
    expect(image).toEqual(['None', 'Studio ComfyUI', 'Forge']);
    const video = within(screen.getByLabelText('Video connection')).getAllByRole('option').map((o) => o.textContent);
    expect(video).toEqual(['None', 'Studio ComfyUI']);
  });

  it("reveals the chosen connection's models, and saves media with confirmPrompts on", async () => {
    arrange();
    mockedCreate.mockResolvedValue(makeProfile());
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await openNew(user);
    expect(screen.getByRole('checkbox', { name: 'Show me the prompt before generating' })).toBeChecked();
    await user.selectOptions(screen.getByLabelText('Image connection'), 'a1');
    expect(await screen.findByRole('option', { name: 'SDXL base' })).toBeInTheDocument();
    expect(mockedMediaModels).toHaveBeenCalledWith('a1', 'image');
    await waitFor(() => expect(screen.getByLabelText('Image model')).toHaveValue('sdxl-base'));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ toolPolicy: expect.objectContaining({ media: { image: { connectionId: 'a1', model: 'sdxl-base' }, confirmPrompts: true } }) })
      )
    );
  });

  it('calls a ComfyUI choice a workflow, takes a video workflow, and saves confirmPrompts false when unticked', async () => {
    arrange();
    mockedCreate.mockResolvedValue(makeProfile());
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await openNew(user);
    await user.selectOptions(screen.getByLabelText('Video connection'), 'comfy');
    await waitFor(() => expect(screen.getByLabelText('Video workflow')).toHaveValue('builtin:sdxl-txt2img'));
    await user.selectOptions(screen.getByLabelText('Video workflow'), 'w1');
    await user.click(screen.getByRole('checkbox', { name: 'Show me the prompt before generating' }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ toolPolicy: expect.objectContaining({ media: { video: { connectionId: 'comfy', model: 'w1' }, confirmPrompts: false } }) })
      )
    );
  });

  it('shows the note when ComfyUI could not list its model files', async () => {
    arrange();
    mockedMediaModels.mockResolvedValue({ models: [{ id: 'w1', label: 'My flow' }], checkpoints: [], checkpointsError: 'ComfyUI did not answer.' });
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.selectOptions(screen.getByLabelText('Image connection'), 'comfy');
    expect(await screen.findByText('ComfyUI did not answer.')).toBeInTheDocument();
  });

  it('clearing the image connection removes media.image', async () => {
    arrange();
    useOtherBenchStore.getState().setProfiles([
      makeProfile({ toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', media: { image: { connectionId: 'a1', model: 'sdxl-base' }, confirmPrompts: true } } }),
    ]);
    mockedPatch.mockResolvedValue(makeProfile());
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    await waitFor(() => expect(screen.getByLabelText('Image model')).toHaveValue('sdxl-base'));
    await user.selectOptions(screen.getByLabelText('Image connection'), '');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
    const sent = mockedPatch.mock.calls[0]?.[1]?.toolPolicy?.media;
    expect(sent).toEqual({ confirmPrompts: true });
    expect(sent).not.toHaveProperty('image');
  });

  it('leaves a profile that never used generation without a media policy', async () => {
    arrange();
    mockedCreate.mockResolvedValue(makeProfile());
    const user = userEvent.setup();
    render(<ProfilesPanel />);
    await openNew(user);
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalled());
    expect(mockedCreate.mock.calls[0]?.[0].toolPolicy).not.toHaveProperty('media');
  });
});
