import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@grunt/core/ports/store.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';
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

  it('editing env vars replaces the whole set, dropping blank-value rows', async () => {
    mockedList.mockResolvedValue([makeHealth()]);
    mockedGet.mockResolvedValue(makeServer({ envRefs: { API_KEY: 'ref', UNCHANGED_BUT_BLANK: 'ref2' } }));
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
    // Leave the second row's value blank -- it must be dropped, not sent as "".
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    expect(mockedPatch.mock.calls[0]?.[1]).toMatchObject({ env: { API_KEY: 'new-secret-value' } });
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
