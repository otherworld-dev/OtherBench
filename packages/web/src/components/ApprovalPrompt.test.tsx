import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@grunt/core/ports/tool-provider.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req-1',
    chatId: 'chat-1',
    messageId: 'msg-1',
    toolName: 'write_file',
    risk: 'mutate',
    source: 'fs',
    args: { path: 'notes/a.txt', content: 'irrelevant here' },
    summary: 'write_file(notes/a.txt)',
    ...overrides,
  };
}

describe('ApprovalPrompt', () => {
  afterEach(cleanup);

  it('renders the tool name, risk, and summary', () => {
    render(<ApprovalPrompt request={request()} onResolve={vi.fn()} />);
    expect(screen.getByTestId('approval-prompt-req-1')).toHaveTextContent('write_file');
    expect(screen.getByText('write_file(notes/a.txt)')).toBeInTheDocument();
  });

  it('Deny sends {choice: "deny"}', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={request()} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-deny'));
    expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'deny' });
  });

  it('Allow once sends {choice: "once"}', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={request()} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-once'));
    expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'once' });
  });

  it('Allow for this chat sends {choice: "chat"}', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={request()} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-chat'));
    expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'chat' });
  });

  it('Always allow derives a pathPrefix constraint from a fs request\'s own "path" arg', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={request()} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-always'));
    expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { pathPrefix: 'notes/a.txt' } });
  });

  it('Always allow derives a commandPrefix constraint from a shell request\'s own "command" arg', async () => {
    const shellRequest = request({ toolName: 'run_command', source: 'shell', risk: 'execute', args: { command: 'npm test' }, summary: 'run_command: npm test' });
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={shellRequest} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-always'));
    expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { commandPrefix: 'npm test' } });
  });

  it('disables the buttons once a choice is sent, so a slow response cannot be double-submitted', async () => {
    let resolvePromise: () => void = () => {};
    const onResolve = vi.fn(() => new Promise<void>((resolve) => (resolvePromise = resolve)));
    render(<ApprovalPrompt request={request()} onResolve={onResolve} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('approval-once'));
    expect(screen.getByTestId('approval-once')).toBeDisabled();
    expect(screen.getByTestId('approval-deny')).toBeDisabled();
    resolvePromise();
  });

  it('re-enables the buttons and shows an error message when the resolve call fails', async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error('network down'));
    render(<ApprovalPrompt request={request()} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-once'));
    expect(await screen.findByText(/try again/i)).toBeInTheDocument();
    expect(screen.getByTestId('approval-once')).not.toBeDisabled();
  });
});
