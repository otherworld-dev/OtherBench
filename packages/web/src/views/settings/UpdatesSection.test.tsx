import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners: ((s: unknown) => void)[] = [];
vi.mock('../../desktop/bridge.js', () => ({
  isDesktop: () => true,
  updateStatus: vi.fn(),
  checkForUpdates: vi.fn(async () => {}),
  setBetaUpdates: vi.fn(async () => {}),
  installUpdateNow: vi.fn(async () => {}),
  onUpdateStatus: vi.fn(async (cb: (s: unknown) => void) => {
    listeners.push(cb);
    return () => {};
  }),
}));

import { checkForUpdates, installUpdateNow, setBetaUpdates, updateStatus, type UpdateStatus } from '../../desktop/bridge.js';
import { UpdatesSection, updateStatusText } from './UpdatesSection.js';

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    current: '0.2.0-beta.7', installed: true, beta: false, state: 'up-to-date', available: null, newestFull: null,
    lastCheckedAt: null, waitingFor: [], error: null, ...over,
  };
}

beforeEach(() => {
  listeners.length = 0;
  vi.mocked(updateStatus).mockResolvedValue(status());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('updateStatusText', () => {
  it('says where the updater is', () => {
    expect(updateStatusText(status())).toBe('Up to date (0.2.0-beta.7)');
    expect(updateStatusText(status({ state: 'ahead', newestFull: '0.1.0' }))).toBe("You're on a newer build than the current release (0.1.0)");
    expect(updateStatusText(status({ state: 'ready', available: '0.2.0-beta.8', waitingFor: ['1 reply being written'] }))).toBe(
      "0.2.0-beta.8 is ready. It installs when nothing is running and you're away (waiting for: 1 reply being written)"
    );
    expect(updateStatusText(status({ state: 'ready', available: '0.2.0-beta.8' }))).toBe("0.2.0-beta.8 is ready. It installs when nothing is running and you're away");
    expect(updateStatusText(status({ state: 'ask', available: '0.2.0-beta.8' }))).toBe('0.2.0-beta.8 has been waiting a day.');
    expect(updateStatusText(status({ state: 'no-releases' }))).toBe('No releases yet');
    expect(updateStatusText(status({ state: 'dev-build', installed: false }))).toBe("This is a development build, so it doesn't update itself");
    expect(updateStatusText(status({ state: 'error', error: 'dns' }))).toBe("Couldn't check for updates: dns");
    expect(updateStatusText(status({ state: 'downloading', available: '0.2.0-beta.8' }))).toBe('Downloading 0.2.0-beta.8…');
  });
});

describe('UpdatesSection', () => {
  it('shows the version and status, and turns betas on', async () => {
    render(<UpdatesSection />);
    expect(await screen.findByTestId('update-status')).toHaveTextContent('Up to date (0.2.0-beta.7)');
    await userEvent.click(screen.getByRole('checkbox', { name: /get beta releases early/i }));
    expect(setBetaUpdates).toHaveBeenCalledWith(true);
  });

  it('checks now, and says when it last checked', async () => {
    const at = new Date(2026, 9, 29, 14, 2).getTime();
    vi.mocked(updateStatus).mockResolvedValue(status({ lastCheckedAt: at }));
    render(<UpdatesSection />);
    expect(await screen.findByTestId('update-last-checked')).toHaveTextContent(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    await userEvent.click(screen.getByRole('button', { name: /check now/i }));
    expect(checkForUpdates).toHaveBeenCalled();
  });

  it('follows the shell as the status changes, and offers a restart once one is ready', async () => {
    render(<UpdatesSection />);
    await screen.findByTestId('update-status');
    expect(screen.queryByRole('button', { name: /restart and update now/i })).toBeNull();
    act(() => listeners.forEach((cb) => cb(status({ state: 'ask', available: '0.2.0-beta.8' }))));
    expect(screen.getByTestId('update-status')).toHaveTextContent('0.2.0-beta.8 has been waiting a day.');
    await userEvent.click(screen.getByRole('button', { name: /restart and update now/i }));
    expect(installUpdateNow).toHaveBeenCalled();
  });

  it("a development build can't be switched or checked", async () => {
    vi.mocked(updateStatus).mockResolvedValue(status({ state: 'dev-build', installed: false }));
    render(<UpdatesSection />);
    await waitFor(() => expect(screen.getByTestId('update-status')).toHaveTextContent('development build'));
    expect(screen.getByRole('checkbox', { name: /get beta releases early/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /check now/i })).toBeDisabled();
  });
});
