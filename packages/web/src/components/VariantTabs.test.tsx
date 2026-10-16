import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import type { ModelInfo } from '@otherbench/core/types/config.js';
import type { MessageExtras } from '../state/reducer.js';
import { useOtherBenchStore } from '../state/store.js';
import { VariantTabs } from './VariantTabs.js';

function variant(id: string, overrides: Partial<CanonMessage> = {}): CanonMessage {
  return {
    id,
    chatId: 'chat-1',
    parentId: 'user-1',
    role: 'assistant',
    parts: [{ type: 'text', text: `reply from ${id}` }],
    status: 'complete',
    error: null,
    producedBy: { profileId: id, profileName: `Profile ${id}`, connectionId: 'conn-1', modelId: 'model-x' },
    createdAt: Date.now() - 2000,
    ...overrides,
  };
}

const model: ModelInfo = {
  id: 'model-row-1',
  connectionId: 'conn-1',
  modelId: 'model-x',
  displayName: 'Model X',
  source: 'manual',
  supportsVision: false,
  supportsTools: false,
  supportsReasoning: false,
  contextWindow: null,
  maxOutput: null,
  priceInPer1m: 3,
  priceOutPer1m: 15,
  priceCachedPer1m: null,
  currency: 'USD',
};

function extrasFor(usage: Partial<Record<string, MessageExtras>>): Record<string, MessageExtras> {
  return usage as Record<string, MessageExtras>;
}

describe('VariantTabs', () => {
  beforeEach(() => useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true));
  afterEach(cleanup);

  it('renders one tab per variant', () => {
    const variants = [variant('a'), variant('b'), variant('c')];
    render(
      <VariantTabs variants={variants} extras={{}} models={[]} keptId={null} onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );

    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByTestId('variant-tab-a')).toHaveTextContent('Profile a');
    expect(screen.getByTestId('variant-tab-b')).toHaveTextContent('Profile b');
    expect(screen.getByTestId('variant-tab-c')).toHaveTextContent('Profile c');
  });

  it('a failed variant shows an error status dot and a Retry action on its own tab, leaving the others untouched', async () => {
    const variants = [variant('ok-1', { status: 'complete' }), variant('fail', { status: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } }), variant('ok-2', { status: 'streaming' })];
    const user = userEvent.setup();
    render(
      <VariantTabs variants={variants} extras={{}} models={[]} keptId={null} onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );

    // The failed tab's own status dot is 'error'.
    expect(within(screen.getByTestId('variant-tab-fail')).getByTestId('status-dot')).toHaveAttribute('data-status', 'error');
    expect(within(screen.getByTestId('variant-tab-ok-1')).getByTestId('status-dot')).toHaveAttribute('data-status', 'complete');
    expect(within(screen.getByTestId('variant-tab-ok-2')).getByTestId('status-dot')).toHaveAttribute('data-status', 'streaming');

    // No Retry button is visible while a healthy tab is active.
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();

    await user.click(screen.getByTestId('variant-tab-fail'));
    const retryButton = screen.getByRole('button', { name: /retry profile fail/i });
    expect(retryButton).toBeInTheDocument();

    // Switching to the healthy tabs shows no Retry -- the failure (and its
    // remedy) is scoped to the one tab that actually failed.
    await user.click(screen.getByTestId('variant-tab-ok-1'));
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('clicking Retry on the failed tab calls onRetry with that variant only', async () => {
    const failing = variant('fail', { status: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } });
    const variants = [variant('ok'), failing];
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <VariantTabs variants={variants} extras={{}} models={[]} keptId={null} onKeep={vi.fn()} onRetry={onRetry} retryingIds={new Set()} />
    );

    await user.click(screen.getByTestId('variant-tab-fail'));
    await user.click(screen.getByRole('button', { name: /retry profile fail/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(failing);
  });

  it('offers no Retry for a variant cut off when the machine writing it went away', async () => {
    const cutOff = variant('cut', { status: 'error', error: { kind: 'peer_unreachable', message: 'Gigabyte stopped responding.', retryable: false } });
    const user = userEvent.setup();
    render(
      <VariantTabs variants={[variant('ok'), cutOff]} extras={{}} models={[]} keptId={null} onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );

    await user.click(screen.getByTestId('variant-tab-cut'));

    expect(screen.getByText('Gigabyte stopped responding.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('shows "Retrying…" and disables the button while that variant id is in retryingIds', async () => {
    const failing = variant('fail', { status: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } });
    const user = userEvent.setup();
    render(
      <VariantTabs
        variants={[failing]}
        extras={{}}
        models={[]}
        keptId={null}
        onKeep={vi.fn()}
        onRetry={vi.fn()}
        retryingIds={new Set(['fail'])}
      />
    );

    const retryButton = screen.getByRole('button', { name: /retry profile fail/i });
    expect(retryButton).toHaveTextContent('Retrying…');
    expect(retryButton).toBeDisabled();
    await user.click(retryButton); // no-op: disabled
  });

  it('"Keep this one" on the active tab calls onKeep with that variant\'s id', async () => {
    const variants = [variant('a'), variant('b')];
    const onKeep = vi.fn();
    const user = userEvent.setup();
    render(
      <VariantTabs variants={variants} extras={{}} models={[]} keptId={null} onKeep={onKeep} onRetry={vi.fn()} retryingIds={new Set()} />
    );

    await user.click(screen.getByTestId('variant-tab-b'));
    await user.click(screen.getByRole('button', { name: /keep this one/i }));

    expect(onKeep).toHaveBeenCalledWith('b');
  });

  it('marks the kept variant with a "Kept" indicator instead of a Keep button', () => {
    const variants = [variant('a'), variant('b')];
    render(
      <VariantTabs variants={variants} extras={{}} models={[]} keptId="a" onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );

    expect(screen.getByText('✓ Kept')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /keep this one/i })).not.toBeInTheDocument();
  });

  it('shows cost and token counts on the tab label from the usage extras', () => {
    const variants = [variant('a')];
    const extras = extrasFor({ a: { usage: { tokensIn: 1_000_000, tokensOut: 500_000, tokensCached: 0, tokensReasoning: 0 }, pendingApprovals: [] } });
    render(
      <VariantTabs variants={variants} extras={extras} models={[model]} keptId={null} onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );

    // 1M in @ $3/1M = $3, 500k out @ $15/1M = $7.50 -> $10.50 total.
    expect(screen.getByTestId('variant-tab-a')).toHaveTextContent('$10.50');
    expect(screen.getByTestId('variant-tab-a')).toHaveTextContent('1,500,000 tok');
  });

  it('after a reload (no stream usage), shows the recorded tokens, cost at the recorded price and measured latency (#819)', () => {
    useOtherBenchStore.setState({
      recordedUsage: {
        a: {
          tokensIn: 1_000_000, tokensOut: 0, tokensCached: 0, tokensReasoning: 0, latencyMs: 2500,
          pricingSnapshot: { priceInPer1m: 1, priceOutPer1m: 1, priceCachedPer1m: null, currency: 'USD' },
        },
      },
    });
    // The model's price today is $3/1M in; the reply ran at $1/1M and must stay priced at that.
    render(
      <VariantTabs variants={[variant('a')]} extras={{}} models={[model]} keptId={null} onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );
    const tab = screen.getByTestId('variant-tab-a');
    expect(tab).toHaveTextContent('$1.00');
    expect(tab).toHaveTextContent('1,000,000 tok');
    expect(tab).toHaveTextContent('2.5s');
  });

  it('a reply finished live keeps the price it finished at when the model price changes later', () => {
    const extras = extrasFor({ a: { usage: { tokensIn: 1_000_000, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 }, pendingApprovals: [] } });
    const props = { variants: [variant('live-a')], keptId: null, onKeep: vi.fn(), onRetry: vi.fn(), retryingIds: new Set<string>() };
    const liveExtras = { 'live-a': extras['a']! };
    const { rerender } = render(<VariantTabs {...props} extras={liveExtras} models={[model]} />);
    expect(screen.getByTestId('variant-tab-live-a')).toHaveTextContent('$3.00');
    rerender(<VariantTabs {...props} extras={liveExtras} models={[{ ...model, priceInPer1m: 9 }]} />);
    expect(screen.getByTestId('variant-tab-live-a')).toHaveTextContent('$3.00');
  });

  it('shows an unknown-pricing dash rather than a misleading $0.00 when there is no matching model', () => {
    // Its own id: a finished reply's price is frozen per message id for the page session, and real ids never repeat.
    const variants = [variant('unpriced')];
    const extras = extrasFor({ unpriced: { usage: { tokensIn: 10, tokensOut: 10, tokensCached: 0, tokensReasoning: 0 }, pendingApprovals: [] } });
    render(
      <VariantTabs variants={variants} extras={extras} models={[]} keptId={null} onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );

    expect(screen.getByTestId('variant-tab-unpriced')).toHaveTextContent('—');
  });

  it('the Split toggle swaps the single active card for a grid of every variant, using the same card renderer', async () => {
    const variants = [variant('a'), variant('b'), variant('c')];
    const user = userEvent.setup();
    render(
      <VariantTabs variants={variants} extras={{}} models={[]} keptId={null} onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );

    expect(screen.getByTestId('variant-card-a')).toBeInTheDocument();
    expect(screen.queryByTestId('variant-card-b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('compare-split')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /split view/i }));

    expect(screen.getByTestId('compare-split')).toBeInTheDocument();
    expect(screen.getByTestId('variant-card-a')).toBeInTheDocument();
    expect(screen.getByTestId('variant-card-b')).toBeInTheDocument();
    expect(screen.getByTestId('variant-card-c')).toBeInTheDocument();
  });

  it('shows a Collapse button only when onClose is provided (a reopened, already-resolved turn)', () => {
    const { rerender } = render(
      <VariantTabs variants={[variant('a')]} extras={{}} models={[]} keptId="a" onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );
    expect(screen.queryByRole('button', { name: /collapse variants/i })).not.toBeInTheDocument();

    const onClose = vi.fn();
    rerender(
      <VariantTabs variants={[variant('a')]} extras={{}} models={[]} keptId="a" onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} onClose={onClose} />
    );
    expect(screen.getByRole('button', { name: /collapse variants/i })).toBeInTheDocument();
  });

  it('a pending approval on ONE variant renders only on that variant\'s own card, and resolving it never touches a sibling (task 26 decision #2)', async () => {
    const variants = [variant('a'), variant('b')];
    const requestA = { id: 'req-a', chatId: 'chat-1', messageId: 'a', toolName: 'write_file', risk: 'mutate' as const, source: 'fs' as const, args: {}, summary: 'a' };
    const extras = extrasFor({
      a: { usage: null, pendingApprovals: [requestA] },
      b: { usage: null, pendingApprovals: [] },
    });
    const onResolveApproval = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <VariantTabs variants={variants} extras={extras} models={[]} keptId={null} onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} onResolveApproval={onResolveApproval} />
    );
    await user.click(screen.getByRole('button', { name: /split view/i }));

    // Only variant a's card shows a prompt; b's shows none.
    expect(within(screen.getByTestId('variant-card-a')).getByTestId('approval-prompt-req-a')).toBeInTheDocument();
    expect(within(screen.getByTestId('variant-card-b')).queryByRole('alert')).not.toBeInTheDocument();

    await user.click(within(screen.getByTestId('variant-card-a')).getByTestId('approval-deny'));
    expect(onResolveApproval).toHaveBeenCalledWith('req-a', { choice: 'deny' });
    // b never had a prompt to begin with, and is untouched by a's resolution.
    expect(within(screen.getByTestId('variant-card-b')).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('defaults the active tab to the kept variant when reopened', () => {
    const variants = [variant('a'), variant('b')];
    render(
      <VariantTabs variants={variants} extras={{}} models={[]} keptId="b" onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );
    expect(screen.getByTestId('variant-card-b')).toBeInTheDocument();
  });
});
