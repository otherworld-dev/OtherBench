import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView } from '@otherbench/core/types/claude-accounts.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { useClaudeAccounts } from '../state/claudeAccounts.js';
import { useOtherBenchStore } from '../state/store.js';
import { useToasts } from '../lib/toasts.js';

vi.mock('../state/api.js', () => ({
  api: { chats: { continueOnAccount: vi.fn() }, claude: { accounts: { list: vi.fn(async () => ({ accounts: [] })) } } },
}));

import { api } from '../state/api.js';
import { Message } from './Message.js';

const view = (slug: string, name: string): AccountView => ({
  slug, name, colour: null, configDir: null, main: slug === 'main', limitedUntil: null, signedIn: true, email: null, subscriptionType: null, signingIn: false,
});
const cutOff = (extra: Partial<CanonMessage> = {}): CanonMessage => ({
  id: 'm1', chatId: 'c1', parentId: 'u1', role: 'assistant', parts: [], status: 'error',
  error: { kind: 'rate_limit', message: 'limit', retryable: true },
  producedBy: { profileId: 'p1', profileName: 'CC', connectionId: 'k1', modelId: 'x' }, createdAt: 0, ...extra,
});

function setup(connection: Record<string, unknown> = {}): void {
  useOtherBenchStore.setState({
    chats: [{ id: 'c1', profileId: 'p1' }] as never,
    profiles: [{ id: 'p1', connectionId: 'k1' }] as never,
    connections: [{ id: 'k1', kind: 'claude_code', ...connection }] as never,
  });
}

describe('Continue on <account>', () => {
  const cont = vi.mocked(api.chats.continueOnAccount);
  beforeEach(() => {
    cont.mockReset().mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['m2'] });
    useClaudeAccounts.setState({ accounts: [view('main', 'Main'), view('vh', 'VH')] });
    setup();
  });
  afterEach(cleanup);

  it('offers the other account on a rate-limited reply and continues on click', async () => {
    render(<Message message={cutOff()} />);
    expect(screen.queryByRole('button', { name: 'Continue on Main' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Continue on VH' }));
    expect(cont).toHaveBeenCalledWith('c1', { messageId: 'm1', account: 'vh' });
  });

  it('skips the account that produced the reply', () => {
    render(<Message message={cutOff({ engineMeta: { engine: 'claude_code', sessionId: 's', backend: 'claude:vh', account: 'vh', cwd: '/w' } })} />);
    expect(screen.queryByRole('button', { name: 'Continue on VH' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue on Main' })).toBeInTheDocument();
  });

  it('is absent with only main, for other errors and for an endpoint chat', () => {
    useClaudeAccounts.setState({ accounts: [view('main', 'Main')] });
    const { unmount } = render(<Message message={cutOff()} />);
    expect(screen.queryByRole('button', { name: /Continue on/ })).toBeNull();
    unmount();
    useClaudeAccounts.setState({ accounts: [view('main', 'Main'), view('vh', 'VH')] });
    const r = render(<Message message={cutOff({ error: { kind: 'auth', message: 'no', retryable: false } })} />);
    expect(screen.queryByRole('button', { name: /Continue on/ })).toBeNull();
    r.unmount();
    setup({ baseUrl: 'http://x' });
    render(<Message message={cutOff()} />);
    expect(screen.queryByRole('button', { name: /Continue on/ })).toBeNull();
  });

  it('loads the accounts when none are loaded yet (a chat opened before Settings or the Overview)', async () => {
    useClaudeAccounts.setState({ accounts: [] });
    vi.mocked(api.claude.accounts.list).mockResolvedValueOnce({ accounts: [view('main', 'Main'), view('vh', 'VH')] });
    render(<Message message={cutOff()} />);
    expect(await screen.findByRole('button', { name: 'Continue on VH' })).toBeInTheDocument();
    expect(api.claude.accounts.list).toHaveBeenCalled();
  });

  it('toasts when the continue fails', async () => {
    cont.mockRejectedValue(new Error('boom'));
    useToasts.setState({ toasts: [] });
    render(<Message message={cutOff()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue on VH' }));
    expect(useToasts.getState().toasts[0]?.text).toContain('boom');
  });
});
