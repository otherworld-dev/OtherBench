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
    expect(screen.getByText('nextcloud (connected)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy resume command' }));
    expect(writeText).toHaveBeenCalledWith('cd "E:\\Git\\proj" && claude --resume new-session');
  });
  it('builds the resume command', () => {
    expect(resumeCommand({ engine: 'claude_code', sessionId: 's', backend: 'claude', cwd: '/ws' })).toBe('cd "/ws" && claude --resume s');
  });
});
