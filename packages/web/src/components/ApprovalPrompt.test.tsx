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

  it('Always allow defaults to a commandExact constraint from a shell request\'s own "command" arg -- NOT commandPrefix (controller ruling: shell grants default to exact command)', async () => {
    const shellRequest = request({ toolName: 'run_command', source: 'shell', risk: 'execute', args: { command: 'npm test' }, summary: 'run_command: npm test' });
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={shellRequest} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-always'));
    expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { commandExact: 'npm test' } });
  });

  it('does not show the "allow with any arguments" opt-in for a non-shell (fs) request', () => {
    render(<ApprovalPrompt request={request()} onResolve={vi.fn()} />);
    expect(screen.queryByTestId('approval-allow-any-args-toggle')).not.toBeInTheDocument();
  });

  it('shows a plain-language warning and switches to a commandPrefix constraint only when the explicit "allow with any arguments" opt-in is checked', async () => {
    const shellRequest = request({ toolName: 'run_command', source: 'shell', risk: 'execute', args: { command: 'npm test' }, summary: 'run_command: npm test' });
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={shellRequest} onResolve={onResolve} />);
    const user = userEvent.setup();

    // Opting in surfaces a plain-language warning about the scope of what's being granted.
    const toggle = screen.getByTestId('approval-allow-any-args-toggle');
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    const warning = screen.getByTestId('approval-any-args-warning');
    expect(warning).toHaveTextContent(/any arguments/i);
    expect(warning).toHaveTextContent('npm test');

    await user.click(screen.getByTestId('approval-always'));
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

  it.each(['Bash', 'PowerShell'])('treats agent %s like shell: always defaults to the exact command', async (toolName) => {
    const agentRequest = request({ toolName, source: 'agent', risk: 'execute', args: { command: 'npm test' }, summary: `${toolName}: npm test` });
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={agentRequest} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-always'));
    expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { commandExact: 'npm test' } });
  });

  it('scopes an agent file tool "always" to its normalised path', async () => {
    const agentRequest = request({ toolName: 'Edit', source: 'agent', args: { file_path: 'E:/ws/src/a.ts', path: 'src/a.ts' }, summary: 'Edit src/a.ts' });
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={agentRequest} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-always'));
    expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { pathPrefix: 'src/a.ts' } });
  });
});
