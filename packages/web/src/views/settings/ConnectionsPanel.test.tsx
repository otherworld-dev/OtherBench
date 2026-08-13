import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '@grunt/core/types/config.js';
import { useGruntStore } from '../../state/store.js';
import { ConnectionsPanel } from './ConnectionsPanel.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      connections: {
        list: vi.fn(),
        create: vi.fn(),
        get: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
        test: vi.fn(),
        discoverModels: vi.fn(),
      },
    },
  };
});

import { ApiError, api } from '../../state/api.js';

const mockedCreate = vi.mocked(api.connections.create);
const mockedPatch = vi.mocked(api.connections.patch);
const mockedDelete = vi.mocked(api.connections.delete);
const mockedTest = vi.mocked(api.connections.test);
const mockedDiscover = vi.mocked(api.connections.discoverModels);

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'My Ollama',
    kind: 'ollama',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
    ...overrides,
  };
}

function reset(): void {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  mockedCreate.mockReset();
  mockedPatch.mockReset();
  mockedDelete.mockReset();
  mockedTest.mockReset();
  mockedDiscover.mockReset();
}

describe('ConnectionsPanel', () => {
  beforeEach(reset);
  afterEach(cleanup);

  it('never populates the API key field from an existing connection, only shows whether one is set', async () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1', name: 'Has a key', secretRef: 'conn:conn-1' })]);
    const user = userEvent.setup();

    render(<ConnectionsPanel />);
    await user.click(screen.getByTestId('connection-row-conn-1'));

    expect(await screen.findByTestId('connection-form')).toBeInTheDocument();
    // The GET-derived `secretRef` never becomes a plaintext value in the form.
    expect(screen.getByLabelText('Replace API key')).toHaveValue('');
    expect(screen.getByTestId('api-key-status')).toHaveTextContent(/a key is currently set/i);
  });

  it('shows "no key set" for a connection with no secretRef, and still never pre-fills the input', async () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1', secretRef: null })]);
    const user = userEvent.setup();

    render(<ConnectionsPanel />);
    await user.click(screen.getByTestId('connection-row-conn-1'));

    expect(screen.getByTestId('api-key-status')).toHaveTextContent(/no key is currently set/i);
    expect(screen.getByLabelText('Replace API key')).toHaveValue('');
  });

  it('rejects an openai_compatible connection with no base URL client-side, without calling the API', async () => {
    const user = userEvent.setup();
    render(<ConnectionsPanel />);

    await user.click(screen.getByRole('button', { name: '+ New connection' }));
    await user.type(screen.getByLabelText('Connection name'), 'My custom endpoint');
    await user.selectOptions(screen.getByLabelText('Connection kind'), 'openai_compatible');
    // Base URL deliberately left blank.
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/base url is required/i)).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('accepts an openai_compatible connection once a base URL is supplied, and creates it', async () => {
    mockedCreate.mockResolvedValue(makeConnection({ id: 'new-conn', name: 'Custom', kind: 'openai_compatible', baseUrl: 'https://api.example.com' }));
    const user = userEvent.setup();
    render(<ConnectionsPanel />);

    await user.click(screen.getByRole('button', { name: '+ New connection' }));
    await user.type(screen.getByLabelText('Connection name'), 'Custom');
    await user.selectOptions(screen.getByLabelText('Connection kind'), 'openai_compatible');
    await user.type(screen.getByLabelText('Base URL'), 'https://api.example.com');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({
        name: 'Custom',
        kind: 'openai_compatible',
        baseUrl: 'https://api.example.com',
        extraHeaders: {},
      })
    );
    // Saving switches straight into edit mode for the new connection (Test/Discover need an id).
    expect(await screen.findByRole('button', { name: /^test$/i })).toBeInTheDocument();
  });

  it('a failed Test renders its message instead of throwing', async () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1' })]);
    mockedTest.mockResolvedValue({ ok: false, message: 'Connection refused', latencyMs: 4 });
    const user = userEvent.setup();

    render(<ConnectionsPanel />);
    await user.click(screen.getByTestId('connection-row-conn-1'));
    await user.click(screen.getByRole('button', { name: /^test$/i }));

    expect(await screen.findByTestId('test-result')).toHaveTextContent('Connection refused');
  });

  it('a Test call that rejects also renders a message instead of throwing/crashing', async () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1' })]);
    mockedTest.mockRejectedValue(new ApiError(502, 'Bad gateway from provider'));
    const user = userEvent.setup();

    render(<ConnectionsPanel />);
    await user.click(screen.getByTestId('connection-row-conn-1'));
    await user.click(screen.getByRole('button', { name: /^test$/i }));

    expect(await screen.findByTestId('test-result')).toHaveTextContent('Bad gateway from provider');
  });

  it('Discover models saves results into the shared models store', async () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1' })]);
    mockedDiscover.mockResolvedValue([
      {
        id: 'm1',
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
      },
    ]);
    const user = userEvent.setup();

    render(<ConnectionsPanel />);
    await user.click(screen.getByTestId('connection-row-conn-1'));
    await user.click(screen.getByRole('button', { name: /discover models/i }));

    expect(await screen.findByTestId('discover-result')).toHaveTextContent('Discovered 1 model');
    expect(useGruntStore.getState().models).toHaveLength(1);
    expect(useGruntStore.getState().models[0]?.modelId).toBe('llama3.2');
  });

  it('replacing the API key on an existing connection sends the new value; leaving it blank omits it entirely', async () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1', secretRef: 'conn:conn-1' })]);
    mockedPatch.mockResolvedValue(makeConnection({ id: 'conn-1', secretRef: 'conn:conn-1' }));
    const user = userEvent.setup();

    render(<ConnectionsPanel />);
    await user.click(screen.getByTestId('connection-row-conn-1'));
    // Save without touching anything: apiKey must be OMITTED, not sent as ''.
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    expect(mockedPatch.mock.calls[0]?.[1]).not.toHaveProperty('apiKey');

    await user.type(screen.getByLabelText('Replace API key'), 'sk-new-secret');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(2));
    expect(mockedPatch.mock.calls[1]?.[1]).toMatchObject({ apiKey: 'sk-new-secret' });
  });

  it('clearing the API key sends apiKey: null', async () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1', secretRef: 'conn:conn-1' })]);
    mockedPatch.mockResolvedValue(makeConnection({ id: 'conn-1', secretRef: null }));
    const user = userEvent.setup();

    render(<ConnectionsPanel />);
    await user.click(screen.getByTestId('connection-row-conn-1'));
    await user.click(screen.getByRole('checkbox', { name: /clear the stored api key/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('conn-1', expect.objectContaining({ apiKey: null })));
  });

  it('deleting a connection asks for confirmation and, once confirmed, removes it from the list', async () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1', name: 'Doomed' })]);
    mockedDelete.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<ConnectionsPanel />);
    await user.click(screen.getByTestId('connection-row-conn-1'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('conn-1'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/cascades|deletes every model and profile/i);
    expect(screen.queryByTestId('connections-list')).not.toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it('does not delete when the confirmation is declined', async () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1' })]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();

    render(<ConnectionsPanel />);
    await user.click(screen.getByTestId('connection-row-conn-1'));
    await user.click(within(screen.getByTestId('connection-form')).getByRole('button', { name: /^delete$/i }));

    expect(mockedDelete).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
