import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { Message } from './Message.js';

function base(overrides: Partial<CanonMessage> = {}): CanonMessage {
  return {
    id: 'm1',
    chatId: 'c1',
    parentId: 'u1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Hello **world**' }],
    status: 'complete',
    error: null,
    producedBy: { profileId: 'p1', profileName: 'Default', connectionId: 'c1', modelId: 'mock-standard' },
    createdAt: 0,
    ...overrides,
  };
}

describe('Message', () => {
  afterEach(cleanup);

  it('renders text parts as markdown', () => {
    render(<Message message={base()} siblingCount={1} siblingIndex={0} />);
    const strong = screen.getByText('world');
    expect(strong.tagName).toBe('STRONG');
  });

  it('renders a reasoning part inside a collapsed-by-default details block', async () => {
    const message = base({ parts: [{ type: 'reasoning', text: 'thinking it through' }, { type: 'text', text: 'answer' }] });
    render(<Message message={message} siblingCount={1} siblingIndex={0} />);

    const details = screen.getByText('Reasoning').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');

    const user = userEvent.setup();
    await user.click(screen.getByText('Reasoning'));
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('thinking it through')).toBeVisible();
  });

  it('shows a streaming caret only while the message is streaming', () => {
    const { rerender } = render(<Message message={base({ status: 'streaming' })} siblingCount={1} siblingIndex={0} />);
    expect(screen.getByLabelText('streaming')).toBeInTheDocument();

    rerender(<Message message={base({ status: 'complete' })} siblingCount={1} siblingIndex={0} />);
    expect(screen.queryByLabelText('streaming')).not.toBeInTheDocument();
  });

  it('shows the error message when status is error', () => {
    const message = base({ status: 'error', error: { kind: 'rate_limit', message: 'slow down', retryable: true } });
    render(<Message message={message} siblingCount={1} siblingIndex={0} />);
    expect(screen.getByText('slow down')).toBeInTheDocument();
  });

  it('shows a sibling switcher only when there is more than one variant, wired to the provided callbacks', async () => {
    const { rerender } = render(<Message message={base()} siblingCount={1} siblingIndex={0} />);
    expect(screen.queryByTestId('compare-seam')).not.toBeInTheDocument();

    let calledWith: string | null = null;
    rerender(
      <Message
        message={base()}
        siblingCount={3}
        siblingIndex={1}
        onPrevSibling={() => (calledWith = 'prev')}
        onNextSibling={() => (calledWith = 'next')}
      />
    );
    expect(screen.getByTestId('compare-seam')).toHaveTextContent('2 / 3');

    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Next variant'));
    expect(calledWith).toBe('next');
  });

  it('renders user messages as plain text, not markdown', () => {
    const message = base({ role: 'user', producedBy: null, parts: [{ type: 'text', text: 'Hello **world**' }] });
    render(<Message message={message} siblingCount={1} siblingIndex={0} />);
    expect(screen.getByText('Hello **world**')).toBeInTheDocument();
    expect(screen.queryByText('world')).not.toBeInTheDocument();
  });
});
