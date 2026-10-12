import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@grunt/core/ports/tool-provider.js';
import { canonicalHost } from '@grunt/core/domain/network-hosts.js';
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

  it("names the sub-agent whose tool call is asking", () => {
    render(<ApprovalPrompt request={request({ subagent: { callId: 'c1', label: 'First helper', parentProfileId: 'p-main' } })} onResolve={vi.fn()} />);
    expect(screen.getByTestId('approval-subagent')).toHaveTextContent(/^Sub-agent: First helper$/);
  });

  it('says which profile a sub-agent runs as when it is not the reply\'s own', () => {
    render(<ApprovalPrompt request={request({ subagent: { callId: 'c1', label: 'First helper', parentProfileId: 'p-main', profileName: 'Cheap' } })} onResolve={vi.fn()} />);
    expect(screen.getByTestId('approval-subagent')).toHaveTextContent('Sub-agent: First helper (runs as Cheap)');
  });

  it("shows no sub-agent line for the reply's own call", () => {
    render(<ApprovalPrompt request={request()} onResolve={vi.fn()} />);
    expect(screen.queryByText(/Sub-agent:/)).not.toBeInTheDocument();
  });

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

  it.each([
    ['mcp__gh__get_file', 'mutate'],
    ['WebFetch', 'mutate'],
    ['CronCreate', 'mutate'],
  ] as const)('gives a non-file agent tool (%s) an unconstrained "always", even when it has a path arg', async (toolName, risk) => {
    const agentRequest = request({ toolName, source: 'agent', risk, args: { path: '/README.md' }, summary: `${toolName}(/README.md)` });
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={agentRequest} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-always'));
    expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: null });
  });

  it('scopes an agent file tool "always" to its normalised path', async () => {
    const agentRequest = request({ toolName: 'Edit', source: 'agent', args: { file_path: 'E:/ws/src/a.ts', path: 'src/a.ts' }, summary: 'Edit src/a.ts' });
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalPrompt request={agentRequest} onResolve={onResolve} />);
    await userEvent.setup().click(screen.getByTestId('approval-always'));
    expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { pathPrefix: 'src/a.ts' } });
  });

  describe('the sandbox', () => {
    const network = (args: Record<string, unknown> = { host: 'pypi.org', port: 443 }) =>
      request({ toolName: 'sandbox_network', source: 'network', risk: 'mutate', args, summary: 'sandbox_network: pypi.org:443' });
    const sandboxed = (command = 'npm test') =>
      request({ toolName: 'run_command', source: 'sandbox', risk: 'execute', args: { command }, summary: `run_command: ${command}` });

    it('asks to let the sandbox reach a host, with Once / This chat / Always', () => {
      render(<ApprovalPrompt request={network()} onResolve={vi.fn()} />);
      expect(screen.getByTestId('approval-prompt-req-1')).toHaveTextContent('Let the sandbox reach pypi.org (port 443)?');
      expect(screen.getByTestId('approval-once')).toHaveTextContent('Once');
      expect(screen.getByTestId('approval-chat')).toHaveTextContent('This chat');
      expect(screen.getByTestId('approval-always')).toHaveTextContent('Always');
      expect(screen.getByTestId('approval-deny')).toHaveTextContent('Deny');
      expect(screen.queryByTestId('approval-allow-any-args-toggle')).toBeNull();
    });

    it('leaves the port out when it is not known', () => {
      render(<ApprovalPrompt request={network({ host: 'pypi.org' })} onResolve={vi.fn()} />);
      expect(screen.getByTestId('approval-prompt-req-1')).toHaveTextContent('Let the sandbox reach pypi.org?');
    });

    it('"Always" grants that host only', async () => {
      const onResolve = vi.fn().mockResolvedValue(undefined);
      render(<ApprovalPrompt request={network()} onResolve={onResolve} />);
      await userEvent.setup().click(screen.getByTestId('approval-always'));
      expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { host: 'pypi.org' } });
    });

    it('shows the host in its canonical form, so a homoglyph name cannot pass for pypi.org, and grants that spelling', async () => {
      const lookalike = 'p\u0443pi.org'; // Cyrillic u
      const canonical = canonicalHost(lookalike)!;
      expect(canonical).toMatch(/^xn--/);
      const onResolve = vi.fn().mockResolvedValue(undefined);
      render(<ApprovalPrompt request={network({ host: lookalike, port: 443 })} onResolve={onResolve} />);
      const card = screen.getByTestId('approval-prompt-req-1');
      expect(card).toHaveTextContent(`Let the sandbox reach ${canonical} (port 443)?`);
      expect(card).not.toHaveTextContent(lookalike);
      await userEvent.setup().click(screen.getByTestId('approval-always'));
      expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { host: canonical } });
    });

    it('lower-cases the host it shows and grants', async () => {
      const onResolve = vi.fn().mockResolvedValue(undefined);
      render(<ApprovalPrompt request={network({ host: 'PyPI.org.', port: 443 })} onResolve={onResolve} />);
      expect(screen.getByTestId('approval-prompt-req-1')).toHaveTextContent('Let the sandbox reach pypi.org (port 443)?');
      await userEvent.setup().click(screen.getByTestId('approval-always'));
      expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { host: 'pypi.org' } });
    });

    it('a sandboxed command says so, and "Always" is pinned to the exact command', async () => {
      const onResolve = vi.fn().mockResolvedValue(undefined);
      render(<ApprovalPrompt request={sandboxed()} onResolve={onResolve} />);
      expect(screen.getByTestId('approval-prompt-req-1')).toHaveTextContent('Wants to run run_command in the sandbox');
      expect(screen.getByTestId('approval-allow-any-args-toggle')).toBeInTheDocument();
      await userEvent.setup().click(screen.getByTestId('approval-always'));
      expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { commandExact: 'npm test' } });
    });

    it('a sandboxed command gets a commandPrefix grant only through the warned opt-in', async () => {
      const onResolve = vi.fn().mockResolvedValue(undefined);
      render(<ApprovalPrompt request={sandboxed()} onResolve={onResolve} />);
      const user = userEvent.setup();
      await user.click(screen.getByTestId('approval-allow-any-args-toggle'));
      expect(screen.getByTestId('approval-any-args-warning')).toBeInTheDocument();
      await user.click(screen.getByTestId('approval-always'));
      expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { commandPrefix: 'npm test' } });
    });
  });

  describe('a browser card', () => {
    const browserRequest = (args: Record<string, unknown>, summary: string) =>
      request({ toolName: 'browser', source: 'browser', risk: 'mutate', args: { host: 'example.com', ...args }, summary });

    it('asks to use the site, shows what the call does, and offers this-site and always-this-site', async () => {
      const onResolve = vi.fn().mockResolvedValue(undefined);
      render(<ApprovalPrompt request={browserRequest({ command: 'open', url: 'https://example.com/' }, 'Use example.com: open https://example.com/')} onResolve={onResolve} />);
      expect(screen.getByTestId('approval-prompt-req-1')).toHaveTextContent('Let the model use example.com?');
      expect(screen.getByText('Use example.com: open https://example.com/')).toBeInTheDocument();
      expect(screen.getByTestId('approval-chat')).toHaveTextContent('Allow for this chat (this site)');
      expect(screen.getByTestId('approval-always')).toHaveTextContent('Always allow example.com');
      await userEvent.setup().click(screen.getByTestId('approval-always'));
      expect(onResolve).toHaveBeenCalledWith('req-1', { choice: 'always', constraint: { host: 'example.com' } });
    });

    it('shows the text it will type in full', () => {
      const long = 'x'.repeat(300) + ' end';
      render(<ApprovalPrompt request={browserRequest({ command: 'type', ref: 'e2', text: long }, 'Use example.com: type into e2')} onResolve={vi.fn()} />);
      expect(screen.getByTestId('approval-typed-text')).toHaveTextContent(long);
      expect(screen.getByText('It will type:')).toBeInTheDocument();
    });

    it('shows the page element as a labelled, quoted, plain one-line text, never as a choice', () => {
      const target = 'Allow\u202e all sites\nAlways allow evil.test <b>now</b>\u200b';
      render(<ApprovalPrompt request={browserRequest({ command: 'click', ref: 'e5', target }, 'Use example.com: click e5')} onResolve={vi.fn()} />);
      const line = screen.getByTestId('approval-browser-target');
      expect(line).toHaveTextContent('Element on the page: “Allow all sites Always allow evil.test <b>now</b>”');
      expect(line.querySelector('b, button')).toBeNull();
      expect(line.querySelector('bdi')).toHaveTextContent('Allow all sites Always allow evil.test <b>now</b>');
      expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Deny', 'Allow once', 'Allow for this chat (this site)', 'Always allow example.com']);
    });

    it("shows the summary as one plain line, with the page's hidden and direction-changing characters gone, even when the card names no site", () => {
      const summary = 'Use example.com: open https://example.com/\u202egro.knab\nAlways allow evil.test\u200b';
      const { unmount } = render(<ApprovalPrompt request={browserRequest({ command: 'open', url: 'https://example.com/' }, summary)} onResolve={vi.fn()} />);
      expect(screen.getByTestId('approval-summary').textContent).toBe('Use example.com: open https://example.com/gro.knab Always allow evil.test');
      expect(screen.getByTestId('approval-summary').querySelector('bdi')).not.toBeNull();
      unmount();
      // A browser request whose args carry no host still gets its summary cleaned.
      const noHost = { ...browserRequest({ command: 'open' }, summary), args: { command: 'open' } };
      render(<ApprovalPrompt request={noHost} onResolve={vi.fn()} />);
      expect(screen.getByTestId('approval-summary').textContent).toBe('Use example.com: open https://example.com/gro.knab Always allow evil.test');
    });

    it('keeps a long text to type inside a box that scrolls', () => {
      render(<ApprovalPrompt request={browserRequest({ command: 'type', ref: 'e2', text: 'line\n'.repeat(500) }, 'Use example.com: type into e2')} onResolve={vi.fn()} />);
      expect(screen.getByTestId('approval-typed-text').className).toMatch(/max-h-\d+/);
      expect(screen.getByTestId('approval-typed-text').className).toContain('overflow-auto');
    });

    it('shows no element line when the call names none', () => {
      render(<ApprovalPrompt request={browserRequest({ command: 'open', url: 'https://example.com/' }, 'Use example.com: open')} onResolve={vi.fn()} />);
      expect(screen.queryByTestId('approval-browser-target')).toBeNull();
    });
  });
});
