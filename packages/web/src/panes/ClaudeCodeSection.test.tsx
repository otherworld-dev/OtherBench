import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { useOtherBenchStore } from '../state/store.js';
import type { AccountView } from '@otherbench/core/types/claude-accounts.js';
import { useClaudeAccounts } from '../state/claudeAccounts.js';

vi.mock('../state/api.js', () => ({
  api: { chats: { patch: vi.fn() }, claude: { accounts: { list: vi.fn(async () => ({ accounts: [] })) } } },
}));

import { api } from '../state/api.js';
import { ClaudeCodeSection, isWindowsPlatform, resumeCommand } from './ClaudeCodeSection.js';

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

const acct = (slug: string, name: string, extra: Partial<AccountView> = {}): AccountView => ({
  slug, name, colour: null, configDir: null, main: slug === 'main', limitedUntil: null, signedIn: true, email: null, subscriptionType: null, signingIn: false, ...extra,
});
const MAIN = acct('main', 'Main');
const VH = acct('vh', 'VH', { colour: '#e0a030', configDir: 'C:\\acc\\vh' });

function loginChat(extra: Record<string, unknown> = {}): void {
  useOtherBenchStore.setState({
    chats: [{ id: 'c1', profileId: 'p1', claudeAccount: null, accountAutoSwitch: false, ...extra }] as never,
    profiles: [{ id: 'p1', connectionId: 'k1' }] as never,
    connections: [{ id: 'k1', kind: 'claude_code' }] as never,
    messages: {},
  });
}

describe('ClaudeCodeSection account controls', () => {
  const patch = vi.mocked(api.chats.patch);
  beforeEach(() => {
    patch.mockReset().mockImplementation(async (_id, body) => ({ id: 'c1', profileId: 'p1', ...body }) as never);
    useClaudeAccounts.setState({ accounts: [MAIN, VH] });
  });

  it('lists Default then each account, and patches the pick', async () => {
    loginChat();
    render(<ClaudeCodeSection chatId="c1" />);
    const select = screen.getByLabelText('Account');
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Default (Main, overflow to others)', 'Main', 'VH']);
    await userEvent.selectOptions(select, 'vh');
    expect(patch).toHaveBeenLastCalledWith('c1', { claudeAccount: 'vh' });
    await userEvent.selectOptions(select, '');
    expect(patch).toHaveBeenLastCalledWith('c1', { claudeAccount: null });
  });

  it('patches the Switch automatically checkbox', async () => {
    loginChat();
    render(<ClaudeCodeSection chatId="c1" />);
    await userEvent.click(screen.getByLabelText('Switch automatically'));
    expect(patch).toHaveBeenLastCalledWith('c1', { accountAutoSwitch: true });
  });

  it('shows a missing account', () => {
    loginChat({ claudeAccount: 'gone' });
    render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.getByLabelText('Account')).toHaveValue('gone');
    expect(screen.getByRole('option', { name: 'gone (missing)' })).toBeInTheDocument();
  });

  it('shows nothing for a chat that is not a Claude-login chat, or before the accounts load', () => {
    loginChat();
    useOtherBenchStore.setState({ connections: [{ id: 'k1', kind: 'claude_code', baseUrl: 'http://x' }] as never });
    const { unmount } = render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.queryByLabelText('Account')).toBeNull();
    unmount();
    loginChat();
    useClaudeAccounts.setState({ accounts: [] });
    render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.queryByLabelText('Account')).toBeNull();
    expect(vi.mocked(api.claude.accounts.list)).toHaveBeenCalled();
  });

  it("shows the latest reply's account", () => {
    loginChat();
    const m = msg('a', 1, 's');
    useOtherBenchStore.setState({ messages: { a: { ...m, engineMeta: { ...m.engineMeta!, account: 'vh', backend: 'claude:vh' } } } });
    render(<ClaudeCodeSection chatId="c1" />);
    expect(screen.getByText('Account: VH')).toBeInTheDocument();
  });

  it("disables copy when the reply's account isn't set up here", () => {
    loginChat();
    const m = msg('a', 1, 's');
    useOtherBenchStore.setState({ messages: { a: { ...m, engineMeta: { ...m.engineMeta!, account: 'gone', backend: 'claude:gone' } } } });
    render(<ClaudeCodeSection chatId="c1" />);
    const button = screen.getByRole('button', { name: 'Copy resume command' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', "This reply's Claude account isn't set up on this machine.");
  });

  it('builds the resume command per platform', () => {
    const meta = { engine: 'claude_code' as const, sessionId: 's', backend: 'claude:vh', account: 'vh', cwd: 'E:\\p' };
    expect(resumeCommand(meta, { windows: true, configDir: 'C:\\acc\\vh' })).toBe("$env:CLAUDE_CONFIG_DIR = 'C:\\acc\\vh'; cd 'E:\\p'; claude --resume s");
    expect(resumeCommand(meta, { windows: false, configDir: '/acc/vh' })).toBe("cd 'E:\\p' && CLAUDE_CONFIG_DIR='/acc/vh' claude --resume s");
    expect(resumeCommand({ ...meta, account: undefined }, { windows: true, configDir: null })).toBe('cd "E:\\p" && claude --resume s');
    expect(resumeCommand({ ...meta, cwd: "/it's $HOME" }, { windows: true, configDir: "/a'b" })).toBe(`$env:CLAUDE_CONFIG_DIR = '/a''b'; cd '/it''s $HOME'; claude --resume s`);
    expect(resumeCommand({ ...meta, cwd: "/it's $HOME" }, { windows: false, configDir: "/a'b" })).toBe(`cd '/it'\\''s $HOME' && CLAUDE_CONFIG_DIR='/a'\\''b' claude --resume s`);
    expect(resumeCommand(meta, { windows: false, configDir: null })).toBeNull();
    expect(isWindowsPlatform('Mozilla/5.0 (Windows NT 10.0)')).toBe(true);
    expect(isWindowsPlatform('Mozilla/5.0 (X11; Linux)')).toBe(false);
  });
});
