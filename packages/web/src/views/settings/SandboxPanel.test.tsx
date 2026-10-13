import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxStatus } from '@grunt/core/ports/sandbox.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { sandbox: { status: vi.fn(), setup: vi.fn(), remove: vi.fn(), setPackages: vi.fn() } } };
});

import { ApiError, api } from '../../state/api.js';
import { SANDBOX_POLL_MS, SandboxPanel, splitPackages } from './SandboxPanel.js';

const sandbox = vi.mocked(api.sandbox);
const status = (over: Partial<SandboxStatus> = {}): SandboxStatus => ({ state: 'not_set_up', packages: [], machine: 'Gigabyte', ...over });
const READY = status({ state: 'ready', versions: { distro: 'Ubuntu 24.04.5 LTS', runtime: '0.0.79', node: 'v24.21.0' } });

beforeEach(() => {
  for (const fn of Object.values(sandbox)) fn.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SandboxPanel', () => {
  it('says the sandbox is not available on this platform, with nothing to press', async () => {
    sandbox.status.mockResolvedValue(status({ state: 'unsupported', detail: "The sandbox isn't available on this platform yet." }));
    render(<SandboxPanel />);
    expect(await screen.findByTestId('sandbox-unsupported')).toHaveTextContent("The sandbox isn't available on this platform yet.");
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('sets up only when asked, shows progress while it sets up, then the versions', async () => {
    sandbox.status.mockResolvedValueOnce(status());
    sandbox.setup.mockResolvedValue(status({ state: 'setting_up', log: ['▶ Check WSL'] }));
    render(<SandboxPanel />);
    expect(await screen.findByTestId('sandbox-state')).toHaveTextContent('Not set up on Gigabyte.');
    expect(sandbox.setup).not.toHaveBeenCalled();
    sandbox.status.mockResolvedValue(READY);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Set up' }));
    expect(await screen.findByTestId('sandbox-log')).toHaveTextContent('▶ Check WSL');
    expect(await screen.findByTestId('sandbox-versions', {}, { timeout: SANDBOX_POLL_MS * 3 })).toHaveTextContent('0.0.79');
    expect(screen.getByTestId('sandbox-state')).toHaveTextContent('Ready');
  });

  it('shows a failed setup with its step, message and log, and Repair runs it again', async () => {
    sandbox.status.mockResolvedValue(status({ state: 'failed', detail: 'Install Node: no network', log: ['▶ Install Node', '✖ Install Node: no network'] }));
    sandbox.setup.mockResolvedValue(status({ state: 'setting_up', log: [] }));
    render(<SandboxPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Install Node: no network');
    expect(screen.getByTestId('sandbox-log')).toHaveTextContent('✖ Install Node: no network');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Repair' }));
    expect(sandbox.setup).toHaveBeenCalledTimes(1);
  });

  it('shows why the last package install failed on a sandbox that is still ready', async () => {
    sandbox.status.mockResolvedValue({ ...READY, detail: 'Install packages: E: Unable to locate package nope', log: ['✖ Install packages'] });
    render(<SandboxPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to locate package nope');
    expect(screen.getByTestId('sandbox-state')).toHaveTextContent('Ready');
    expect(screen.getByTestId('sandbox-log')).toHaveTextContent('✖ Install packages');
  });

  it('asks before removing, and does nothing on no', async () => {
    sandbox.status.mockResolvedValue(READY);
    sandbox.remove.mockResolvedValue(status());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SandboxPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Remove the sandbox from Gigabyte?'));
    expect(sandbox.remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByTestId('sandbox-state')).toHaveTextContent('Not set up'));
  });

  it('applies the extra packages as a list', async () => {
    sandbox.status.mockResolvedValue({ ...READY, packages: ['ffmpeg'] });
    sandbox.setPackages.mockResolvedValue({ ...READY, packages: ['ffmpeg', 'pandoc'] });
    render(<SandboxPanel />);
    const user = userEvent.setup();
    const field = await screen.findByLabelText('Extra packages');
    expect(field).toHaveValue('ffmpeg');
    await user.clear(field);
    await user.type(field, 'ffmpeg, pandoc');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(sandbox.setPackages).toHaveBeenCalledWith(['ffmpeg', 'pandoc']);
    // Back to the server's own list once it took it.
    await waitFor(() => expect(field).toHaveValue('ffmpeg pandoc'));
  });

  it('shows the server refusing the packages, and keeps what was typed', async () => {
    sandbox.status.mockResolvedValue(READY);
    sandbox.setPackages.mockRejectedValue(new ApiError(400, '"packages": "nope!" isn\'t a Debian package name.'));
    render(<SandboxPanel />);
    const user = userEvent.setup();
    const field = await screen.findByLabelText('Extra packages');
    await user.type(field, 'nope!');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("isn't a Debian package name");
    expect(field).toHaveValue('nope!');
  });

  it('announces its state and progress, and ties the help text to the packages field', async () => {
    sandbox.status.mockResolvedValue(status({ state: 'setting_up', log: ['▶ Check WSL'] }));
    render(<SandboxPanel />);
    expect(await screen.findByRole('status')).toHaveTextContent('Setting up…');
    expect(screen.getByRole('log', { name: 'Setup progress' })).toHaveTextContent('▶ Check WSL');
    expect(screen.getByLabelText('Extra packages')).toHaveAccessibleDescription(/Ubuntu \(apt\) package names/);
  });

  it('moves focus to the progress log when Set up takes its own button away', async () => {
    sandbox.status.mockResolvedValue(status());
    sandbox.setup.mockResolvedValue(status({ state: 'setting_up', log: ['▶ Check WSL'] }));
    render(<SandboxPanel />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Set up' }));
    expect(await screen.findByRole('log', { name: 'Setup progress' })).toHaveFocus();
  });

  it('shows warnings, and a refusal from the server', async () => {
    sandbox.status.mockResolvedValue({ ...READY, warnings: ["WSL's mirrored networking is on"] });
    sandbox.setup.mockRejectedValue(new ApiError(409, 'The sandbox is being set up.'));
    render(<SandboxPanel />);
    expect(await screen.findByTestId('sandbox-warning')).toHaveTextContent("Warning: WSL's mirrored networking is on");
    await userEvent.setup().click(screen.getByRole('button', { name: 'Repair' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The sandbox is being set up.');
  });
});

describe('SandboxPanel polling', () => {
  // Only the interval is faked, so the promises and findBy* waits keep running on real time.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const tick = () =>
    act(async () => {
      vi.advanceTimersByTime(SANDBOX_POLL_MS);
    });
  const SETTING_UP = status({ state: 'setting_up', log: ['▶ Check WSL'] });

  it('shows a failed poll and clears it on the next good one', async () => {
    sandbox.status.mockResolvedValue(SETTING_UP);
    render(<SandboxPanel />);
    await screen.findByTestId('sandbox-log');
    sandbox.status.mockRejectedValueOnce(new Error('network'));
    await tick();
    expect(await screen.findByRole('alert')).toHaveTextContent("That didn't work");
    await tick();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('stops polling once the state leaves setting_up', async () => {
    sandbox.status.mockResolvedValueOnce(SETTING_UP).mockResolvedValue(READY);
    render(<SandboxPanel />);
    await screen.findByTestId('sandbox-log');
    await tick();
    await screen.findByTestId('sandbox-versions');
    expect(sandbox.status).toHaveBeenCalledTimes(2);
    await tick();
    await tick();
    expect(sandbox.status).toHaveBeenCalledTimes(2);
  });

  it('stops polling when the panel goes away', async () => {
    sandbox.status.mockResolvedValue(SETTING_UP);
    const { unmount } = render(<SandboxPanel />);
    await screen.findByTestId('sandbox-log');
    unmount();
    await tick();
    await tick();
    expect(sandbox.status).toHaveBeenCalledTimes(1);
  });
});

describe('splitPackages', () => {
  it('splits on commas, spaces and new lines', () => {
    expect(splitPackages(' ffmpeg, pandoc\nimagemagick  ')).toEqual(['ffmpeg', 'pandoc', 'imagemagick']);
    expect(splitPackages('')).toEqual([]);
  });
});
