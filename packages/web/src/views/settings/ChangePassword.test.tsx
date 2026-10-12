import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { auth: { status: vi.fn(), login: vi.fn(), logout: vi.fn(), logoutAll: vi.fn(), changePassword: vi.fn() } } };
});

import { api, ApiError } from '../../state/api.js';
import { useAuthStore } from '../../state/auth.js';
import { ChangePassword } from './ChangePassword.js';

beforeEach(() => {
  useAuthStore.setState({ ...useAuthStore.getInitialState(), status: 'ready', mode: 'login', info: { mode: 'login', signedIn: true } }, true);
  vi.mocked(api.auth.status).mockResolvedValue({ mode: 'login', signedIn: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fill(current: string, next: string, again: string): void {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('New password again'), { target: { value: again } });
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
}

describe('ChangePassword', () => {
  it('changes it and says other devices are signed out', async () => {
    vi.mocked(api.auth.changePassword).mockResolvedValueOnce({ expiresAt: 1 });
    render(<ChangePassword />);

    fill('the old password', 'the new password', 'the new password');

    expect(await screen.findByRole('status')).toHaveTextContent('Password changed. Every other device is signed out.');
    expect(api.auth.changePassword).toHaveBeenCalledWith('the old password', 'the new password');
  });

  it("checks the two new ones match and the length before asking the server", async () => {
    render(<ChangePassword />);

    fill('the old password', 'the new password', 'the new passwort');
    expect(await screen.findByRole('alert')).toHaveTextContent("The new passwords don't match.");
    fill('the old password', 'short', 'short');
    expect(await screen.findByRole('alert')).toHaveTextContent('The password must be at least 12 characters.');
    expect(api.auth.changePassword).not.toHaveBeenCalled();
  });

  it("shows the server's answer for a wrong current password, staying signed in", async () => {
    vi.mocked(api.auth.changePassword).mockRejectedValueOnce(new ApiError(403, 'The current password is wrong.'));
    render(<ChangePassword />);

    fill('not the password', 'the new password', 'the new password');

    expect(await screen.findByRole('alert')).toHaveTextContent('The current password is wrong.');
    expect(useAuthStore.getState().status).toBe('ready');
  });
});
