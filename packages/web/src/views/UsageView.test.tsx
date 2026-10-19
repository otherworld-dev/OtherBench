import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageRollup } from '@otherbench/core/domain/usage-rollup.js';
import type { ModelInfo } from '@otherbench/core/types/config.js';
import { UsageView } from './UsageView.js';

vi.mock('../state/api.js', () => ({
  api: {
    usage: { get: vi.fn() },
    models: { list: vi.fn(), patch: vi.fn() },
  },
}));

import { api } from '../state/api.js';

const mockedUsageGet = vi.mocked(api.usage.get);
const mockedModelsList = vi.mocked(api.models.list);
const mockedModelsPatch = vi.mocked(api.models.patch);

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

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'model-1',
    connectionId: 'conn-1',
    modelId: 'gpt-x',
    displayName: 'GPT X',
    source: 'discovered',
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    contextWindow: null,
    maxOutput: null,
    priceInPer1m: 3,
    priceOutPer1m: 15,
    priceCachedPer1m: null,
    currency: 'USD',
    ...overrides,
  };
}

function reset(): void {
  mockedUsageGet.mockReset();
  mockedModelsList.mockReset();
  mockedModelsPatch.mockReset();
}

describe('UsageView', () => {
  afterEach(cleanup);

  it('renders the global total, per-profile, per-chat and per-day breakdowns', async () => {
    reset();
    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 12.5,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'gpt-x', currency: 'USD', measuredCost: 12.5, tokensIn: 1000, tokensOut: 500, tokensCached: 0, tokensCacheWrite: 0, tokensReasoning: 0, completeCount: 3, cancelledCount: 0, unmeasuredErrorCount: 0, subagentCount: 0, backgroundCount: 0 }],
        chats: [{ chatId: 'c1', chatTitle: 'Ocean facts', measuredCost: 12.5, cancelledCount: 0, unmeasuredErrorCount: 0 }],
        buckets: [{ date: '2026-08-10', cost: 12.5 }],
      })
    );
    mockedModelsList.mockResolvedValue([]);

    render(<UsageView onClose={vi.fn()} />);

    expect(await screen.findByTestId('usage-total')).toHaveTextContent('$12.50');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Ocean facts')).toBeInTheDocument();
    expect(screen.getByText('2026-08-10')).toBeInTheDocument();
  });

  it("shows a profile's cache reads and writes and its title and memory calls", async () => {
    reset();
    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 1,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'sonnet', currency: 'USD', measuredCost: 1, tokensIn: 50_000, tokensOut: 500, tokensCached: 40_000, tokensCacheWrite: 9_000, tokensReasoning: 0, completeCount: 3, cancelledCount: 0, unmeasuredErrorCount: 0, subagentCount: 0, backgroundCount: 2 }],
      })
    );
    mockedModelsList.mockResolvedValue([]);

    render(<UsageView onClose={vi.fn()} />);

    await screen.findByTestId('usage-total');
    expect(screen.getByText('40,000 read from cache, 9,000 written')).toBeInTheDocument();
    expect(screen.getByText('2 title or memory calls')).toBeInTheDocument();
  });

  it('surfaces cancelled/unmeasured calls as a callout, not folded into the total', async () => {
    reset();
    mockedUsageGet.mockResolvedValue(makeRollup({ totalMeasuredCost: 5, totalCancelledCount: 2, totalUnmeasuredErrorCount: 1 }));
    mockedModelsList.mockResolvedValue([]);

    render(<UsageView onClose={vi.fn()} />);

    await screen.findByTestId('usage-total');
    expect(screen.getByText(/2 cancelled calls/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed call/)).toBeInTheDocument();
  });

  it('switches to the Pricing tab and shows editable fields pre-filled from the model', async () => {
    reset();
    mockedUsageGet.mockResolvedValue(makeRollup());
    mockedModelsList.mockResolvedValue([makeModel()]);
    const user = userEvent.setup();

    render(<UsageView onClose={vi.fn()} />);
    await user.click(screen.getByRole('tab', { name: 'Pricing' }));

    expect(await screen.findByTestId('pricing-row-model-1')).toBeInTheDocument();
    expect(screen.getByLabelText('GPT X price in per 1M tokens')).toHaveValue('3');
    expect(screen.getByLabelText('GPT X price out per 1M tokens')).toHaveValue('15');
    expect(screen.getByLabelText('GPT X currency')).toHaveValue('USD');
  });

  it('Save sends the edited prices to PATCH /models/:id and reflects the response', async () => {
    reset();
    mockedUsageGet.mockResolvedValue(makeRollup());
    mockedModelsList.mockResolvedValue([makeModel()]);
    mockedModelsPatch.mockResolvedValue(makeModel({ priceInPer1m: 4 }));
    const user = userEvent.setup();

    render(<UsageView onClose={vi.fn()} />);
    await user.click(screen.getByRole('tab', { name: 'Pricing' }));
    await screen.findByTestId('pricing-row-model-1');

    const inField = screen.getByLabelText('GPT X price in per 1M tokens');
    await user.clear(inField);
    await user.type(inField, '4');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(mockedModelsPatch).toHaveBeenCalledWith('model-1', { priceInPer1m: 4, priceOutPer1m: 15, priceCachedPer1m: null, currency: 'USD' })
    );
  });

  it('rejects a non-numeric price without calling the API', async () => {
    reset();
    mockedUsageGet.mockResolvedValue(makeRollup());
    mockedModelsList.mockResolvedValue([makeModel()]);
    const user = userEvent.setup();

    render(<UsageView onClose={vi.fn()} />);
    await user.click(screen.getByRole('tab', { name: 'Pricing' }));
    await screen.findByTestId('pricing-row-model-1');

    const inField = screen.getByLabelText('GPT X price in per 1M tokens');
    await user.clear(inField);
    await user.type(inField, 'not-a-number');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/must be numbers/i)).toBeInTheDocument();
    expect(mockedModelsPatch).not.toHaveBeenCalled();
  });

  it('calls onClose when the close button is clicked', async () => {
    reset();
    mockedUsageGet.mockResolvedValue(makeRollup());
    mockedModelsList.mockResolvedValue([]);
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<UsageView onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /close usage view/i }));

    expect(onClose).toHaveBeenCalled();
  });

  it('shows an honest error state when the rollup fetch fails', async () => {
    reset();
    mockedUsageGet.mockRejectedValue(new Error('down'));
    mockedModelsList.mockResolvedValue([]);

    render(<UsageView onClose={vi.fn()} />);

    expect(await screen.findByText(/couldn.t load usage data/i)).toBeInTheDocument();
  });
});
