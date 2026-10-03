import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { useGruntStore } from '../state/store.js';
import { ClaudeCodeSection, resumeCommand } from './ClaudeCodeSection.js';

afterEach(cleanup);
const msg = (id: string, createdAt: number, sessionId?: string): CanonMessage => ({ id, chatId: 'c1', parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null, createdAt, ...(sessionId ? { engineMeta: { engine: 'claude_code', sessionId, backend: 'claude', cwd: 'E:\\Git\\proj', tools: ['Read', 'Edit'], mcpServers: [{ name: 'nextcloud', status: 'connected' }] } } : {}) });

describe('ClaudeCodeSection', () => {
  it('renders nothing for a chat without Claude Code turns', () => {
    useGruntStore.setState({ messages: { a: msg('a', 1) } });
    const { container } = render(<ClaudeCodeSection chatId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows the latest session with backend, tools, MCP servers and a copyable resume command', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useGruntStore.setState({ messages: { a: msg('a', 1, 'old'), b: msg('b', 2, 'new-session') } });
    render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.getByText('new-session')).toBeInTheDocument();
    expect(screen.getByText('Claude login')).toBeInTheDocument();
    expect(screen.getByText('Read, Edit')).toBeInTheDocument();
    expect(screen.getByText('nextcloud · connected · 0 tools')).toBeInTheDocument();
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
    useGruntStore.setState({ messages: { a: m } });
    render(<ClaudeCodeSection chatId="c1" />);

    expect(screen.getByText('Read, Edit, Bash')).toBeInTheDocument();
    expect(screen.getByText('nextcloud · connected · 3 tools')).toBeInTheDocument();
    expect(screen.getByText('godot · failed · 1 tool')).toBeInTheDocument();
    // Tools whose server reported no status still get a line, with just the count.
    expect(screen.getByText('claude_ai_Claude_Docs · 2 tools')).toBeInTheDocument();
    // A connected server that exposed no tools is still listed.
    expect(screen.getByText('idle-server · connected · 0 tools')).toBeInTheDocument();

    // Raw mcp__ names never render; the short names stay hidden until the server line is opened.
    expect(screen.queryByText(/mcp__/)).toBeNull();
    expect(screen.getByText('deck_add_card, notes_list, cal_find')).not.toBeVisible();
    await userEvent.click(screen.getByText('nextcloud · connected · 3 tools'));
    expect(screen.getByText('deck_add_card, notes_list, cal_find')).toBeVisible();
  });

  it('builds the resume command', () => {
    expect(resumeCommand({ engine: 'claude_code', sessionId: 's', backend: 'claude', cwd: '/ws' })).toBe('cd "/ws" && claude --resume s');
  });
});
