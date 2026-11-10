import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, ModelInfo } from '@otherbench/core/types/config.js';
import { useOtherBenchStore } from '../../state/store.js';
import { ModelsPanel } from './ModelsPanel.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      models: { list: vi.fn(), get: vi.fn(), patch: vi.fn() },
    },
  };
});

import { api } from '../../state/api.js';

const mockedPatch = vi.mocked(api.models.patch);

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

type User = ReturnType<typeof userEvent.setup>;

/** Opens a model's edit form by clicking its row. */
async function openRow(user: User, name: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
}

/** The model rows' test ids, top to bottom. */
function rowOrder(): string[] {
  return screen.getAllByTestId(/^model-row-/).map((r) => r.dataset['testid']!.replace('model-row-', ''));
}

function reset(): void {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  mockedPatch.mockReset();
}

describe('ModelsPanel', () => {
  beforeEach(reset);
  afterEach(cleanup);

  it('capability toggles persist via api.models.patch', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedPatch.mockResolvedValue(makeModel({ supportsTools: true }));
    const user = userEvent.setup();

    render(<ModelsPanel />);
    await openRow(user, 'llama3.2');
    await user.click(screen.getByLabelText('llama3.2 supports tools'));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(mockedPatch).toHaveBeenCalledWith(
        'model-1',
        expect.objectContaining({ supportsTools: true, supportsVision: false, supportsReasoning: false })
      )
    );
    // The saved response replaces the row's state -- the checkbox reflects it.
    expect(await screen.findByLabelText('llama3.2 supports tools')).toBeChecked();
  });

  it('a blank price saves as null (unknown), not zero', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel({ priceInPer1m: 3 })]);
    mockedPatch.mockResolvedValue(makeModel({ priceInPer1m: null }));
    const user = userEvent.setup();

    render(<ModelsPanel />);
    await openRow(user, 'llama3.2');
    const priceIn = screen.getByLabelText('llama3.2 price in per 1M tokens');
    expect(priceIn).toHaveValue('3');
    await user.clear(priceIn);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('model-1', expect.objectContaining({ priceInPer1m: null })));
  });

  it('zero is sent as a real price (genuinely free), not treated as blank', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    mockedPatch.mockResolvedValue(makeModel({ priceInPer1m: 0 }));
    const user = userEvent.setup();

    render(<ModelsPanel />);
    await openRow(user, 'llama3.2');
    const priceIn = screen.getByLabelText('llama3.2 price in per 1M tokens');
    await user.type(priceIn, '0');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('model-1', expect.objectContaining({ priceInPer1m: 0 })));
  });

  it('rejects a non-numeric context window without calling the API', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel()]);
    const user = userEvent.setup();

    render(<ModelsPanel />);
    await openRow(user, 'llama3.2');
    await user.type(screen.getByLabelText('llama3.2 context window'), 'lots');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/must be numbers/i)).toBeInTheDocument();
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('filters the model list by connection', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection({ id: 'conn-1', name: 'Ollama' }), makeConnection({ id: 'conn-2', name: 'OpenAI' })]);
    useOtherBenchStore
      .getState()
      .setModels([
        makeModel({ id: 'm1', connectionId: 'conn-1', modelId: 'llama3.2' }),
        makeModel({ id: 'm2', connectionId: 'conn-2', modelId: 'gpt-4o' }),
      ]);
    const user = userEvent.setup();

    render(<ModelsPanel />);
    expect(screen.getByTestId('model-row-m1')).toBeInTheDocument();
    expect(screen.getByTestId('model-row-m2')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter by connection'), 'conn-1');

    expect(screen.getByTestId('model-row-m1')).toBeInTheDocument();
    expect(screen.queryByTestId('model-row-m2')).not.toBeInTheDocument();
  });

  it('shows one line per model with its name, id, connection and Vision/Tools, and no edit form until clicked', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection({ id: 'conn-1', name: 'Anthropic' })]);
    useOtherBenchStore.getState().setModels([makeModel({ id: 'm1', modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', supportsVision: true })]);
    const user = userEvent.setup();

    render(<ModelsPanel />);
    const row = screen.getByTestId('model-row-m1');
    expect(row).toHaveTextContent('Claude Opus 5.5');
    expect(row).toHaveTextContent('claude-opus-5-5');
    expect(row).toHaveTextContent('Anthropic');
    expect(screen.getByLabelText('Claude Opus 5.5 vision: yes')).toBeInTheDocument();
    expect(screen.getByLabelText('Claude Opus 5.5 tools: no')).toBeInTheDocument();
    expect(screen.queryByLabelText('claude-opus-5-5 display name')).not.toBeInTheDocument();

    await openRow(user, 'Claude Opus 5.5');
    expect(screen.getByLabelText('claude-opus-5-5 display name')).toHaveValue('Claude Opus 5.5');
    await openRow(user, 'Claude Opus 5.5');
    expect(screen.queryByLabelText('claude-opus-5-5 display name')).not.toBeInTheDocument();
  });

  it('opens one model at a time', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([makeModel({ id: 'm1', modelId: 'llama3.2', displayName: 'llama3.2' }), makeModel({ id: 'm2', modelId: 'qwen3', displayName: 'qwen3' })]);
    const user = userEvent.setup();

    render(<ModelsPanel />);
    await openRow(user, 'llama3.2');
    await openRow(user, 'qwen3');
    expect(screen.queryByLabelText('llama3.2 display name')).not.toBeInTheDocument();
    expect(screen.getByLabelText('qwen3 display name')).toBeInTheDocument();
  });

  it('search narrows the list by name or model id', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([
      makeModel({ id: 'm1', modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' }),
      makeModel({ id: 'm2', modelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' }),
    ]);
    const user = userEvent.setup();

    render(<ModelsPanel />);
    await user.type(screen.getByLabelText('Search models'), 'opus');
    expect(rowOrder()).toEqual(['m1']);
    await user.clear(screen.getByLabelText('Search models'));
    await user.type(screen.getByLabelText('Search models'), 'nothing-like-it');
    expect(screen.getByText(/no models match/i)).toBeInTheDocument();
  });

  it('tags the models the latest Discover added as New', () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([
      makeModel({ id: 'm1', modelId: 'claude-opus-5', displayName: 'Claude Opus 5', firstSeenAt: 100 }),
      makeModel({ id: 'm2', modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', firstSeenAt: 200 }),
    ]);

    render(<ModelsPanel />);
    expect(screen.getByTestId('model-row-m2')).toHaveTextContent('New');
    expect(screen.getByTestId('model-row-m1')).not.toHaveTextContent('New');
  });

  it('sorts by a column when its heading is clicked, and the other way on a second click', async () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().setModels([
      makeModel({ id: 'b', modelId: 'b', displayName: 'beta', priceInPer1m: 3 }),
      makeModel({ id: 'a', modelId: 'a', displayName: 'alpha', priceInPer1m: 15 }),
    ]);
    const user = userEvent.setup();

    render(<ModelsPanel />);
    expect(rowOrder()).toEqual(['a', 'b']);
    await user.click(screen.getByRole('button', { name: /^price/i }));
    expect(rowOrder()).toEqual(['b', 'a']);
    await user.click(screen.getByRole('button', { name: /^price/i }));
    expect(rowOrder()).toEqual(['a', 'b']);
  });

  it('shows an honest empty state when no models have been discovered yet', () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    render(<ModelsPanel />);
    expect(screen.getByText(/no models yet/i)).toBeInTheDocument();
  });
});
