import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { push: { status: vi.fn(), subscribe: vi.fn(), setPrefs: vi.fn(), unsubscribe: vi.fn(), test: vi.fn(), active: vi.fn() } } };
});
vi.mock('../../lib/push.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/push.js')>();
  return { ...actual, pushSupport: vi.fn(() => 'supported'), enablePush: vi.fn(), disablePush: vi.fn() };
});

import { disablePush, enablePush, PushDeniedError, pushSupport } from '../../lib/push.js';
import { api, type PushStatus } from '../../state/api.js';
import { useAuthStore } from '../../state/auth.js';
import { BrowserNotificationsPanel } from './BrowserNotificationsPanel.js';
import { PushSection } from './PushSection.js';

const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const OFF: PushStatus = { available: true, publicKey: KEY, subscribed: false, prefs: null };
const ALL = { approvals: true, replies: true, scheduled: true };

beforeEach(() => {
  vi.mocked(api.push.status).mockResolvedValue(OFF);
  vi.mocked(pushSupport).mockReturnValue('supported');
  vi.mocked(enablePush).mockResolvedValue(ALL);
  vi.mocked(disablePush).mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const toggle = () => screen.getByRole('checkbox', { name: 'Notify this device' });

describe('PushSection ("Notify this device")', () => {
  it('turns push on for this device with the server key, shows the choices, and turns it off again', async () => {
    const user = userEvent.setup();
    render(<PushSection />);
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(toggle()).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Replies finished' })).toBeNull();

    await user.click(toggle());
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(enablePush).toHaveBeenCalledWith(KEY, ALL);
    expect(screen.getByRole('checkbox', { name: 'Approvals, questions and plans' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Replies finished' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Scheduled runs' })).toBeChecked();

    await user.click(toggle());
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(disablePush).toHaveBeenCalledTimes(1);
  });

  it("saves one kind turned off, and puts it back if the server didn't take it", async () => {
    vi.mocked(api.push.status).mockResolvedValue({ ...OFF, subscribed: true, prefs: ALL });
    vi.mocked(api.push.setPrefs).mockResolvedValueOnce({ subscribed: true, prefs: { ...ALL, replies: false } });
    const user = userEvent.setup();
    render(<PushSection />);
    const replies = await screen.findByRole('checkbox', { name: 'Replies finished' });
    await user.click(replies);
    expect(api.push.setPrefs).toHaveBeenCalledWith({ ...ALL, replies: false });
    await waitFor(() => expect(replies).not.toBeChecked());

    vi.mocked(api.push.setPrefs).mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('checkbox', { name: 'Scheduled runs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that: offline");
    expect(screen.getByRole('checkbox', { name: 'Scheduled runs' })).toBeChecked();
  });

  it('sends a test push', async () => {
    vi.mocked(api.push.status).mockResolvedValue({ ...OFF, subscribed: true, prefs: ALL });
    vi.mocked(api.push.test).mockResolvedValue({ result: 'sent' });
    const user = userEvent.setup();
    render(<PushSection />);
    await user.click(await screen.findByRole('button', { name: 'Send a test' }));
    expect(await screen.findByText(/should arrive in a few seconds/)).toBeInTheDocument();
  });

  it('stays off, saying why, when the browser blocks notifications', async () => {
    vi.mocked(enablePush).mockRejectedValue(new PushDeniedError('denied'));
    const user = userEvent.setup();
    render(<PushSection />);
    await waitFor(() => expect(toggle()).toBeEnabled());
    await user.click(toggle());
    expect(await screen.findByRole('alert')).toHaveTextContent('Your browser blocks notifications from OtherBench.');
    expect(toggle()).not.toBeChecked();
  });

  it('says to add it to the Home Screen on an iPhone in Safari, and is off', async () => {
    vi.mocked(pushSupport).mockReturnValue('ios-home-screen');
    render(<PushSection />);
    expect(await screen.findByText(/add OtherBench to your Home Screen/)).toBeInTheDocument();
    await waitFor(() => expect(api.push.status).toHaveBeenCalled());
    expect(toggle()).toBeDisabled();
  });

  it("is off where the server has no push, saying why", async () => {
    vi.mocked(api.push.status).mockResolvedValue({ available: false, reason: 'Phone notifications work only when OtherBench runs with remote access.', subscribed: false, prefs: null });
    render(<PushSection />);
    expect(await screen.findByText(/work only when OtherBench runs with remote access/)).toBeInTheDocument();
    expect(toggle()).toBeDisabled();
  });
});

describe('Settings → Notifications', () => {
  it('has "Notify this device" only when signed in through remote access', async () => {
    useAuthStore.setState({ mode: 'open' });
    const { unmount } = render(<BrowserNotificationsPanel />);
    expect(screen.queryByTestId('push-section')).toBeNull();
    unmount();

    useAuthStore.setState({ mode: 'login' });
    render(<BrowserNotificationsPanel />);
    expect(screen.getByTestId('push-section')).toBeInTheDocument();
    await waitFor(() => expect(api.push.status).toHaveBeenCalled());
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });
});
