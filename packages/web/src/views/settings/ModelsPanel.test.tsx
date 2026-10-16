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

  it('shows an honest empty state when no models have been discovered yet', () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    render(<ModelsPanel />);
    expect(screen.getByText(/no models yet/i)).toBeInTheDocument();
  });
});
