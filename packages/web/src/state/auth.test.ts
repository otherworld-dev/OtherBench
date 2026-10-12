import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,
    api: { auth: { status: vi.fn(), login: vi.fn(), logout: vi.fn(), logoutAll: vi.fn(), changePassword: vi.fn() } },
  };
});

import { api } from './api.js';
import { useAuthStore } from './auth.js';

const status = vi.mocked(api.auth.status);

beforeEach(() => {
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('useAuthStore', () => {
  it.each([
    [{ mode: 'open', signedIn: true }, 'ready'],
    [{ mode: 'token', signedIn: false }, 'token-needed'],
    [{ mode: 'login', signedIn: false }, 'signed-out'],
    [{ mode: 'login', signedIn: true }, 'ready'],
  ] as const)('maps %j to %s', async (info, expected) => {
    status.mockResolvedValueOnce(info);

    await useAuthStore.getState().loadStatus();

    expect(useAuthStore.getState()).toMatchObject({ status: expected, mode: info.mode, overlay: false });
  });

  it("shows the app as before when the server can't be reached", async () => {
    status.mockRejectedValueOnce(new Error('offline'));

    await useAuthStore.getState().loadStatus();

    expect(useAuthStore.getState()).toMatchObject({ status: 'ready', mode: null });
  });

  it('expires into the overlay only from a signed-in sign-in session', () => {
    useAuthStore.setState({ status: 'ready', mode: 'open' });
    useAuthStore.getState().expire();
    expect(useAuthStore.getState().status).toBe('ready');

    useAuthStore.setState({ status: 'ready', mode: 'login' });
    useAuthStore.getState().expire();
    expect(useAuthStore.getState()).toMatchObject({ status: 'signed-out', overlay: true });
  });

  it('signs in, then asks for the status again', async () => {
    vi.mocked(api.auth.login).mockResolvedValueOnce({ expiresAt: 1 });
    status.mockResolvedValueOnce({ mode: 'login', signedIn: true });
    useAuthStore.setState({ status: 'signed-out', mode: 'login', overlay: true });

    await useAuthStore.getState().signIn('a long password', true);

    expect(api.auth.login).toHaveBeenCalledWith('a long password', true);
    expect(useAuthStore.getState()).toMatchObject({ status: 'ready', overlay: false });
  });

  it('signs out to the plain login page (no app underneath), even if the request fails', async () => {
    vi.mocked(api.auth.logout).mockRejectedValueOnce(new Error('offline'));
    useAuthStore.setState({ status: 'ready', mode: 'login', info: { mode: 'login', signedIn: true } });

    await useAuthStore.getState().signOut();

    expect(useAuthStore.getState()).toMatchObject({ status: 'signed-out', overlay: false, info: { signedIn: false } });
  });
});
