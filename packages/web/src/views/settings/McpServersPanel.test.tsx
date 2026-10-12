import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';
import { useGruntStore } from '../../state/store.js';
import { McpServersPanel } from './McpServersPanel.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      mcpServers: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
        refresh: vi.fn(),
        claudeDesktop: vi.fn(),
        importClaudeDesktop: vi.fn(),
      },
    },
  };
});

import { api } from '../../state/api.js';

const mockedList = vi.mocked(api.mcpServers.list);
const mockedGet = vi.mocked(api.mcpServers.get);
const mockedCreate = vi.mocked(api.mcpServers.create);
const mockedPatch = vi.mocked(api.mcpServers.patch);
const mockedDelete = vi.mocked(api.mcpServers.delete);
const mockedRefresh = vi.mocked(api.mcpServers.refresh);
const mockedDesktop = vi.mocked(api.mcpServers.claudeDesktop);
const mockedImport = vi.mocked(api.mcpServers.importClaudeDesktop);

function makeHealth(overrides: Partial<McpServerHealth> = {}): McpServerHealth {
  return {
    id: 'srv-1',
    name: 'Filesystem MCP',
    transport: 'stdio',
    enabled: true,
    status: 'ok',
    lastError: null,
    toolCount: 2,
    ...overrides,
  };
}

function makeServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'srv-1',
    name: 'Filesystem MCP',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@some/mcp-server'],
    envRefs: {},
    url: null,
    headerRefs: {},
    enabled: true,
    status: 'ok',
    toolsCache: null,
    oauth: null,
    ...overrides,
  };
}

function reset(): void {
  mockedList.mockReset().mockResolvedValue([]);
  mockedGet.mockReset();
  mockedCreate.mockReset();
  mockedPatch.mockReset();
  mockedDelete.mockReset();
  mockedRefresh.mockReset();
}

describe('McpServersPanel', () => {
  beforeEach(reset);
  afterEach(cleanup);

  it('lists servers with their live health (status, transport, tool count)', async () => {
    mockedList.mockResolvedValue([
      makeHealth({ id: 'srv-1', name: 'Filesystem MCP', status: 'ok', toolCount: 3 }),
      makeHealth({ id: 'srv-2', name: 'Broken Server', transport: 'http', status: 'error', lastError: 'connection refused', enabled: true, toolCount: 0 }),
    ]);

    render(<McpServersPanel />);

    const list = await screen.findByTestId('mcp-servers-list');
    expect(within(list).getByText('Filesystem MCP')).toBeInTheDocument();
    expect(within(list).getByText(/3 tools/)).toBeInTheDocument();
    expect(within(list).getByText(/connection refused/)).toBeInTheDocument();
  });

  it('shows an honest empty state when no servers are configured', async () => {
    render(<McpServersPanel />);
    expect(await screen.findByText(/no mcp servers yet/i)).toBeInTheDocument();
  });

  it('creates a new stdio server with command and arguments', async () => {
    mockedCreate.mockResolvedValue(makeServer({ id: 'new-srv' }));
    const user = userEvent.setup();
    render(<McpServersPanel />);

    await user.click(screen.getByRole('button', { name: '+ New MCP server' }));
    await user.type(screen.getByLabelText('MCP server name'), 'My Local Server');
    await user.type(screen.getByLabelText('Command'), 'npx');
    await user.click(screen.getByRole('button', { name: /\+ add argument/i }));
    await user.type(screen.getByLabelText('Argument'), '-y @some/mcp-server');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Local Server',
          transport: 'stdio',
          command: 'npx',
          args: ['-y @some/mcp-server'],
          url: null,
        })
      )
    );
  });

  it('creates a new http server with a URL', async () => {
    mockedCreate.mockResolvedValue(makeServer({ id: 'new-srv', transport: 'http', command: null, url: 'https://example.com/mcp' }));
    const user = userEvent.setup();
    render(<McpServersPanel />);

    await user.click(screen.getByRole('button', { name: '+ New MCP server' }));
    await user.type(screen.getByLabelText('MCP server name'), 'Remote server');
    await user.selectOptions(screen.getByLabelText('Transport'), 'http');
    await user.type(screen.getByLabelText('URL'), 'https://example.com/mcp');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Remote server', transport: 'http', url: 'https://example.com/mcp', command: null }))
    );
  });

  it('rejects a stdio server with no command, and an http server with no URL, without calling the API', async () => {
    const user = userEvent.setup();
    render(<McpServersPanel />);

    await user.click(screen.getByRole('button', { name: '+ New MCP server' }));
    await user.type(screen.getByLabelText('MCP server name'), 'No command');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/a command is required/i)).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText('Transport'), 'http');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/a url is required/i)).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('selecting an existing server fetches its full config and pre-fills command/args/url, never env/header VALUES', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer({ envRefs: { API_KEY: 'mcp:srv-1:env:API_KEY' } }));
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));

    expect(await screen.findByTestId('mcp-server-form')).toBeInTheDocument();
    expect(screen.getByLabelText('MCP server name')).toHaveValue('Filesystem MCP');
    expect(screen.getByLabelText('Command')).toHaveValue('npx');
    expect(screen.getAllByLabelText('Argument').map((el) => (el as HTMLInputElement).value)).toEqual(['-y', '@some/mcp-server']);
    // The env var NAME is safe to show; its value never is, and no value input exists yet.
    expect(screen.getByTestId('mcp-env-status')).toHaveTextContent('API_KEY');
    expect(screen.queryByLabelText('Env var value')).not.toBeInTheDocument();
  });

  it('leaving env vars untouched on save omits "env" from the patch body entirely', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer({ envRefs: { API_KEY: 'ref' } }));
    mockedPatch.mockResolvedValue(makeServer({ envRefs: { API_KEY: 'ref' } }));
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    expect(mockedPatch.mock.calls[0]?.[1]).not.toHaveProperty('env');
  });

  it('editing ONE env var sends a real replacement for it, and an explicit KEEP (not a drop) for a pre-seeded row left blank', async () => {
    // Regression coverage for the "opening the editor and saving destroys
    // every secret" bug: a pre-seeded row's blank value must never be
    // dropped from the patch body -- dropping it is indistinguishable, to
    // the server, from the user having deleted that row, and
    // `PATCH /mcp-servers/:id` deletes any name absent from the map.
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer({ envRefs: { API_KEY: 'ref', KEPT_BECAUSE_UNTOUCHED: 'ref2' } }));
    mockedPatch.mockResolvedValue(makeServer());
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(screen.getByRole('button', { name: /edit environment variables/i }));

    // Two rows are pre-seeded with the existing NAMES, values blank.
    const envValueInputs = screen.getAllByLabelText('Env var value');
    expect(envValueInputs).toHaveLength(2);
    await user.type(envValueInputs[0]!, 'new-secret-value');
    // Leave the second row's value blank -- untouched, so it must be KEPT.
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    expect(mockedPatch.mock.calls[0]?.[1]).toMatchObject({ env: { API_KEY: 'new-secret-value', KEPT_BECAUSE_UNTOUCHED: null } });
  });

  it('opening the env var editor and saving with NOTHING changed sends an explicit keep for every existing var, never an empty/dropping patch (the critical destroy-on-noop-save bug)', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer({ envRefs: { GITHUB_TOKEN: 'ref-1', KEEP: 'ref-2' } }));
    mockedPatch.mockResolvedValue(makeServer({ envRefs: { GITHUB_TOKEN: 'ref-1', KEEP: 'ref-2' } }));
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(screen.getByRole('button', { name: /edit environment variables/i }));
    // No typing at all -- click Save immediately.
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    const body = mockedPatch.mock.calls[0]?.[1] as { env?: Record<string, unknown> };
    expect(body.env).toEqual({ GITHUB_TOKEN: null, KEEP: null });
  });

  it('a brand new, never-filled-in env row is dropped silently (not a keep -- there is nothing to keep)', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer({ envRefs: { API_KEY: 'ref' } }));
    mockedPatch.mockResolvedValue(makeServer());
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(screen.getByRole('button', { name: /edit environment variables/i }));
    await user.click(screen.getByRole('button', { name: /\+ add env var name/i }));
    await user.type(screen.getAllByLabelText('Env var name')[1]!, 'NEVER_FILLED_IN');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    const body = mockedPatch.mock.calls[0]?.[1] as { env?: Record<string, unknown> };
    expect(body.env).toEqual({ API_KEY: null });
  });

  it('refuses to save when a pre-seeded env row is renamed but its value is left blank, instead of silently losing the old secret', async () => {
    // Reproduces the real bug: envRefs went from {GITHUB_TOKEN, KEEP} to
    // {KEEP} after renaming GITHUB_TOKEN's row without retyping its value --
    // the old name is dropped from the patch (deleted server-side) and the
    // new name is dropped too (blank value, not a recognised keepable
    // name), so the secret vanishes under both names. Saving must now be
    // refused, not silently accepted.
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer({ envRefs: { GITHUB_TOKEN: 'ref-1', KEEP: 'ref-2' } }));
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(screen.getByRole('button', { name: /edit environment variables/i }));

    const nameInputs = screen.getAllByLabelText('Env var name');
    expect(nameInputs.map((el) => (el as HTMLInputElement).value)).toEqual(['GITHUB_TOKEN', 'KEEP']);
    await user.clear(nameInputs[0]!);
    await user.type(nameInputs[0]!, 'RENAMED_TOKEN');
    // Value left blank -- this is the destructive case.
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/renamed to "RENAMED_TOKEN".*still blank/i)).toBeInTheDocument();
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('a rename WITH a freshly typed value saves normally -- replaces the old name with the new one', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer({ envRefs: { GITHUB_TOKEN: 'ref-1', KEEP: 'ref-2' } }));
    mockedPatch.mockResolvedValue(makeServer());
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(screen.getByRole('button', { name: /edit environment variables/i }));

    const nameInputs = screen.getAllByLabelText('Env var name');
    await user.clear(nameInputs[0]!);
    await user.type(nameInputs[0]!, 'RENAMED_TOKEN');
    const valueInputs = screen.getAllByLabelText('Env var value');
    await user.type(valueInputs[0]!, 'freshly-typed-value');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    const body = mockedPatch.mock.calls[0]?.[1] as { env?: Record<string, unknown> };
    // GITHUB_TOKEN is absent (deleted), RENAMED_TOKEN carries the new value, KEEP is kept.
    expect(body.env).toEqual({ RENAMED_TOKEN: 'freshly-typed-value', KEEP: null });
  });

  it('clearing env vars sends an empty object', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer({ envRefs: { API_KEY: 'ref' } }));
    mockedPatch.mockResolvedValue(makeServer({ envRefs: {} }));
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(screen.getByRole('checkbox', { name: /clear all environment variables/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('srv-1', expect.objectContaining({ env: {} })));
  });

  // --- headers (http transport) -- the identical bug/fix as env vars above ---

  it('opening the headers editor and saving with NOTHING changed sends an explicit keep for every existing header, never an empty/dropping patch', async () => {
    mockedList.mockResolvedValue([makeHealth({ transport: 'http' })]);
    mockedGet.mockResolvedValue(
      makeServer({ transport: 'http', command: null, args: [], url: 'https://example.com/mcp', headerRefs: { Authorization: 'ref-1', 'X-Extra': 'ref-2' } })
    );
    mockedPatch.mockResolvedValue(makeServer({ transport: 'http' }));
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(screen.getByRole('button', { name: /edit headers/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    const body = mockedPatch.mock.calls[0]?.[1] as { headers?: Record<string, unknown> };
    expect(body.headers).toEqual({ Authorization: null, 'X-Extra': null });
  });

  it('editing ONE header sends a real replacement for it, and an explicit KEEP for a pre-seeded row left blank', async () => {
    mockedList.mockResolvedValue([makeHealth({ transport: 'http' })]);
    mockedGet.mockResolvedValue(
      makeServer({ transport: 'http', command: null, args: [], url: 'https://example.com/mcp', headerRefs: { Authorization: 'ref-1', 'X-Extra': 'ref-2' } })
    );
    mockedPatch.mockResolvedValue(makeServer({ transport: 'http' }));
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(screen.getByRole('button', { name: /edit headers/i }));

    const headerValueInputs = screen.getAllByLabelText('Header value');
    expect(headerValueInputs).toHaveLength(2);
    await user.type(headerValueInputs[0]!, 'Bearer new-token');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    expect(mockedPatch.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: 'Bearer new-token', 'X-Extra': null } });
  });

  it('clearing headers sends an empty object', async () => {
    mockedList.mockResolvedValue([makeHealth({ transport: 'http' })]);
    mockedGet.mockResolvedValue(makeServer({ transport: 'http', command: null, args: [], url: 'https://example.com/mcp', headerRefs: { Authorization: 'ref' } }));
    mockedPatch.mockResolvedValue(makeServer({ transport: 'http', headerRefs: {} }));
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(screen.getByRole('checkbox', { name: /clear all headers/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('srv-1', expect.objectContaining({ headers: {} })));
  });

  it('toggling enable/disable from the list calls patch and never renders a secret', async () => {
    mockedList.mockResolvedValue([makeHealth({ enabled: true })]);
    mockedPatch.mockResolvedValue(makeServer({ enabled: false }));
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByRole('button', { name: 'Disable Filesystem MCP' }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('srv-1', { enabled: false }));
  });

  it('refresh from the list calls the refresh endpoint', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedRefresh.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByRole('button', { name: 'Refresh Filesystem MCP' }));

    await waitFor(() => expect(mockedRefresh).toHaveBeenCalledWith('srv-1'));
  });

  it('renders the tools a connected server exposes, parsed from toolsCache', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(
      makeServer({ toolsCache: [{ name: 'read_file', description: 'Reads a file' }, { name: 'write_file', description: 'Writes a file' }] })
    );
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));

    const list = await screen.findByTestId('mcp-tools-list');
    expect(within(list).getByText('read_file')).toBeInTheDocument();
    expect(within(list).getByText('write_file')).toBeInTheDocument();
  });

  it('shows "no tools listed yet" when toolsCache is null', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer({ toolsCache: null }));
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));

    expect(await screen.findByText(/no tools listed yet/i)).toBeInTheDocument();
  });

  it('deleting a server asks for confirmation and removes it', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer());
    mockedDelete.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<McpServersPanel />);
    await user.click(await screen.findByTestId('mcp-row-srv-1'));
    await screen.findByTestId('mcp-server-form');
    await user.click(within(screen.getByTestId('mcp-server-form')).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('srv-1'));
    confirmSpy.mockRestore();
  });
});
describe('McpServersPanel import from Claude Desktop', () => {
  beforeEach(() => useGruntStore.setState({ profiles: [] }));
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function makeProfile(overrides: Partial<Profile> = {}): Profile {
    return {
      id: 'p1',
      name: 'Default',
      description: null,
      colour: null,
      connectionId: 'c1',
      modelId: 'm',
      systemPrompt: null,
      params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' },
      isDefault: false,
      archivedAt: null,
      ...overrides,
    };
  }

  it("lists Claude Desktop's servers, greys out ones Grunt has or can't use with why, and imports the chosen ones", async () => {
    mockedList.mockResolvedValue([]);
    mockedDesktop.mockResolvedValue({
      path: 'C:\\Users\\a\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
      found: true,
      servers: [
        { name: 'nextcloud', transport: 'stdio', command: 'python.exe', args: ['nc_mcp.py'], url: null, envNames: ['NC_CONFIG'], headerNames: [], exists: false, supported: true },
        { name: 'blender', transport: 'stdio', command: 'uvx', args: ['blender-mcp'], url: null, envNames: [], headerNames: [], exists: true, supported: true },
        { name: 'legacy', transport: null, command: null, args: [], url: null, envNames: [], headerNames: [], exists: false, supported: false, reason: "SSE servers aren't supported." },
      ],
    });
    mockedImport.mockResolvedValue({ imported: ['nextcloud'], skipped: [], profiles: [] });
    const user = userEvent.setup();
    render(<McpServersPanel />);

    await user.click(screen.getByRole('button', { name: 'Import from Claude Desktop…' }));
    const nextcloud = await screen.findByRole('checkbox', { name: /nextcloud/ });
    expect(screen.getByText(/NC_CONFIG/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /blender/ })).toBeDisabled();
    expect(screen.getByText(/Grunt already has it/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /legacy/ })).toBeDisabled();
    expect(screen.getByText("SSE servers aren't supported.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

    await user.click(nextcloud);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(mockedImport).toHaveBeenCalledWith(['nextcloud'], []);
    const report = await screen.findByRole('status');
    expect(report).toHaveTextContent('Imported nextcloud.');
    expect(report).toHaveTextContent('Turn them on for a profile under its MCP servers, or in the Inspector, to use them in chats.');
  });

  it('turns the imported servers on for the profiles ticked under "Turn on for", and says so', async () => {
    useGruntStore.setState({
      profiles: [makeProfile({ id: 'p1', name: 'Claude Opus 5.5' }), makeProfile({ id: 'p2', name: 'Haiku' }), makeProfile({ id: 'p3', name: 'Old', archivedAt: 5 })],
    });
    mockedList.mockResolvedValue([]);
    mockedDesktop.mockResolvedValue({
      path: 'C:\\x\\claude_desktop_config.json',
      found: true,
      servers: [{ name: 'nextcloud', transport: 'stdio', command: 'python.exe', args: [], url: null, envNames: [], headerNames: [], exists: false, supported: true }],
    });
    const updated = makeProfile({ id: 'p1', name: 'Claude Opus 5.5', toolPolicy: { fs: 'off', shell: false, mcpServerIds: ['new-id'], approvalMode: 'ask_on_mutate' } });
    mockedImport.mockResolvedValue({ imported: ['nextcloud'], skipped: [], profiles: [updated] });
    const user = userEvent.setup();
    render(<McpServersPanel />);

    await user.click(screen.getByRole('button', { name: 'Import from Claude Desktop…' }));
    const turnOnFor = await screen.findByRole('group', { name: 'Turn on for' });
    const boxes = within(turnOnFor).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual(['Claude Opus 5.5', 'Haiku']);
    expect(boxes.every((b) => !(b as HTMLInputElement).checked)).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: 'nextcloud' }));
    await user.click(within(turnOnFor).getByRole('checkbox', { name: 'Claude Opus 5.5' }));
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(mockedImport).toHaveBeenCalledWith(['nextcloud'], ['p1']);
    const report = await screen.findByRole('status');
    expect(report).toHaveTextContent('Imported nextcloud. Turned on for Claude Opus 5.5.');
    expect(report).not.toHaveTextContent('Turn them on');
    expect(useGruntStore.getState().profiles.find((p) => p.id === 'p1')!.toolPolicy.mcpServerIds).toEqual(['new-id']);
  });

  it("says when Claude Desktop's config wasn't found", async () => {
    mockedList.mockResolvedValue([]);
    mockedDesktop.mockResolvedValue({ path: 'C:\\x\\claude_desktop_config.json', found: false, servers: [] });
    const user = userEvent.setup();
    render(<McpServersPanel />);
    await user.click(screen.getByRole('button', { name: 'Import from Claude Desktop…' }));
    expect(await screen.findByText("Claude Desktop's config wasn't found at C:\\x\\claude_desktop_config.json.")).toBeInTheDocument();
  });
});
