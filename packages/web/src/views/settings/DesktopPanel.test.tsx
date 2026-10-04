import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../desktop/bridge.js', () => ({
  isDesktop: () => true,
  autostart: { isEnabled: vi.fn(), set: vi.fn() },
}));

import { autostart } from '../../desktop/bridge.js';
import { DesktopPanel } from './DesktopPanel.js';

const mockedIsEnabled = vi.mocked(autostart.isEnabled);
const mockedSet = vi.mocked(autostart.set);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('DesktopPanel', () => {
  it('shows the current start-at-login state', async () => {
    mockedIsEnabled.mockResolvedValue(true);

    render(<DesktopPanel />);

    await waitFor(() => expect(screen.getByRole('checkbox', { name: /start grunt when i sign in/i })).toBeChecked());
  });

  it('toggling turns start-at-login on and off', async () => {
    mockedIsEnabled.mockResolvedValue(false);
    mockedSet.mockResolvedValue(undefined);
    render(<DesktopPanel />);
    const box = await screen.findByRole('checkbox', { name: /start grunt when i sign in/i });
    await waitFor(() => expect(box).toBeEnabled());

    await userEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);

    expect(mockedSet.mock.calls).toEqual([[true], [false]]);
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it('keeps the old state and says so when the change fails', async () => {
    mockedIsEnabled.mockResolvedValue(false);
    mockedSet.mockRejectedValue(new Error('registry says no'));
    render(<DesktopPanel />);
    const box = await screen.findByRole('checkbox', { name: /start grunt when i sign in/i });
    await waitFor(() => expect(box).toBeEnabled());

    await userEvent.click(box);

    expect(await screen.findByRole('alert')).toHaveTextContent(/registry says no/);
    expect(box).not.toBeChecked();
  });

  it('notification toggles start on, and turning one off is saved for next time', async () => {
    window.localStorage.clear();
    mockedIsEnabled.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<DesktopPanel />);
    const replies = screen.getByRole('checkbox', { name: 'When a reply finishes' });
    const approvals = screen.getByRole('checkbox', { name: 'When a tool call needs approval' });
    expect(replies).toBeChecked();
    expect(approvals).toBeChecked();

    await user.click(replies);
    expect(replies).not.toBeChecked();
    expect(JSON.parse(window.localStorage.getItem('grunt.notifications')!)).toEqual({ replies: false, approvals: true });
  });

  it('explains that closing the window keeps Grunt running in the tray', () => {
    mockedIsEnabled.mockResolvedValue(false);

    render(<DesktopPanel />);

    expect(screen.getByText(/closing the window keeps grunt running in the tray/i)).toBeInTheDocument();
  });
});
