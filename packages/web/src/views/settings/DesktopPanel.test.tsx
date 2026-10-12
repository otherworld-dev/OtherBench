import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../desktop/bridge.js', () => ({
  isDesktop: () => true,
  autostart: { isEnabled: vi.fn(), set: vi.fn() },
  setHotkey: vi.fn(),
}));

import { autostart, setHotkey } from '../../desktop/bridge.js';
import { useGruntStore } from '../../state/store.js';
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

  it('saving a new hotkey registers it and remembers it; a taken one says so and puts the old one back', async () => {
    window.localStorage.clear();
    useGruntStore.setState(useGruntStore.getInitialState(), true);
    mockedIsEnabled.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<DesktopPanel />);
    const field = screen.getByRole('textbox', { name: 'Quick chat hotkey' });
    expect(field).toHaveValue('Ctrl+Alt+G');

    vi.mocked(setHotkey).mockResolvedValue(undefined);
    await user.clear(field);
    await user.type(field, 'Ctrl+Shift+Space');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(window.localStorage.getItem('grunt.hotkey')).toBe('Ctrl+Shift+Space'));
    expect(screen.queryByTestId('hotkey-error')).not.toBeInTheDocument();

    vi.mocked(setHotkey).mockRejectedValueOnce('HotKey already registered').mockResolvedValueOnce(undefined);
    await user.clear(field);
    await user.type(field, 'Ctrl+C');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('hotkey-error')).toHaveTextContent("Couldn't use Ctrl+C: HotKey already registered");
    expect(vi.mocked(setHotkey)).toHaveBeenLastCalledWith('Ctrl+Shift+Space');
    expect(window.localStorage.getItem('grunt.hotkey')).toBe('Ctrl+Shift+Space');
  });

  it('notification toggles start on, and turning one off is saved for next time', async () => {
    window.localStorage.clear();
    mockedIsEnabled.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<DesktopPanel />);
    const replies = screen.getByRole('checkbox', { name: 'When a reply finishes' });
    const approvals = screen.getByRole('checkbox', { name: 'Approvals, questions and plans' });
    expect(replies).toBeChecked();
    expect(approvals).toBeChecked();

    await user.click(replies);
    expect(replies).not.toBeChecked();
    expect(JSON.parse(window.localStorage.getItem('grunt.notifications')!)).toEqual({ replies: false, approvals: true, scheduled: true });
  });

  it('has a Scheduled runs toggle, on by default, saved when turned off', async () => {
    window.localStorage.clear();
    mockedIsEnabled.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<DesktopPanel />);
    const scheduled = screen.getByRole('checkbox', { name: 'Scheduled runs' });
    expect(scheduled).toBeChecked();
    await user.click(scheduled);
    expect(JSON.parse(window.localStorage.getItem('grunt.notifications')!)).toEqual({ replies: true, approvals: true, scheduled: false });
  });

  it('explains that closing the window keeps Grunt running in the tray', () => {
    mockedIsEnabled.mockResolvedValue(false);

    render(<DesktopPanel />);

    expect(screen.getByText(/closing the window keeps grunt running in the tray/i)).toBeInTheDocument();
  });
});
