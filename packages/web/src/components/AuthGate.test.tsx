import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { auth: { status: vi.fn(), login: vi.fn(), logout: vi.fn(), logoutAll: vi.fn(), changePassword: vi.fn() } } };
});

import { api } from '../state/api.js';
import { useAuthStore } from '../state/auth.js';
import { reportUnauthorized } from '../state/transport.js';
import { AuthGate } from './AuthGate.js';

const status = vi.mocked(api.auth.status);
let mounts = 0;
function FakeApp(): JSX.Element {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div data-testid="app">app</div>;
}

beforeEach(() => {
  mounts = 0;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderGate = () => render(<AuthGate><FakeApp /></AuthGate>);

describe('AuthGate', () => {
  it('shows only the login page when signed out at load, and the app once signed in', async () => {
    status.mockResolvedValueOnce({ mode: 'login', signedIn: false });
    renderGate();

    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByTestId('app')).toBeNull();

    vi.mocked(api.auth.login).mockResolvedValueOnce({ expiresAt: 1 });
    status.mockResolvedValueOnce({ mode: 'login', signedIn: true });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('app')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('puts the login over the app after a later 401, keeping the app mounted', async () => {
    status.mockResolvedValueOnce({ mode: 'login', signedIn: true });
    renderGate();
    await screen.findByTestId('app');

    act(() => reportUnauthorized());

    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByTestId('app')).toBeInTheDocument();

    vi.mocked(api.auth.login).mockResolvedValueOnce({ expiresAt: 1 });
    status.mockResolvedValueOnce({ mode: 'login', signedIn: true });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.queryByLabelText('Password')).toBeNull());
    expect(mounts).toBe(1);
  });

  it('ignores 401s outside sign-in mode', async () => {
    status.mockResolvedValueOnce({ mode: 'open', signedIn: true });
    renderGate();
    await screen.findByTestId('app');

    act(() => reportUnauthorized());

    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('says a token is needed in token mode', async () => {
    status.mockResolvedValueOnce({ mode: 'token', signedIn: false });
    renderGate();

    expect(await screen.findByRole('alert')).toHaveTextContent('This server needs a token. Use the desktop app, or turn on sign-in (--public-url).');
    expect(screen.queryByTestId('app')).toBeNull();
  });

  it('shows the app straight away when the status call fails', async () => {
    status.mockRejectedValueOnce(new Error('offline'));
    renderGate();

    expect(await screen.findByTestId('app')).toBeInTheDocument();
  });
});
