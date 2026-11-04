import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBrowserScheduledNotify, saveBrowserScheduledNotify } from '../../lib/browserNotify.js';
import { BrowserNotificationsPanel } from './BrowserNotificationsPanel.js';

let permission: NotificationPermission = 'default';
let answer: NotificationPermission = 'granted';
const requestPermission = vi.fn(async (): Promise<NotificationPermission> => {
  permission = answer;
  return answer;
});

beforeEach(() => {
  window.localStorage.clear();
  permission = 'default';
  answer = 'granted';
  requestPermission.mockClear();
  vi.stubGlobal('Notification', {
    get permission() {
      return permission;
    },
    requestPermission,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BrowserNotificationsPanel', () => {
  it('turns scheduled-run notifications on once the browser allows them, and off again', async () => {
    const user = userEvent.setup();
    render(<BrowserNotificationsPanel />);
    const box = screen.getByRole('checkbox', { name: 'Scheduled runs' });
    expect(box).not.toBeChecked();

    await user.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(loadBrowserScheduledNotify()).toBe(true);

    await user.click(box);
    expect(box).not.toBeChecked();
    expect(loadBrowserScheduledNotify()).toBe(false);
  });

  it('stays off, saying why, when the browser says no', async () => {
    answer = 'denied';
    const user = userEvent.setup();
    render(<BrowserNotificationsPanel />);
    await user.click(screen.getByRole('checkbox', { name: 'Scheduled runs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your browser blocks notifications from OtherBench.');
    expect(screen.getByRole('checkbox', { name: 'Scheduled runs' })).not.toBeChecked();
    expect(loadBrowserScheduledNotify()).toBe(false);
  });

  it('shows a choice made earlier as off, saying why, once the browser has blocked them since', () => {
    saveBrowserScheduledNotify(true);
    permission = 'denied';
    render(<BrowserNotificationsPanel />);
    expect(screen.getByRole('checkbox', { name: 'Scheduled runs' })).not.toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('Allow them in its site settings');
  });

  it("can't be turned on where the browser has no notifications", () => {
    vi.unstubAllGlobals();
    const saved = (window as { Notification?: unknown }).Notification;
    delete (window as { Notification?: unknown }).Notification;
    try {
      render(<BrowserNotificationsPanel />);
      expect(screen.getByRole('checkbox', { name: 'Scheduled runs' })).toBeDisabled();
      expect(screen.getByText(/can't show notifications for this address/)).toBeInTheDocument();
    } finally {
      if (saved !== undefined) (window as { Notification?: unknown }).Notification = saved;
    }
  });
});
