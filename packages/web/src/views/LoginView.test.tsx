import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { auth: { status: vi.fn(), login: vi.fn(), logout: vi.fn(), logoutAll: vi.fn(), changePassword: vi.fn() } } };
});

import { api, ApiError } from '../state/api.js';
import { useAuthStore } from '../state/auth.js';
import { LoginView } from './LoginView.js';

beforeEach(() => {
  useAuthStore.setState({ ...useAuthStore.getInitialState(), status: 'signed-out', mode: 'login', info: { mode: 'login', signedIn: false } }, true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function submit(password: string, remember = false): void {
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  if (remember) fireEvent.click(screen.getByLabelText('Keep me signed in on this device'));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginView', () => {
  it('shows "Wrong password." and the lock message from the server', async () => {
    render(<LoginView />);
    vi.mocked(api.auth.login).mockRejectedValueOnce(new ApiError(401, 'Wrong password.'));
    submit('not the password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password.');

    vi.mocked(api.auth.login).mockRejectedValueOnce(new ApiError(429, 'Too many tries. Try again in 14 minutes.'));
    submit('not the password');
    expect(await screen.findByText('Too many tries. Try again in 14 minutes.')).toBeInTheDocument();
  });

  it('sends the remember flag, off by default', async () => {
    render(<LoginView />);
    vi.mocked(api.auth.login).mockResolvedValue({ expiresAt: 1 });
    vi.mocked(api.auth.status).mockResolvedValue({ mode: 'login', signedIn: true });

    submit('a long password');
    await vi.waitFor(() => expect(api.auth.login).toHaveBeenLastCalledWith('a long password', false));
    // The button reads "Signing in…" until the first attempt settles.
    await screen.findByRole('button', { name: 'Sign in' });
    submit('a long password', true);
    await vi.waitFor(() => expect(api.auth.login).toHaveBeenLastCalledWith('a long password', true));
  });

  it('lets password managers save it: a hidden username and current-password', () => {
    const { container } = render(<LoginView />);

    expect(container.querySelector('input[name="username"]')).toHaveValue('otherbench');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it("offers OtherBench's certificate only when the server has one to give", () => {
    const { rerender } = render(<LoginView />);
    expect(screen.queryByRole('link', { name: "Download OtherBench's certificate" })).toBeNull();

    useAuthStore.setState({ info: { mode: 'login', signedIn: false, caDownload: true } });
    rerender(<LoginView />);
    expect(screen.getByRole('link', { name: "Download OtherBench's certificate" })).toHaveAttribute('href', '/otherbench-ca.crt');
    expect(screen.getByText(/Check its fingerprint against the one the server printed when it started\./)).toBeInTheDocument();
  });
});
