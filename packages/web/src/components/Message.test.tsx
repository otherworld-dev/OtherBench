import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@otherbench/core/ports/tool-provider.js';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import type { Usage } from '@otherbench/core/types/usage.js';
import { COMPUTER_SCREEN_ABOUT } from '@otherbench/core/domain/computer-apps.js';
import { configureTransport } from '../state/transport.js';
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

  it('renders a context line as a separator, not a user bubble', () => {
    render(<Message message={base({ role: 'user', producedBy: null, parts: [{ type: 'context', kind: 'clear' }] })} />);
    expect(screen.getByRole('separator')).toHaveTextContent('Context cleared');
    expect(screen.queryByText('You')).toBeNull();
  });

  it("a context line carries the message's id and, with siblings, the branch switcher", async () => {
    const onSelect = vi.fn();
    const line = base({ id: 'k1', role: 'user', producedBy: null, parts: [{ type: 'context', kind: 'compact', focus: 'the API' }] });
    const { container, rerender } = render(<Message message={line} branch={{ index: 1, total: 2, onSelect }} />);
    expect(container.querySelector('#msg-k1')).toContainElement(screen.getByRole('separator'));
    expect(screen.getByTestId('branch-switcher')).toHaveTextContent('2 / 2');
    // Outside the separator, whose children are presentational.
    expect(screen.getByRole('separator')).not.toContainElement(screen.getByTestId('branch-switcher'));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous branch' }));
    expect(onSelect).toHaveBeenCalledWith(-1);
    rerender(<Message message={line} />);
    expect(screen.queryByTestId('branch-switcher')).not.toBeInTheDocument();
  });

  it("shows the message's time on its header line, the full date and time on hover", () => {
    const at = Date.now();
    const { container } = render(<Message message={base({ createdAt: at })} />);
    const time = container.querySelector('[data-message-header] time');
    expect(time).toHaveAttribute('datetime', new Date(at).toISOString());
    expect(time).toHaveAttribute('title', new Date(at).toLocaleString());
    expect(time).toHaveTextContent(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  });

  it('renders a compact summary closed, with the token counts, and the summary once opened', async () => {
    const message = base({ parts: [{ type: 'context-summary', text: 'The **gist**', preTokens: 120000, postTokens: 8000 }] });
    render(<Message message={message} />);
    const summary = screen.getByText(`Context compacted · ${(120000).toLocaleString()} → ${(8000).toLocaleString()} tokens`);
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    await userEvent.setup().click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText('gist').tagName).toBe('STRONG');
  });

  it('leaves the counts off a compact summary that has none', () => {
    render(<Message message={base({ parts: [{ type: 'context-summary', text: 's' }] })} />);
    expect(screen.getByText('Context compacted')).toBeInTheDocument();
  });

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

    it('tags a sandboxed run_command result "sandbox", and not a host one or another tool claiming it', () => {
      const parts = [
        { type: 'tool-call' as const, id: 's', name: 'run_command', args: { command: 'uname' } },
        { type: 'tool-result' as const, id: 's', name: 'run_command', result: '{"exitCode":0,"output":"Linux","sandbox":true}', isError: false },
        { type: 'tool-call' as const, id: 'h', name: 'run_command', args: { command: 'ver' } },
        { type: 'tool-result' as const, id: 'h', name: 'run_command', result: { exitCode: 0, output: 'Windows' }, isError: false },
        { type: 'tool-call' as const, id: 'm', name: 'mcp__evil__run', args: {} },
        { type: 'tool-result' as const, id: 'm', name: 'mcp__evil__run', result: '{"exitCode":0,"sandbox":true}', isError: false },
      ];
      render(<Message message={base({ parts })} />);
      expect(screen.getAllByTestId('sandbox-tag')).toHaveLength(1);
    });

    it('shows a browser call by what it does, and its result by title and address with the snapshot folded away', () => {
      const parts = [
        { type: 'tool-call' as const, id: 't1', name: 'browser', args: { command: 'open', url: 'https://example.com/' } },
        {
          type: 'tool-result' as const,
          id: 't1',
          name: 'browser',
          result: JSON.stringify({ about: 'x', url: 'https://example.com/', title: 'Example\u202e Domain', snapshot: '- heading "Example\u200b Domain" [ref=e1]' }),
          isError: false,
        },
      ];
      render(<Message message={base({ parts })} />);
      expect(screen.getByText('browser: open https://example.com/', { exact: false })).toBeInTheDocument();
      // The page's title and address each sit in a <bdi>: their direction stays their own.
      expect(screen.getByText('Example Domain').tagName).toBe('BDI');
      expect(screen.getByText('https://example.com/').tagName).toBe('BDI');
      const snapshot = screen.getByText('Page snapshot').closest('details')!;
      expect(snapshot).not.toHaveAttribute('open');
      expect(snapshot).toHaveTextContent('- heading "Example Domain" [ref=e1]');
    });

    it('shows a failed browser call as the ordinary error block', () => {
      const parts = [
        { type: 'tool-call' as const, id: 't1', name: 'browser', args: { command: 'snapshot' } },
        { type: 'tool-result' as const, id: 't1', name: 'browser', result: 'No page is open: use open first.', isError: true },
      ];
      render(<Message message={base({ parts })} />);
      expect(screen.getByText('No page is open: use open first.')).toBeInTheDocument();
    });

    it('prefixes the summary with a warning when any result is an error', () => {
      render(<Message message={base({ parts: [call('1', 'Bash'), result('1', 'Bash', true)] })} />);
      expect(screen.getByText('⚠ Used 1 tool: Bash')).toBeInTheDocument();
    });

    it('shows an edit as a diff outside the closed group, which still counts it (spec 2026-10-20-code-tab-design)', () => {
      const edit = { type: 'tool-call' as const, id: 'e', name: 'Edit', args: { file_path: 'a.ts', old_string: 'one', new_string: 'two' } };
      render(<Message message={base({ parts: [call('1', 'Read'), result('1', 'Read'), edit, result('e', 'Edit')] })} />);
      expect(screen.getByText('Used 2 tools: Read, Edit').closest('details')).not.toHaveAttribute('open');
      const diff = screen.getByTestId('edit-diff');
      expect(diff.parentElement!.closest('details')).toBeNull();
      expect(within(diff).getByText('two')).toBeInTheDocument();
    });

    it('keeps an activity fold whole around an edit diff, with the diff outside it', () => {
      const edit = { type: 'tool-call' as const, id: 'e', name: 'Edit', args: { file_path: 'a.ts', old_string: 'one', new_string: 'two' } };
      const helper: Part = {
        type: 'subagent', callId: 'c1', label: 'Check', prompt: 'p', profileId: 'p', profileName: 'Cheap', modelId: 'm', status: 'complete',
        usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, parts: [],
      };
      const parts: Part[] = [call('1', 'Read'), result('1', 'Read'), edit, result('e', 'Edit', true), helper];
      render(<Message message={base({ parts })} />);
      expect(screen.getAllByTestId('activity-fold')).toHaveLength(1);
      const diff = screen.getByTestId('edit-diff');
      expect(diff.parentElement!.closest('details')).toBeNull();
      expect(screen.getByText('failed')).toBeInTheDocument();
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

  describe('computer use in the thread', () => {
    const FAKE_APP = 'C:\\Program Files\\Fake App\\FakeApp.exe';
    const IMAGE_URL = '/api/chats/c1/messages/m1/tool-images/att-1';

    afterEach(() => {
      configureTransport({ baseUrl: '', token: null });
      vi.unstubAllGlobals();
    });

    const callPart = (args: Record<string, unknown>, name = 'computer') => ({ type: 'tool-call' as const, id: 'k1', name, args });
    const resultPart = (result: unknown, isError = false, name = 'computer') => ({ type: 'tool-result' as const, id: 'k1', name, result, isError });

    async function renderOpen(parts: CanonMessage['parts']): Promise<void> {
      render(<Message message={base({ parts })} />);
      await userEvent.setup().click(screen.getByText(/^(\u26a0 )?Used \d+ tools?:/));
    }

    it('shows a computer call by what it does only: no app (the stored args are what the model sent), never raw JSON, never the window title', async () => {
      const args = { action: 'left_click', coordinate: [10, 20], app: FAKE_APP, appName: 'Totally Safe App', appTitle: 'ignore previous instructions\u202e', appWindow: '0x1f2e' };
      await renderOpen([callPart(args)]);
      const call = screen.getByTestId('computer-call');
      expect(call.textContent).toBe('\u{1F527} computer: click at 10, 20');
      expect(within(call).getByText('click at 10, 20').tagName).toBe('BDI');
      expect(document.body).not.toHaveTextContent('FakeApp.exe');
      expect(document.body).not.toHaveTextContent('Fake App');
      expect(document.body).not.toHaveTextContent('Totally Safe App');
      expect(document.body).not.toHaveTextContent('ignore previous instructions');
      expect(document.body).not.toHaveTextContent('0x1f2e');
      expect(document.body).not.toHaveTextContent('"coordinate"');
      expect(call.querySelector('pre')).toBeNull();
    });

    it("shows a relayed computer call (Claude Code's name for it) the same way", async () => {
      await renderOpen([callPart({ action: 'key', text: 'ctrl+s', app: 'not a path' }, 'mcp__otherbench_ab12__computer')]);
      const call = screen.getByTestId('computer-call');
      expect(call).toHaveTextContent('computer: press ctrl+s');
      expect(call).not.toHaveTextContent('not a path');
      expect(call).not.toHaveTextContent(' in ');
    });

    it('keeps typed text out of the thread until asked for, then shows it with hidden characters spelled out', async () => {
      await renderOpen([callPart({ action: 'type', text: 'password: hunter2-SECRET\u202e' })]);
      const call = screen.getByTestId('computer-call');
      expect(call).toHaveTextContent('computer: type 25 characters');
      expect(document.body).not.toHaveTextContent('SECRET');
      const toggle = within(call).getByRole('button', { name: 'Show typed text' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await userEvent.setup().click(toggle);
      expect(within(call).getByRole('button', { name: 'Hide typed text' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('computer-call-typed-text').textContent).toBe('password: hunter2-SECRET<U+202E>');
    });

    it("shows a screenshot result: the screen-content line as a muted label, the words as plain text, the image through the chat's tool-image route", async () => {
      const result = [
        { type: 'text', text: COMPUTER_SCREEN_ABOUT },
        { type: 'text', text: 'Screenshot, 1366\u00d7768. **bold** <b>tag</b>\u202e' },
        { type: 'image', attachmentId: 'att-1', mimeType: 'image/png' },
      ];
      await renderOpen([callPart({ action: 'screenshot' }), resultPart(result)]);
      const about = screen.getByTestId('computer-screen-about');
      expect(about).toHaveTextContent(COMPUTER_SCREEN_ABOUT);
      expect(about.className).toMatch(/text-\[var\(--text-muted\)\]/);
      const words = screen.getByText('Screenshot, 1366\u00d7768. **bold** <b>tag</b>');
      expect(words.tagName).toBe('BDI');
      expect(document.querySelector('strong, b')).toBeNull();
      expect(document.body.textContent).not.toContain('\u202e');
      const img = screen.getByAltText('Screenshot');
      expect(img.getAttribute('src')).toBe(IMAGE_URL);
      expect(document.querySelectorAll('img')).toHaveLength(1);
    });

    it('loads nothing for an image that is still pending, and says so', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await renderOpen([callPart({ action: 'screenshot' }), resultPart([{ type: 'text', text: COMPUTER_SCREEN_ABOUT }, { type: 'image', attachmentId: 'att-1', mimeType: 'image/png', pending: true }])]);
      expect(screen.getByText('Screenshot not available yet.')).toBeInTheDocument();
      expect(document.querySelectorAll('img')).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('renders only top-level items of a result as images', async () => {
      const nested = [[{ type: 'image', attachmentId: 'att-1', mimeType: 'image/png' }], { type: 'group', items: [{ type: 'image', attachmentId: 'att-2', mimeType: 'image/png' }] }];
      await renderOpen([callPart({ action: 'screenshot' }), resultPart(nested)]);
      expect(document.querySelectorAll('img')).toHaveLength(0);
      expect(document.body).not.toHaveTextContent('att-1');
    });

    it('shows a note for a screenshot the server no longer has, and does not ask again', async () => {
      await renderOpen([callPart({ action: 'screenshot' }), resultPart([{ type: 'image', attachmentId: 'att-1', mimeType: 'image/png' }])]);
      fireEvent.error(screen.getByAltText('Screenshot'));
      expect(await screen.findByText('Screenshot not available.')).toBeInTheDocument();
      expect(document.querySelectorAll('img')).toHaveLength(0);
    });

    it('with a token, a 404 for a screenshot is a note, fetched once', async () => {
      configureTransport({ baseUrl: '', token: 'tok' });
      const fetchSpy = vi.fn(async () => new Response('gone', { status: 404 }));
      vi.stubGlobal('fetch', fetchSpy);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await renderOpen([callPart({ action: 'screenshot' }), resultPart([{ type: 'image', attachmentId: 'att-1', mimeType: 'image/png' }])]);
      expect(await screen.findByText('Screenshot not available.')).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 20));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((fetchSpy.mock.calls[0] as unknown as [string])[0]).toBe(IMAGE_URL);
      spy.mockRestore();
    });

    it('shows a refusal by its message, as plain text under the screen-content label', async () => {
      const refusal = { about: COMPUTER_SCREEN_ABOUT, error: true, code: 'refused', message: 'The window changed.\n**Try** again' };
      await renderOpen([callPart({ action: 'left_click', coordinate: [1, 2] }), resultPart(refusal, true)]);
      expect(screen.getByTestId('computer-screen-about')).toHaveTextContent(COMPUTER_SCREEN_ABOUT);
      expect(screen.getByText('The window changed. **Try** again').tagName).toBe('BDI');
      expect(document.body).not.toHaveTextContent('"code"');
    });

    it("shows a Claude Code computer result (kept as one string) with the screen-content line as its label and each line as plain text", async () => {
      const name = 'mcp__otherbench_ab12__computer';
      const result = `${COMPUTER_SCREEN_ABOUT}\nDone.\nScreenshot, 1366×768. **bold**‮`;
      await renderOpen([callPart({ action: 'left_click', coordinate: [1, 2] }, name), resultPart(result, false, name)]);
      const about = screen.getByTestId('computer-screen-about');
      expect(about).toHaveTextContent(COMPUTER_SCREEN_ABOUT);
      expect(screen.getByText('Done.').tagName).toBe('BDI');
      expect(screen.getByText('Screenshot, 1366×768. **bold**').tagName).toBe('BDI');
      // The label is not repeated as body text, and nothing is glued to it.
      expect(screen.getAllByText(COMPUTER_SCREEN_ABOUT, { exact: false })).toHaveLength(1);
      expect(document.body.textContent).not.toContain('‮');
      expect(document.querySelector('strong')).toBeNull();
    });

    it('shows a string result without the screen-content line as plain text, with no label', async () => {
      await renderOpen([callPart({ action: 'wait' }), resultPart('Waited 1 s.')]);
      expect(screen.queryByTestId('computer-screen-about')).toBeNull();
      expect(screen.getByText('Waited 1 s.').tagName).toBe('BDI');
    });

    it('leaves other tools as they were: the call as JSON, a text result as it is', async () => {
      await renderOpen([
        { type: 'tool-call', id: 'g1', name: 'Glob', args: { pattern: '**/*.ts' } },
        { type: 'tool-result', id: 'g1', name: 'Glob', result: 'a.ts\nb.ts', isError: false },
      ]);
      expect(screen.getByText('🔧 Glob')).toBeInTheDocument();
      expect(screen.getByText(JSON.stringify({ pattern: '**/*.ts' }, null, 2), { normalizer: (s) => s }).tagName).toBe('PRE');
      expect(screen.getByText('a.ts\nb.ts', { normalizer: (s) => s }).tagName).toBe('PRE');
      expect(screen.queryByTestId('computer-call')).toBeNull();
    });

    it("shows an image another tool returned through the same route, and the rest of that tool's result as before", async () => {
      await renderOpen([
        { type: 'tool-call', id: 'g1', name: 'snap', args: {} },
        { type: 'tool-result', id: 'g1', name: 'snap', result: [{ type: 'text', text: 'one image' }, { type: 'image', attachmentId: 'att-1', mimeType: 'image/png' }], isError: false },
      ]);
      expect(screen.getByAltText('Image from snap').getAttribute('src')).toBe(IMAGE_URL);
      expect(screen.getByText('one image').tagName).toBe('PRE');
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

describe('Message sub-agent cards', () => {
  afterEach(cleanup);

  const card = (over: Partial<Extract<Part, { type: 'subagent' }>> = {}): Part => ({
    type: 'subagent', callId: 'call-1', label: 'Check the logs', prompt: 'Look in logs/ for errors.', profileId: 'p', profileName: 'Cheap', modelId: 'small-1', status: 'complete',
    usage: { tokensIn: 1200, tokensOut: 80, tokensCached: 0, tokensReasoning: 0 },
    parts: [{ type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'logs/a.log' } }, { type: 'text', text: 'One error at noon.' }],
    ...over,
  });
  const parentCall: Part = { type: 'tool-call', id: 'call-1', name: 'subagent', args: { description: 'Check the logs', prompt: 'Look in logs/ for errors.' } };
  const parentResult: Part = { type: 'tool-result', id: 'call-1', name: 'subagent', result: 'One error at noon.', isError: false };

  it('shows a closed card with label, profile, model, status and tokens, and hides the carded call and result', () => {
    render(<Message message={base({ parts: [parentCall, card(), parentResult, { type: 'text', text: 'The helper found one error.' }] })} />);
    const el = screen.getByTestId('subagent-card');
    expect(el.tagName).toBe('DETAILS');
    expect(el).not.toHaveAttribute('open');
    expect(el).toHaveAttribute('data-status', 'complete');
    expect(el).toHaveTextContent('◇ Check the logs');
    expect(el).toHaveTextContent('Cheap');
    expect(el).toHaveTextContent('small-1');
    expect(el).toHaveTextContent('done');
    expect(el).toHaveTextContent('1,200 in · 80 out');
    expect(screen.queryByText(/Used 1 tool: subagent/)).not.toBeInTheDocument();
    expect(screen.getByText('The helper found one error.')).toBeInTheDocument();
  });

  it("shows the sub-agent's prompt, its own tools and text when opened", async () => {
    render(<Message message={base({ parts: [card()] })} />);
    await userEvent.setup().click(screen.getByTestId('subagent-card').querySelector('summary')!);
    expect(screen.getByTestId('subagent-card')).toHaveAttribute('open');
    expect(screen.getByText('Look in logs/ for errors.')).toBeVisible();
    expect(screen.getByText('Used 1 tool: read_file')).toBeVisible();
    expect(screen.getByText('One error at noon.')).toBeVisible();
  });

  it('shows working while the reply streams, and stopped for an unfinished card on a finished reply', () => {
    const { rerender } = render(<Message message={base({ status: 'streaming', parts: [card({ status: 'running', usage: undefined })] })} />);
    expect(screen.getByTestId('subagent-card')).toHaveTextContent('working…');
    rerender(<Message message={base({ status: 'cancelled', parts: [card({ status: 'running', usage: undefined })] })} />);
    expect(screen.getByTestId('subagent-card')).toHaveAttribute('data-status', 'cancelled');
    expect(screen.getByTestId('subagent-card')).toHaveTextContent('stopped');
    rerender(<Message message={base({ status: 'streaming', parts: [card({ status: 'queued', usage: undefined })] })} />);
    expect(screen.getByTestId('subagent-card')).toHaveTextContent('waiting to start');
  });

  it("shows a Claude Code helper's card in place of its Task call, with its tool count, running time and last tool while it works", () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(10_000);
      const taskCall: Part = { type: 'tool-call', id: 'call-1', name: 'Task', args: { description: 'Check the logs', subagent_type: 'Explore' } };
      const helper = card({
        status: 'running', usage: undefined, profileName: 'Explore', startedAt: 2_000,
        parts: [
          { type: 'tool-call', id: 't1', name: 'Glob', args: { pattern: 'logs/*.log' } },
          { type: 'tool-result', id: 't1', name: 'Glob', result: 'logs/a.log', isError: false },
          { type: 'tool-call', id: 't2', name: 'Grep', args: { pattern: 'ERROR', path: 'logs' } },
        ],
      });
      render(<Message message={base({ status: 'streaming', parts: [taskCall, helper] })} />);
      const el = screen.getByTestId('subagent-card');
      expect(screen.queryByText(/Used 1 tool: Task/)).not.toBeInTheDocument();
      expect(el).toHaveTextContent('Explore');
      expect(screen.getByTestId('subagent-tools')).toHaveTextContent('2 tools');
      expect(screen.getByTestId('subagent-elapsed')).toHaveTextContent('8s');
      expect(screen.getByTestId('subagent-last-tool')).toHaveTextContent('last: Grep "ERROR"');
      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(screen.getByTestId('subagent-elapsed')).toHaveTextContent('1m 13s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a helper still working in the background on a finished reply, not stopped', () => {
    render(<Message message={base({ parts: [card({ status: 'background', usage: undefined, startedAt: 1_000 })] })} />);
    const el = screen.getByTestId('subagent-card');
    expect(el).toHaveAttribute('data-status', 'background');
    expect(el).toHaveTextContent('working in the background');
    expect(el).not.toHaveTextContent('stopped');
  });

  it('shows how long a finished helper took, and no last tool', () => {
    render(<Message message={base({ parts: [card({ startedAt: 1_000, finishedAt: 93_000 })] })} />);
    expect(screen.getByTestId('subagent-elapsed')).toHaveTextContent('1m 32s');
    expect(screen.queryByTestId('subagent-last-tool')).not.toBeInTheDocument();
  });

  it('says it needs your approval while one of its calls waits on a card', () => {
    const request: ApprovalRequest = { id: 'r1', chatId: 'c1', messageId: 'm1', toolName: 'read_file', risk: 'read', source: 'fs', args: { path: 'a' }, summary: 'read_file(a)', subagent: { callId: 'call-1', label: 'Check the logs', parentProfileId: 'p' } };
    render(<Message message={base({ status: 'streaming', parts: [card({ status: 'running', usage: undefined })] })} pendingApprovals={[request]} onResolveApproval={vi.fn()} />);
    expect(screen.getByTestId('subagent-card')).toHaveTextContent('needs your approval');
  });

  it('renders a card with no parts and usage missing its token counts without crashing', () => {
    const broken = { ...card({ usage: { tokensOut: 5 } as unknown as Usage }), parts: undefined } as unknown as Part;
    render(<Message message={base({ parts: [broken] })} />);
    const el = screen.getByTestId('subagent-card');
    expect(el).toHaveTextContent('done');
    expect(el).not.toHaveTextContent(/ in · /);
  });

  it('shows a failed card with its error, and a refused subagent call with no card in the tool group', () => {
    render(<Message message={base({ parts: [card({ status: 'error', error: 'Rate limited.', usage: undefined }), { type: 'tool-call', id: 'call-9', name: 'subagent', args: {} }, { type: 'tool-result', id: 'call-9', name: 'subagent', result: { error: true, code: 'subagent_limit' }, isError: true }] })} />);
    expect(screen.getByTestId('subagent-card')).toHaveTextContent('failed');
    expect(screen.getByText('Rate limited.')).toBeInTheDocument();
    expect(screen.getByText(/Used 1 tool: subagent/)).toBeInTheDocument();
  });

  describe('activity fold', () => {
    const bash = (id: string): Part[] => [
      { type: 'tool-call', id, name: 'Bash', args: { command: 'git log' } },
      { type: 'tool-result', id, name: 'Bash', result: 'ok', isError: false },
    ];
    const helper = (callId: string, label: string, over: Partial<Extract<Part, { type: 'subagent' }>> = {}): Part => card({ callId, label, ...over }) as Part;

    it('folds tool groups and helper cards in a row into one closed block with a summary', async () => {
      const parts: Part[] = [
        { type: 'text', text: 'Task 1 is committed.' },
        ...bash('b1'), helper('h1', 'Review Task 1'), ...bash('b2'), helper('h2', 'Implement Tasks 2-4'),
        { type: 'text', text: 'Tasks 2 to 4 are committed.' },
      ];
      render(<Message message={base({ parts })} />);
      const folds = screen.getAllByTestId('activity-fold');
      expect(folds).toHaveLength(1);
      expect(folds[0]).not.toHaveAttribute('open');
      expect(folds[0]!.querySelector('summary')).toHaveTextContent('Used 2 tools (Bash ×2) and 2 helpers: Review Task 1, Implement Tasks 2-4');
      expect(within(folds[0]!).getAllByTestId('subagent-card')).toHaveLength(2);
      expect(screen.getByText('Task 1 is committed.')).toBeVisible();
      expect(screen.getByText('Tasks 2 to 4 are committed.')).toBeVisible();

      await userEvent.setup().click(folds[0]!.querySelector('summary')!);
      expect(within(folds[0]!).getAllByText('Used 1 tool: Bash')[0]).toBeVisible();
      expect(within(folds[0]!).getByText('◇ Review Task 1')).toBeVisible();
    });

    it('leaves a lone tool group or helper card unfolded', () => {
      render(<Message message={base({ parts: [...bash('b1'), { type: 'text', text: 'between' }, helper('h1', 'Review')] })} />);
      expect(screen.queryByTestId('activity-fold')).not.toBeInTheDocument();
      expect(screen.getByText('Used 1 tool: Bash')).toBeInTheDocument();
      expect(screen.getByTestId('subagent-card')).toBeInTheDocument();
    });

    it('says in its summary when a helper is working, waits on approval, or failed', () => {
      const request: ApprovalRequest = { id: 'r1', chatId: 'c1', messageId: 'm1', toolName: 'read_file', risk: 'read', source: 'fs', args: { path: 'a' }, summary: 'read_file(a)', subagent: { callId: 'h1', label: 'A', parentProfileId: 'p' } };
      const { rerender } = render(
        <Message
          message={base({ status: 'streaming', parts: [helper('h1', 'A', { status: 'running', usage: undefined }), helper('h2', 'B', { status: 'running', usage: undefined })] })}
          pendingApprovals={[request]}
          onResolveApproval={vi.fn()}
        />
      );
      expect(screen.getByTestId('activity-fold').querySelector('summary')).toHaveTextContent('Used 2 helpers: A, B · 1 needs your approval · 1 working');
      rerender(<Message message={base({ parts: [helper('h1', 'A', { status: 'error' }), helper('h2', 'B')] })} />);
      expect(screen.getByTestId('activity-fold').querySelector('summary')).toHaveTextContent(/^⚠ Used 2 helpers: A, B$/);
    });

    it('stays open while another block streams into it', async () => {
      const first: Part[] = [...bash('b1'), helper('h1', 'A')];
      const { rerender } = render(<Message message={base({ status: 'streaming', parts: first })} />);
      await userEvent.setup().click(screen.getByTestId('activity-fold').querySelector('summary')!);
      rerender(<Message message={base({ status: 'streaming', parts: [...first, ...bash('b2')] })} />);
      expect(screen.getByTestId('activity-fold')).toHaveAttribute('open');
      expect(screen.getByTestId('activity-fold').querySelector('summary')).toHaveTextContent('Used 2 tools (Bash ×2) and 1 helper: A');
    });
  });
});

describe('Message user notes', () => {
  afterEach(cleanup);

  it('renders a user note inside a reply with its label', () => {
    const message = base({
      parts: [
        { type: 'text', text: 'Looking at it.' },
        { type: 'user-note', noteId: 'n1', text: 'also check the tests', attachments: [{ attachmentId: 'att-1', mime: 'application/pdf', filename: 'spec.pdf' }] },
        { type: 'text', text: 'Checking the tests too.' },
      ],
    });
    render(<Message message={message} />);
    const block = screen.getByTestId('user-note');
    expect(within(block).getByText('You, while Claude was working')).toBeInTheDocument();
    expect(block).toHaveTextContent('also check the tests');
    expect(within(block).getByText('spec.pdf')).toBeInTheDocument();
    // Read-only: no remove button on its chip.
    expect(within(block).queryByRole('button')).not.toBeInTheDocument();
    // Where Claude read it: between the reply's text before and after.
    const text = block.closest('article')!.textContent ?? '';
    expect(text.indexOf('Looking at it.')).toBeLessThan(text.indexOf('also check the tests'));
    expect(text.indexOf('also check the tests')).toBeLessThan(text.indexOf('Checking the tests too.'));
  });
});
