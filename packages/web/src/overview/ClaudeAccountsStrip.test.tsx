import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView } from '@otherbench/core/types/claude-accounts.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';

vi.mock('../state/api.js', () => ({ api: { claude: { planUsage: vi.fn(), accounts: { list: vi.fn() } } } }));

import { api } from '../state/api.js';
import { useClaudeAccounts } from '../state/claudeAccounts.js';
import { formatReset, PLAN_USAGE_POLL_MS } from '../components/PlanUsageMeter.js';
import { ClaudeAccountsStrip } from './ClaudeAccountsStrip.js';

const planUsage = vi.mocked(api.claude.planUsage);
const at = (h: number, m: number) => new Date(2026, 9, 28, h, m).getTime();

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
    // A reload gives back what the test put in the store, unless it says otherwise.
    vi.mocked(api.claude.accounts.list).mockImplementation(async () => ({ accounts: useClaudeAccounts.getState().accounts }));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows a row per account with its figures and the limited time', async () => {
    const now = at(13, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const limitedUntil = at(15, 10);
    useClaudeAccounts.setState({
      accounts: [account({}), account({ slug: 'vh', name: 'VH', colour: '#ff0000', main: false, configDir: '/x', limitedUntil })],
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
    expect(vh.textContent).toContain(`Limited until ${formatReset(limitedUntil, now)}`);
    expect(planUsage).toHaveBeenCalledWith(false, 'vh');
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
    expect(planUsage.mock.calls.at(-1)?.[0]).toBe(true);
  });

  it('keeps the last good reading when a later poll fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    useClaudeAccounts.setState({ accounts: [account({})] });
    planUsage.mockResolvedValueOnce({ usage: reading(42, 81) }).mockRejectedValue(new Error('boom'));
    render(<ClaudeAccountsStrip refreshKey={0} />);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAN_USAGE_POLL_MS);
    });
    expect(planUsage).toHaveBeenCalledTimes(2);
    const row = screen.getByTestId('claude-account-main').textContent;
    expect(row).toContain('5h 42%');
    expect(row).not.toContain('—');
  });

  it('colours the dot: main muted, a colourless non-main account accent', async () => {
    useClaudeAccounts.setState({ accounts: [account({}), account({ slug: 'vh', name: 'VH', main: false, configDir: '/x', colour: null })] });
    planUsage.mockResolvedValue({ usage: reading(1, 2) });
    render(<ClaudeAccountsStrip refreshKey={0} />);
    await settle();
    const dot = (slug: string) => (screen.getByTestId(`claude-account-${slug}`).querySelector('[aria-hidden]') as HTMLElement).style.background;
    expect(dot('main')).toBe('var(--text-muted)');
    expect(dot('vh')).toBe('var(--accent)');
  });

  it('reloads the accounts after each read, so a hold the reading set shows as "Limited until"', async () => {
    const now = at(13, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const limitedUntil = at(15, 10);
    useClaudeAccounts.setState({ accounts: [account({})] });
    planUsage.mockResolvedValue({ usage: reading(100, 10) });
    vi.mocked(api.claude.accounts.list).mockResolvedValue({ accounts: [account({ limitedUntil })] });
    const { rerender } = render(<ClaudeAccountsStrip refreshKey={0} />);
    await settle();
    expect(api.claude.accounts.list).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('claude-account-main').textContent).toContain(`Limited until ${formatReset(limitedUntil, now)}`);

    // The Overview's refresh reads again, and reloads again.
    vi.mocked(api.claude.accounts.list).mockResolvedValue({ accounts: [account({})] });
    rerender(<ClaudeAccountsStrip refreshKey={1} />);
    await settle();
    expect(api.claude.accounts.list).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('claude-account-main').textContent).not.toContain('Limited until');
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers();
    useClaudeAccounts.setState({ accounts: [account({})] });
    planUsage.mockResolvedValue({ usage: reading(1, 2) });
    const { unmount } = render(<ClaudeAccountsStrip refreshKey={0} />);
    await settle();
    expect(planUsage).toHaveBeenCalledTimes(1);
    unmount();
    await vi.advanceTimersByTimeAsync(PLAN_USAGE_POLL_MS * 2);
    expect(planUsage).toHaveBeenCalledTimes(1);
  });
});
