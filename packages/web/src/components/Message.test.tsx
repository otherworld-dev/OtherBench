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

  // --- capability-fallback disclosure + attachment chips (task 21) ---------

  it('renders a notice part as a visible, honest banner -- not silence -- on the degraded message', () => {
    const message = base({
      parts: [
        { type: 'notice', text: '1 image attachment ("photo.png") sent as text to "local-llava" because this model does not support image input.' },
        { type: 'text', text: 'Here is what I can tell from the description.' },
      ],
    });
    render(<Message message={message} />);

    expect(screen.getByRole('note')).toHaveTextContent(/sent as text to "local-llava"/);
    expect(screen.getByText('Here is what I can tell from the description.')).toBeInTheDocument();
  });

  it('renders an attachment chip for an image part on an assistant message', () => {
    const message = base({ parts: [{ type: 'image', attachmentId: 'att-1', mime: 'image/png' }] });
    render(<Message message={message} />);

    expect(screen.getByTestId('attachment-chip')).toBeInTheDocument();
  });

  it('renders an attachment chip (with its real filename) for a file part on an assistant message', () => {
    const message = base({ parts: [{ type: 'file', attachmentId: 'att-1', mime: 'application/pdf', filename: 'report.pdf' }] });
    render(<Message message={message} />);

    expect(screen.getByTestId('attachment-chip')).toHaveTextContent('report.pdf');
  });

  it('never points an <img> at an SVG attachment -- the content route now forces SVG to a download (it can carry script), so an inline preview would only ever be a broken image', () => {
    const message = base({ parts: [{ type: 'file', attachmentId: 'att-1', mime: 'image/svg+xml', filename: 'evil.svg' }] });
    const { container } = render(<Message message={message} />);

    expect(screen.getByTestId('attachment-chip')).toBeInTheDocument();
    // AttachmentChip's thumbnail <img> has alt="" (decorative, so it's
    // absent from the accessibility tree by design) -- querying the DOM
    // directly here, not by role, is deliberate.
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders an attachment chip for a user message that included an image, alongside its plain text', () => {
    const message = base({
      role: 'user',
      producedBy: null,
      parts: [
        { type: 'text', text: 'What is in this photo?' },
        { type: 'image', attachmentId: 'att-1', mime: 'image/png' },
      ],
    });
    render(<Message message={message} />);

    expect(screen.getByText('What is in this photo?')).toBeInTheDocument();
    expect(screen.getByTestId('attachment-chip')).toBeInTheDocument();
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

  it('gives the article a DOM id so the Inspector outline can scroll to it', () => {
    const { container } = render(<Message message={base({ id: 'abc' })} />);
    expect(container.querySelector('article')).toHaveAttribute('id', 'msg-abc');
  });

  describe('tool activity grouping', () => {
    const call = (id: string, name: string) => ({ type: 'tool-call' as const, id, name, args: { q: id } });
    const result = (id: string, name: string, isError = false) => ({ type: 'tool-result' as const, id, name, result: `out-${id}`, isError });

    it('collapses a run of tool calls/results into one summary with a per-tool breakdown in first-seen order', () => {
      const parts = [
        call('1', 'Glob'), result('1', 'Glob'), call('2', 'Read'), result('2', 'Read'),
        call('3', 'Glob'), result('3', 'Glob'), call('4', 'Bash'), result('4', 'Bash'),
      ];
      render(<Message message={base({ parts })} />);
      const summary = screen.getByText('Used 4 tools: Glob ×2, Read, Bash');
      const details = summary.closest('details');
      expect(details).not.toBeNull();
      expect(details).not.toHaveAttribute('open');
    });

    it('expands to the existing call/result blocks', async () => {
      render(<Message message={base({ parts: [call('1', 'Glob'), result('1', 'Glob')] })} />);
      await userEvent.setup().click(screen.getByText('Used 1 tool: Glob'));
      expect(screen.getByText('🔧 Glob')).toBeVisible();
      expect(screen.getByText('out-1')).toBeVisible();
    });

    it('prefixes the summary with a warning when any result is an error', () => {
      render(<Message message={base({ parts: [call('1', 'Bash'), result('1', 'Bash', true)] })} />);
      expect(screen.getByText('⚠ Used 1 tool: Bash')).toBeInTheDocument();
    });

    it('counts results when a run has no calls', () => {
      render(<Message message={base({ parts: [result('1', 'Read'), result('2', 'Read')] })} />);
      expect(screen.getByText('Used 2 tools: Read ×2')).toBeInTheDocument();
    });

    it('other parts break the run into separate groups', () => {
      const parts = [call('1', 'Glob'), result('1', 'Glob'), { type: 'text' as const, text: 'between' }, call('2', 'Grep'), result('2', 'Grep')];
      render(<Message message={base({ parts })} />);
      expect(screen.getByText('Used 1 tool: Glob')).toBeInTheDocument();
      expect(screen.getByText('between')).toBeInTheDocument();
      expect(screen.getByText('Used 1 tool: Grep')).toBeInTheDocument();
    });
  });
});
