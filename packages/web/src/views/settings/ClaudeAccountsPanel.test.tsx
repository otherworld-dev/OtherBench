import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView } from '@otherbench/core/types/claude-accounts.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      claude: {
        accounts: { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn(), signIn: vi.fn(), submitCode: vi.fn(), signOut: vi.fn() },
      },
    },
  };
});

import { ApiError, api } from '../../state/api.js';
import { useClaudeAccounts } from '../../state/claudeAccounts.js';
import { useToasts } from '../../lib/toasts.js';
import { ClaudeAccountsPanel, SIGN_IN_POLL_MS } from './ClaudeAccountsPanel.js';

const accounts = vi.mocked(api.claude.accounts);

function account(over: Partial<AccountView> = {}): AccountView {
  return { slug: 'main', name: 'Main', colour: null, configDir: null, main: true, limitedUntil: null, signedIn: true, email: 'me@example.com', subscriptionType: 'max', signingIn: false, ...over };
}
const VH = (over: Partial<AccountView> = {}) =>
  account({ slug: 'vh', name: 'VH', colour: '#ff8800', configDir: 'C:\\claude\\vh', main: false, signedIn: false, email: null, subscriptionType: null, ...over });

function card(slug: string): HTMLElement {
  return screen.getByTestId(`claude-account-${slug}`);
}

beforeEach(() => {
  for (const fn of Object.values(accounts)) fn.mockReset();
  useClaudeAccounts.setState({ accounts: [] });
  useToasts.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ClaudeAccountsPanel', () => {
  it('shows a card per account with its name, email or Signed out, and folder; main cannot be removed', async () => {
    accounts.list.mockResolvedValue({ accounts: [account(), VH()] });
    render(<ClaudeAccountsPanel />);
    expect(await screen.findByTestId('claude-account-main')).toHaveTextContent('me@example.com');
    expect(card('main')).toHaveTextContent('Main');
    expect(card('main')).toHaveTextContent('Default folder');
    expect(within(card('main')).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(card('vh')).toHaveTextContent('Signed out');
    expect(card('vh')).toHaveTextContent('C:\\claude\\vh');
    expect(within(card('vh')).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('asks before signing main out, and says it also signs out Claude Code in the terminal', async () => {
    accounts.list.mockResolvedValue({ accounts: [account()] });
    accounts.signOut.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ClaudeAccountsPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(confirm.mock.calls[0]?.[0]).toContain('also signs out Claude Code in your terminal');
    expect(accounts.signOut).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(accounts.signOut).toHaveBeenCalledWith('main');
  });

  it('adds an account with a name and colour', async () => {
    accounts.list.mockResolvedValue({ accounts: [account()] });
    accounts.add.mockResolvedValue({ account: VH() });
    render(<ClaudeAccountsPanel />);
    const user = userEvent.setup();
    await screen.findByTestId('claude-account-main');
    await user.type(screen.getByLabelText('Account name'), 'VH');
    await user.click(screen.getByRole('button', { name: 'Add account' }));
    expect(accounts.add).toHaveBeenCalledTimes(1);
    expect(accounts.add.mock.calls[0]?.[0]).toEqual({ name: 'VH', colour: expect.stringMatching(/^#[0-9a-f]{6}$/i) });
    await waitFor(() => expect(accounts.list).toHaveBeenCalledTimes(2));
  });

  it('adds an account on an existing folder, and shows the server error', async () => {
    accounts.list.mockResolvedValue({ accounts: [account()] });
    accounts.add.mockRejectedValueOnce(new ApiError(400, 'That folder is already an account'));
    render(<ClaudeAccountsPanel />);
    const user = userEvent.setup();
    await screen.findByTestId('claude-account-main');
    await user.type(screen.getByLabelText('Account name'), 'VH');
    await user.click(screen.getByLabelText('Use an existing folder'));
    await user.type(screen.getByLabelText('Folder'), 'C:\\claude\\vh');
    await user.click(screen.getByRole('button', { name: 'Add account' }));
    expect(accounts.add.mock.calls[0]?.[0]).toMatchObject({ name: 'VH', configDir: 'C:\\claude\\vh' });
    expect(await screen.findByRole('alert')).toHaveTextContent('That folder is already an account');
  });

  it('shows the sign-in link and a paste-code field while signing in, and submits the code', async () => {
    accounts.list.mockResolvedValueOnce({ accounts: [account(), VH()] });
    accounts.signIn.mockResolvedValue({ url: 'https://claude.ai/oauth/x' });
    accounts.list.mockResolvedValue({ accounts: [account(), VH({ signingIn: true })] });
    accounts.submitCode.mockResolvedValue(undefined);
    render(<ClaudeAccountsPanel />);
    const user = userEvent.setup();
    await user.click(await within(await screen.findByTestId('claude-account-vh')).findByRole('button', { name: 'Sign in' }));
    expect(accounts.signIn).toHaveBeenCalledWith('vh');
    expect(await within(card('vh')).findByText('Waiting for sign-in…')).toBeInTheDocument();
    const link = within(card('vh')).getByRole('link', { name: 'Open the sign-in page' });
    expect(link).toHaveAttribute('href', 'https://claude.ai/oauth/x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    await user.type(within(card('vh')).getByLabelText('Paste code'), 'abc#123');
    await user.click(within(card('vh')).getByRole('button', { name: 'Submit' }));
    expect(accounts.submitCode).toHaveBeenCalledWith('vh', 'abc#123');
  });

  it("toasts an error when the sign-in gave no page and isn't running", async () => {
    accounts.list.mockResolvedValue({ accounts: [account(), VH()] });
    accounts.signIn.mockResolvedValue({ url: null });
    render(<ClaudeAccountsPanel />);
    await userEvent.setup().click(await within(await screen.findByTestId('claude-account-vh')).findByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(useToasts.getState().toasts).toMatchObject([{ tone: 'error', text: "Couldn't start the Claude sign-in." }]));
  });

  it('polls the list every 2 s while an account is signing in, and stops when it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    accounts.list.mockResolvedValue({ accounts: [account(), VH({ signingIn: true })] });
    render(<ClaudeAccountsPanel />);
    expect(await screen.findByText('Waiting for sign-in…')).toBeInTheDocument();
    const before = accounts.list.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)));
    expect(accounts.list.mock.calls.length).toBe(before + 1);
    accounts.list.mockResolvedValue({ accounts: [account(), VH({ signedIn: true, email: 'vh@example.com' })] });
    await act(async () => void (await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)));
    expect(await screen.findByText('vh@example.com')).toBeInTheDocument();
    const after = accounts.list.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS * 3)));
    expect(accounts.list.mock.calls.length).toBe(after);
    expect(SIGN_IN_POLL_MS).toBe(2000);
  });
});
