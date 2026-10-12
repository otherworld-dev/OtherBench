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

  describe('expire', () => {
    it('does not even ask in open or token mode', async () => {
      useAuthStore.setState({ status: 'ready', mode: 'open' });
      await useAuthStore.getState().expire();
      expect(useAuthStore.getState().status).toBe('ready');

      useAuthStore.setState({ status: 'token-needed', mode: 'token' });
      await useAuthStore.getState().expire();
      expect(status).not.toHaveBeenCalled();
    });

    it('puts the login over the app when the server confirms the session is gone', async () => {
      status.mockResolvedValueOnce({ mode: 'login', signedIn: false });
      useAuthStore.setState({ status: 'ready', mode: 'login' });

      await useAuthStore.getState().expire();

      expect(useAuthStore.getState()).toMatchObject({ status: 'signed-out', overlay: true, info: { signedIn: false } });
    });

    it('stays on the app when the server says the session is fine (a 401 from a cookie that was just replaced)', async () => {
      status.mockResolvedValueOnce({ mode: 'login', signedIn: true });
      useAuthStore.setState({ status: 'ready', mode: 'login' });

      await useAuthStore.getState().expire();

      expect(useAuthStore.getState()).toMatchObject({ status: 'ready', overlay: false });
    });

    it('shows the login when the question itself fails in sign-in mode, as a 401 did before', async () => {
      status.mockRejectedValueOnce(new Error('offline'));
      useAuthStore.setState({ status: 'ready', mode: 'login' });

      await useAuthStore.getState().expire();

      expect(useAuthStore.getState()).toMatchObject({ status: 'signed-out', overlay: true });
    });

    it('asks once for any number of overlapping 401s', async () => {
      let answer!: (v: { mode: 'login'; signedIn: boolean }) => void;
      status.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
      useAuthStore.setState({ status: 'ready', mode: 'login' });

      const first = useAuthStore.getState().expire();
      const second = useAuthStore.getState().expire();
      answer({ mode: 'login', signedIn: false });
      await Promise.all([first, second]);

      expect(status).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState()).toMatchObject({ status: 'signed-out', overlay: true });
      // And a later 401 can ask again.
      useAuthStore.setState({ status: 'ready' });
      status.mockResolvedValueOnce({ mode: 'login', signedIn: true });
      await useAuthStore.getState().expire();
      expect(status).toHaveBeenCalledTimes(2);
    });

    it('does nothing while the first status call is still out, or with the login already up', async () => {
      useAuthStore.setState({ status: 'checking', mode: null });
      await useAuthStore.getState().expire();
      useAuthStore.setState({ status: 'signed-out', mode: 'login', overlay: false });
      await useAuthStore.getState().expire();

      expect(status).not.toHaveBeenCalled();
    });

    it('with the mode unknown (the status call failed at load), asks and routes by the answer', async () => {
      useAuthStore.setState({ status: 'ready', mode: null, info: null });
      status.mockResolvedValueOnce({ mode: 'login', signedIn: false });
      await useAuthStore.getState().expire();
      expect(useAuthStore.getState()).toMatchObject({ status: 'signed-out', mode: 'login', overlay: true });

      useAuthStore.setState({ status: 'ready', mode: null, info: null, overlay: false });
      status.mockResolvedValueOnce({ mode: 'open', signedIn: true });
      await useAuthStore.getState().expire();
      expect(useAuthStore.getState()).toMatchObject({ status: 'ready', mode: 'open', overlay: false });

      useAuthStore.setState({ status: 'ready', mode: null, info: null });
      status.mockResolvedValueOnce({ mode: 'token', signedIn: false });
      await useAuthStore.getState().expire();
      expect(useAuthStore.getState()).toMatchObject({ status: 'token-needed', mode: 'token' });
    });

    it('with the mode unknown and the question failing too, leaves the app as it is', async () => {
      useAuthStore.setState({ status: 'ready', mode: null, info: null });
      status.mockRejectedValueOnce(new Error('offline'));

      await useAuthStore.getState().expire();

      expect(useAuthStore.getState()).toMatchObject({ status: 'ready', overlay: false });
    });
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
