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
    render(<Message message={base()} />);
    const strong = screen.getByText('world');
    expect(strong.tagName).toBe('STRONG');
  });

  it('renders a reasoning part inside a collapsed-by-default details block', async () => {
    const message = base({ parts: [{ type: 'reasoning', text: 'thinking it through' }, { type: 'text', text: 'answer' }] });
    render(<Message message={message} />);

    const details = screen.getByText('Reasoning').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');

    const user = userEvent.setup();
    await user.click(screen.getByText('Reasoning'));
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('thinking it through')).toBeVisible();
  });

  it('shows a streaming caret only while the message is streaming', () => {
    const { rerender } = render(<Message message={base({ status: 'streaming' })} />);
    expect(screen.getByLabelText('streaming')).toBeInTheDocument();

    rerender(<Message message={base({ status: 'complete' })} />);
    expect(screen.queryByLabelText('streaming')).not.toBeInTheDocument();
  });

  it('shows the error message when status is error', () => {
    const message = base({ status: 'error', error: { kind: 'rate_limit', message: 'slow down', retryable: true } });
    render(<Message message={message} />);
    expect(screen.getByText('slow down')).toBeInTheDocument();
  });

  it('shows a "reopen other variants" chip only when otherVariantsCount > 0, wired to the provided callback', async () => {
    const { rerender } = render(<Message message={base()} />);
    expect(screen.queryByTestId('reopen-variants-chip')).not.toBeInTheDocument();

    let reopened = false;
    rerender(<Message message={base()} otherVariantsCount={2} onReopenVariants={() => (reopened = true)} />);
    expect(screen.getByTestId('reopen-variants-chip')).toHaveTextContent('⤺ 2 other variants');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('reopen-variants-chip'));
    expect(reopened).toBe(true);
  });

  it('singularises the chip label for exactly one other variant', () => {
    render(<Message message={base()} otherVariantsCount={1} />);
    expect(screen.getByTestId('reopen-variants-chip')).toHaveTextContent('⤺ 1 other variant');
  });

  it('renders user messages as plain text, not markdown', () => {
    const message = base({ role: 'user', producedBy: null, parts: [{ type: 'text', text: 'Hello **world**' }] });
    render(<Message message={message} />);
    expect(screen.getByText('Hello **world**')).toBeInTheDocument();
    expect(screen.queryByText('world')).not.toBeInTheDocument();
  });

  it('renders a pending approval inline, wired to onResolveApproval, and renders none when the list is empty', () => {
    const { rerender } = render(<Message message={base()} pendingApprovals={[]} onResolveApproval={async () => {}} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const request = {
      id: 'req-1',
      chatId: 'c1',
      messageId: 'm1',
      toolName: 'write_file',
      risk: 'mutate' as const,
      source: 'fs' as const,
      args: { path: 'a.txt' },
      summary: 'write_file(a.txt)',
    };
    rerender(<Message message={base()} pendingApprovals={[request]} onResolveApproval={async () => {}} />);
    expect(screen.getByTestId('approval-prompt-req-1')).toBeInTheDocument();
  });
});
