import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { CompareSplit } from './CompareSplit.js';

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
    createdAt: Date.now(),
    ...overrides,
  };
}

// CompareSplit is the standalone entry point for task 27's "container swap,
// not a second implementation" split view -- these tests exist to prove IT
// (not just VariantTabs's inline split mode) renders every variant with the
// same VariantCard renderer and wires Keep/Retry through untouched.
describe('CompareSplit', () => {
  afterEach(cleanup);

  it('renders every variant side by side using the same variant-card markup as the tab strip', () => {
    const variants = [variant('a'), variant('b'), variant('c')];
    render(<CompareSplit variants={variants} extras={{}} models={[]} keptId={null} onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />);

    expect(screen.getByTestId('compare-split')).toBeInTheDocument();
    for (const v of variants) {
      expect(screen.getByTestId(`variant-card-${v.id}`)).toHaveTextContent(`reply from ${v.id}`);
    }
  });

  it('wires each column\'s Keep button independently', async () => {
    const variants = [variant('a'), variant('b')];
    const onKeep = vi.fn();
    const user = userEvent.setup();
    render(<CompareSplit variants={variants} extras={{}} models={[]} keptId={null} onKeep={onKeep} onRetry={vi.fn()} retryingIds={new Set()} />);

    const columnB = screen.getByTestId('variant-card-b');
    const keepButtons = columnB.querySelectorAll('button');
    const keepButton = [...keepButtons].find((b) => /keep this one/i.test(b.textContent ?? ''));
    expect(keepButton).toBeDefined();
    await user.click(keepButton!);

    expect(onKeep).toHaveBeenCalledWith('b');
    expect(onKeep).not.toHaveBeenCalledWith('a');
  });

  it("marks the kept column and shows every other column's own failure independently", () => {
    const variants = [variant('kept'), variant('failed', { status: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } })];
    render(
      <CompareSplit variants={variants} extras={{}} models={[]} keptId="kept" onKeep={vi.fn()} onRetry={vi.fn()} retryingIds={new Set()} />
    );

    expect(screen.getByTestId('variant-card-kept')).toHaveTextContent('✓ Kept');
    expect(screen.getByTestId('variant-card-failed')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: /retry profile failed/i })).toBeInTheDocument();
  });
});
