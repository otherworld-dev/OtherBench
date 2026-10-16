import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { useOtherBenchStore } from '../state/store.js';
import { ClaudeCodeSection, resumeCommand } from './ClaudeCodeSection.js';

afterEach(cleanup);
const msg = (id: string, createdAt: number, sessionId?: string): CanonMessage => ({ id, chatId: 'c1', parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null, createdAt, ...(sessionId ? { engineMeta: { engine: 'claude_code', sessionId, backend: 'claude', cwd: 'E:\\Git\\proj', tools: ['Read', 'Edit'], mcpServers: [{ name: 'nextcloud', status: 'connected' }] } } : {}) });

describe('ClaudeCodeSection', () => {
  it('renders nothing for a chat without Claude Code turns', () => {
    useOtherBenchStore.setState({ messages: { a: msg('a', 1) } });
    const { container } = render(<ClaudeCodeSection chatId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows the latest session with backend, tools, MCP servers and a copyable resume command', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useOtherBenchStore.setState({ messages: { a: msg('a', 1, 'old'), b: msg('b', 2, 'new-session') } });
    render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.getByText('new-session')).toBeInTheDocument();
    expect(screen.getByText('Claude login')).toBeInTheDocument();
    expect(screen.getByText('2 built-in tools')).toBeInTheDocument();
    expect(screen.getByText('nextcloud · connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy resume command' }));
    expect(writeText).toHaveBeenCalledWith('cd "E:\\Git\\proj" && claude --resume new-session');
  });
  it('groups MCP tools into one line per server, collapsed until clicked', async () => {
    const tools = [
      'Read', 'Edit', 'Bash',
      'mcp__nextcloud__deck_add_card', 'mcp__nextcloud__notes_list', 'mcp__nextcloud__cal_find',
      'mcp__godot__run_project',
      'mcp__claude_ai_Claude_Docs__guide', 'mcp__claude_ai_Claude_Docs__read',
    ];
    const m: CanonMessage = {
      ...msg('a', 1, 's'),
      engineMeta: {
        engine: 'claude_code', sessionId: 's', backend: 'claude', cwd: '/ws', tools,
        mcpServers: [{ name: 'nextcloud', status: 'connected' }, { name: 'godot', status: 'failed' }, { name: 'idle-server', status: 'connected' }],
      },
    };
    useOtherBenchStore.setState({ messages: { a: m } });
    render(<ClaudeCodeSection chatId="c1" />);

    expect(screen.getByText('3 built-in tools')).toBeInTheDocument();
    expect(screen.getByText('nextcloud · connected · 3 tools')).toBeInTheDocument();
    expect(screen.getByText('godot · failed · 1 tool')).toBeInTheDocument();
    // Tools whose server reported no status still get a line, with just the count.
    expect(screen.getByText('claude_ai_Claude_Docs · 2 tools')).toBeInTheDocument();
    // A server that exposed no tools folds into the single summary line.
    expect(screen.getByText('1 more with no tools (needs sign-in or failed)')).toBeInTheDocument();
    expect(screen.queryByText('idle-server · connected · 0 tools')).toBeNull();

    // Raw mcp__ names never render; the short names stay hidden until the server line is opened.
    expect(screen.queryByText(/mcp__/)).toBeNull();
    expect(screen.getByText('deck_add_card, notes_list, cal_find')).not.toBeVisible();
    await userEvent.click(screen.getByText('nextcloud · connected · 3 tools'));
    expect(screen.getByText('deck_add_card, notes_list, cal_find')).toBeVisible();
  });

  const withMeta = (tools: string[], mcpServers: { name: string; status: string }[]): CanonMessage => ({
    ...msg('a', 1, 's'),
    engineMeta: { engine: 'claude_code', sessionId: 's', backend: 'claude', cwd: '/ws', tools, mcpServers },
  });

  it('collapses built-in tools into one summary line until expanded', async () => {
    useOtherBenchStore.setState({ messages: { a: withMeta(['Read', 'Edit', 'Bash'], []) } });
    render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.getByText('3 built-in tools')).toBeInTheDocument();
    expect(screen.getByText('Read, Edit, Bash')).not.toBeVisible();
    await userEvent.click(screen.getByText('3 built-in tools'));
    expect(screen.getByText('Read, Edit, Bash')).toBeVisible();
  });

  it('uses the singular for one built-in tool', () => {
    useOtherBenchStore.setState({ messages: { a: withMeta(['Read'], []) } });
    render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.getByText('1 built-in tool')).toBeInTheDocument();
  });

  it('hides zero-tool servers behind one counted summary, listed on expand', async () => {
    useOtherBenchStore.setState({
      messages: {
        a: withMeta(['Read', 'mcp__a__x'], [
          { name: 'a', status: 'connected' },
          { name: 'plugin:s:canva', status: 'needs-auth' },
          { name: 'broken', status: 'failed' },
          { name: 'pending-one', status: 'pending' },
        ]),
      },
    });
    render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.getByText('a · connected · 1 tool')).toBeInTheDocument();
    expect(screen.getAllByText(/more with no tools/)).toHaveLength(1);
    expect(screen.getByText('3 more with no tools (needs sign-in or failed)')).toBeInTheDocument();
    expect(screen.queryByText(/0 tools/)).toBeNull();
    expect(screen.getByText('plugin:s:canva · needs-auth')).not.toBeVisible();
    await userEvent.click(screen.getByText('3 more with no tools (needs sign-in or failed)'));
    expect(screen.getByText('plugin:s:canva · needs-auth')).toBeVisible();
    expect(screen.getByText('broken · failed')).toBeVisible();
  });

  it('shows only the summary when every server has zero tools, and no MCP row without servers', () => {
    useOtherBenchStore.setState({ messages: { a: withMeta(['Read'], [{ name: 'x', status: 'needs-auth' }, { name: 'y', status: 'failed' }]) } });
    const { unmount } = render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.getByText('2 more with no tools (needs sign-in or failed)')).toBeInTheDocument();
    expect(document.querySelectorAll('details')).toHaveLength(2);
    unmount();
    useOtherBenchStore.setState({ messages: { a: withMeta(['Read'], []) } });
    render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.queryByText('MCP')).toBeNull();
  });

  it('orders servers with tools by tool count desc, then name', () => {
    useOtherBenchStore.setState({
      messages: {
        a: withMeta(['mcp__b__1', 'mcp__a__1', 'mcp__c__1', 'mcp__c__2', 'mcp__c__3', 'mcp__d__1', 'mcp__d__2'], [
          { name: 'a', status: 'connected' }, { name: 'b', status: 'connected' }, { name: 'c', status: 'connected' }, { name: 'd', status: 'connected' },
        ]),
      },
    });
    render(<ClaudeCodeSection chatId="c1" />);
    const labels = [...document.querySelectorAll('summary')].map((s) => s.textContent);
    expect(labels).toEqual(['c · connected · 3 tools', 'd · connected · 2 tools', 'a · connected · 1 tool', 'b · connected · 1 tool']);
  });

  it('builds the resume command', () => {
    expect(resumeCommand({ engine: 'claude_code', sessionId: 's', backend: 'claude', cwd: '/ws' })).toBe('cd "/ws" && claude --resume s');
  });
});
