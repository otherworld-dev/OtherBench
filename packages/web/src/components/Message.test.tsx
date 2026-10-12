import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it("shows a user message's notices, as for an imported message whose image the export didn't have", () => {
    const message = base({
      role: 'user',
      producedBy: null,
      parts: [
        { type: 'notice', text: 'Not included in the claude.ai export: screenshot.png' },
        { type: 'text', text: 'What is this?' },
      ],
    });
    render(<Message message={message} />);
    expect(screen.getByRole('note')).toHaveTextContent('Not included in the claude.ai export: screenshot.png');
    expect(screen.getByText('What is this?')).toBeInTheDocument();
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

    it('keeps an expanded group open while more tool parts stream into the trailing run', async () => {
      const { rerender } = render(<Message message={base({ parts: [call('1', 'Glob'), result('1', 'Glob')] })} />);
      await userEvent.setup().click(screen.getByText('Used 1 tool: Glob'));
      expect(screen.getByText('Used 1 tool: Glob').closest('details')).toHaveAttribute('open');

      rerender(<Message message={base({ parts: [call('1', 'Glob'), result('1', 'Glob'), call('2', 'Read')] })} />);
      expect(screen.getByText('Used 2 tools: Glob, Read').closest('details')).toHaveAttribute('open');
    });

    it('other parts break the run into separate groups', () => {
      const parts = [call('1', 'Glob'), result('1', 'Glob'), { type: 'text' as const, text: 'between' }, call('2', 'Grep'), result('2', 'Grep')];
      render(<Message message={base({ parts })} />);
      expect(screen.getByText('Used 1 tool: Glob')).toBeInTheDocument();
      expect(screen.getByText('between')).toBeInTheDocument();
      expect(screen.getByText('Used 1 tool: Grep')).toBeInTheDocument();
    });
  });

  describe('branch switcher', () => {
    it('shows "‹ 2 / 3 ›" and steps to the previous/next sibling', async () => {
      const onSelect = vi.fn();
      render(<Message message={base()} branch={{ index: 1, total: 3, onSelect }} />);
      expect(screen.getByTestId('branch-switcher')).toHaveTextContent('2 / 3');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Previous branch' }));
      await user.click(screen.getByRole('button', { name: 'Next branch' }));
      expect(onSelect.mock.calls).toEqual([[-1], [1]]);
    });

    it('disables the arrow with nothing further in that direction', () => {
      const { rerender } = render(<Message message={base()} branch={{ index: 0, total: 2, onSelect: vi.fn() }} />);
      expect(screen.getByRole('button', { name: 'Previous branch' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Next branch' })).toBeEnabled();
      rerender(<Message message={base()} branch={{ index: 1, total: 2, onSelect: vi.fn() }} />);
      expect(screen.getByRole('button', { name: 'Next branch' })).toBeDisabled();
    });

    it('gives the counter an accessible name and can be disabled wholesale', () => {
      render(<Message message={base()} branch={{ index: 0, total: 2, disabled: true, onSelect: vi.fn() }} />);
      expect(screen.getByRole('group', { name: 'Branch 1 of 2' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next branch' })).toBeDisabled();
    });

    it('renders nothing without a branch prop', () => {
      render(<Message message={base()} />);
      expect(screen.queryByTestId('branch-switcher')).not.toBeInTheDocument();
    });
  });

  describe('regenerate and edit actions', () => {
    it('puts the actions on the label line, shown on hover or keyboard focus', () => {
      render(<Message message={base({ role: 'user', producedBy: null })} onEdit={vi.fn()} />);
      const edit = screen.getByRole('button', { name: 'Edit' });
      expect(edit.closest('[data-message-header]')).not.toBeNull();
      expect(edit.parentElement).toHaveClass('opacity-0', 'group-hover:opacity-100', 'group-has-[:focus-visible]:opacity-100');
    });

    it('draws a box around the message only when framed', () => {
      const { container, rerender } = render(<Message message={base()} />);
      expect(container.querySelector('article')).not.toHaveClass('border');
      rerender(<Message message={base()} framed />);
      expect(container.querySelector('article')).toHaveClass('border', 'rounded');
    });

    it('offers Regenerate on an assistant message only when a handler is given, and calls it', async () => {
      const onRegenerate = vi.fn();
      const { rerender } = render(<Message message={base()} />);
      expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
      rerender(<Message message={base()} onRegenerate={onRegenerate} />);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Regenerate' }));
      expect(onRegenerate).toHaveBeenCalledOnce();
    });

    it('offers Edit on a user message, and disables both actions when actionsDisabled', async () => {
      const onEdit = vi.fn();
      const user = base({ role: 'user', producedBy: null });
      const { rerender } = render(<Message message={user} onEdit={onEdit} />);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Edit' }));
      expect(onEdit).toHaveBeenCalledOnce();
      rerender(<Message message={user} onEdit={onEdit} actionsDisabled />);
      expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
      rerender(<Message message={base()} onRegenerate={vi.fn()} actionsDisabled />);
      expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
    });

    it('does not offer Regenerate while the message is streaming', () => {
      render(<Message message={base({ status: 'streaming' })} onRegenerate={vi.fn()} actionsDisabled />);
      expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
    });
  });

  describe('inline editing', () => {
    const userMsg = (parts: CanonMessage['parts']) => base({ role: 'user', producedBy: null, parts });

    it('opens a textarea holding the message text; Save sends the edited text', async () => {
      const onSave = vi.fn();
      render(<Message message={userMsg([{ type: 'text', text: 'original' }])} editing={{ onSave, onCancel: vi.fn() }} />);
      const box = screen.getByRole('textbox', { name: 'Edit message' });
      expect(box).toHaveValue('original');
      const user = userEvent.setup();
      await user.clear(box);
      await user.type(box, 'changed');
      await user.click(screen.getByRole('button', { name: 'Save and send' }));
      expect(onSave).toHaveBeenCalledWith([{ type: 'text', text: 'changed' }]);
    });

    it('keeps the attachment parts unless the user removes them', async () => {
      const onSave = vi.fn();
      const img = { type: 'image', attachmentId: 'a1', mime: 'image/png' } as const;
      const file = { type: 'file', attachmentId: 'a2', mime: 'text/plain', filename: 'n.txt' } as const;
      render(<Message message={userMsg([{ type: 'text', text: 'hi' }, img, file])} editing={{ onSave, onCancel: vi.fn() }} />);
      const user = userEvent.setup();
      expect(screen.getAllByTestId('attachment-chip')).toHaveLength(2);
      await user.click(screen.getAllByRole('button', { name: /remove/i })[0]!);
      await user.click(screen.getByRole('button', { name: 'Save and send' }));
      expect(onSave).toHaveBeenCalledWith([{ type: 'text', text: 'hi' }, file]);
    });

    it('shows which profile will answer, a compare note, and will not save while busy', () => {
      render(
        <Message
          message={userMsg([{ type: 'text', text: 'x' }])}
          editing={{ onSave: vi.fn(), onCancel: vi.fn(), busy: true, profileName: 'Mock B', compareNote: true }}
        />
      );
      expect(screen.getByTestId('edit-profile-note')).toHaveTextContent('Mock B');
      expect(screen.getByTestId('edit-profile-note')).toHaveTextContent(/one profile/i);
      expect(screen.getByRole('button', { name: 'Save and send' })).toBeDisabled();
    });

    it('will not save an empty edit, and Cancel/Escape leave without saving', async () => {
      const onSave = vi.fn();
      const onCancel = vi.fn();
      render(<Message message={userMsg([{ type: 'text', text: 'x' }])} editing={{ onSave, onCancel }} />);
      const user = userEvent.setup();
      await user.clear(screen.getByRole('textbox', { name: 'Edit message' }));
      expect(screen.getByRole('button', { name: 'Save and send' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onCancel).toHaveBeenCalledOnce();
      await user.type(screen.getByRole('textbox', { name: 'Edit message' }), '{Escape}');
      expect(onCancel).toHaveBeenCalledTimes(2);
      expect(onSave).not.toHaveBeenCalled();
    });
  });
});

describe('Message thread cards', () => {
  afterEach(cleanup);
  const todos = (status: string) => ({ todos: [{ content: 'Read', status, activeForm: 'Reading' }, { content: 'Write', status: 'pending', activeForm: 'Writing' }] });

  it('shows the checklist from the latest todo call and leaves todo calls out of the tool group', () => {
    render(<Message message={base({ status: 'streaming', parts: [
      { type: 'tool-call', id: 't1', name: 'update_todos', args: todos('in_progress') },
      { type: 'tool-result', id: 't1', name: 'update_todos', result: 'Checklist updated.', isError: false },
      { type: 'tool-call', id: 't2', name: 'read_file', args: { path: 'a.txt' } },
      { type: 'tool-result', id: 't2', name: 'read_file', result: 'x', isError: false },
      { type: 'tool-call', id: 't3', name: 'TodoWrite', args: todos('completed') },
      { type: 'text', text: 'Working' },
    ] })} />);
    expect(screen.getByTestId('todo-checklist')).toHaveTextContent('1 of 2 done');
    expect(screen.getByText('Used 1 tool: read_file')).toBeInTheDocument();
    expect(screen.queryByText(/update_todos|TodoWrite/)).toBeNull();
  });

  it('shows an answered question and a decided plan as records, and nothing for one still waiting', () => {
    render(<Message message={base({ parts: [
      { type: 'tool-call', id: 'q1', name: 'ask_user', args: { questions: [{ question: 'Which colour?', header: 'C', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false }] } },
      { type: 'tool-result', id: 'q1', name: 'ask_user', result: 'User has answered your questions: "Which colour?"="Blue".', isError: false },
      { type: 'tool-call', id: 'p1', name: 'propose_plan', args: { plan: '1. Paint' } },
      { type: 'tool-result', id: 'p1', name: 'propose_plan', result: 'The user approved the plan.', isError: false },
      { type: 'tool-call', id: 'q2', name: 'AskUserQuestion', args: { questions: [] } },
    ] })} />);
    expect(screen.getByTestId('question-record')).toHaveTextContent('Which colour?');
    expect(screen.getByTestId('question-record')).toHaveTextContent('"Which colour?"="Blue"');
    expect(screen.getByTestId('plan-record')).toHaveTextContent('Plan · The user approved the plan.');
    expect(screen.getAllByTestId('question-record')).toHaveLength(1);
    expect(screen.queryByText(/Used \d+ tool/)).toBeNull();
  });

  it('still renders a plan record when the plan call has no result value', () => {
    render(<Message message={base({ parts: [
      { type: 'tool-call', id: 'p1', name: 'propose_plan', args: { plan: '1. Paint' } },
      { type: 'tool-result', id: 'p1', name: 'propose_plan', result: undefined, isError: false },
    ] })} />);
    expect(screen.getByTestId('plan-record')).toBeInTheDocument();
  });

  it('renders pending question and plan cards after any approval cards, wired to onAnswerAsk', async () => {
    const onAnswerAsk = vi.fn(async () => {});
    const question = { kind: 'question' as const, toolName: 'ask_user', id: 'a1', chatId: 'c1', messageId: 'm1', questions: [{ question: 'Which?', header: '', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }] };
    const plan = { kind: 'plan' as const, toolName: 'propose_plan', id: 'a2', chatId: 'c1', messageId: 'm1', plan: '1. x' };
    render(<Message message={base({ status: 'streaming' })} pendingAsks={[question, plan]} onAnswerAsk={onAnswerAsk} />);
    expect(screen.getByTestId('ask-card-a1')).toHaveAttribute('data-kind', 'question');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve plan' }));
    expect(onAnswerAsk).toHaveBeenCalledWith('a2', { approve: true });
  });
});