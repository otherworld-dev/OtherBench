import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView } from '@otherbench/core/types/claude-accounts.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';

vi.mock('../state/api.js', () => ({ api: { claude: { planUsage: vi.fn(), accounts: { list: vi.fn() } } } }));

import { api } from '../state/api.js';
import { useClaudeAccounts } from '../state/claudeAccounts.js';
import { ClaudeAccountsStrip } from './ClaudeAccountsStrip.js';

const planUsage = vi.mocked(api.claude.planUsage);
const at = (h: number, m: number) => new Date(2026, 9, 28, h, m).getTime();
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const account = (over: Partial<AccountView>): AccountView => ({
  slug: 'main', name: 'Main', colour: null, configDir: null, main: true, limitedUntil: null, signedIn: true, email: null, subscriptionType: null, signingIn: false, ...over,
});
const reading = (five: number, week: number): PlanUsage => ({
  fetchedAt: at(13, 0),
  windows: [
    { id: 'five_hour', label: '5-hour', percent: five, resetsAt: at(15, 10) },
    { id: 'seven_day', label: 'Weekly', percent: week, resetsAt: null },
  ],
});
const settle = () => act(async () => {});

describe('ClaudeAccountsStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planUsage.mockReset();
    useClaudeAccounts.setState({ accounts: [] });
  });
  afterEach(cleanup);

  it('shows a row per account with its figures and the limited time', async () => {
    const limitedUntil = at(15, 10);
    useClaudeAccounts.setState({
      accounts: [account({}), account({ slug: 'vh', name: 'VH', colour: '#ff0000', main: false, configDir: '/x', limitedUntil: Date.now() + 3_600_000 })],
    });
    planUsage.mockImplementation(async (_r, slug) => ({ usage: slug === 'vh' ? reading(100, 10) : reading(42, 81) }));
    render(<ClaudeAccountsStrip refreshKey={0} />);
    await settle();
    const main = screen.getByTestId('claude-account-main');
    expect(main.textContent).toContain('Main');
    expect(main.textContent).toContain('5h 42%');
    expect(screen.getByText('week 81%').className).toContain('text-[var(--warn)]');
    const vh = screen.getByTestId('claude-account-vh');
    expect(vh.textContent).toContain('5h 100%');
    expect(vh.textContent).toMatch(/Limited until/);
    expect(limitedUntil).toBeGreaterThan(0);
    expect(planUsage).toHaveBeenCalledWith(false, 'vh');
    expect(time(limitedUntil)).toBeTruthy();
  });

  it('renders nothing for a lone main account with no reading', async () => {
    useClaudeAccounts.setState({ accounts: [account({})] });
    planUsage.mockResolvedValue({ usage: null });
    const { container } = render(<ClaudeAccountsStrip refreshKey={0} />);
    await settle();
    expect(container.textContent).toBe('');
  });

  it('shows a dash for an account whose read fails and still shows the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useClaudeAccounts.setState({ accounts: [account({}), account({ slug: 'vh', name: 'VH', main: false, configDir: '/x' })] });
    planUsage.mockImplementation(async (_r, slug) => {
      if (slug === 'vh') throw new Error('boom');
      return { usage: reading(1, 2) };
    });
    render(<ClaudeAccountsStrip refreshKey={0} />);
    await settle();
    expect(screen.getByTestId('claude-account-main').textContent).toContain('5h 1%');
    expect(screen.getByTestId('claude-account-vh').textContent).toContain('—');
  });

  it('loads the accounts when the store is empty and reads again when the refresh key changes', async () => {
    vi.mocked(api.claude.accounts.list).mockResolvedValue({ accounts: [account({})] });
    planUsage.mockResolvedValue({ usage: reading(1, 2) });
    const { rerender } = render(<ClaudeAccountsStrip refreshKey={0} />);
    await settle();
    expect(api.claude.accounts.list).toHaveBeenCalled();
    const calls = planUsage.mock.calls.length;
    rerender(<ClaudeAccountsStrip refreshKey={1} />);
    await settle();
    expect(planUsage.mock.calls.length).toBeGreaterThan(calls);
  });
});
