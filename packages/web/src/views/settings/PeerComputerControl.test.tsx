import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../state/api.js';
import { PeerComputerControl } from './PeerComputerControl.js';

const shell = vi.hoisted(() => ({ desktop: true }));
vi.mock('../../desktop/bridge.js', () => ({ isDesktop: () => shell.desktop }));

const settings = (peerComputerControl: boolean) => ({ memoryProfileId: null, githubEnabled: true, nextcloudEnabled: true, peerComputerControl });

describe('PeerComputerControl', () => {
  beforeEach(() => {
    shell.desktop = true;
    vi.spyOn(api.settings, 'get').mockResolvedValue(settings(false));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows this machine's setting, off by default, and says it lets a paired machine control this computer's mouse and keyboard", async () => {
    render(<PeerComputerControl />);
    const box = screen.getByTestId('peer-computer-control');
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    expect(screen.getByText('Let paired machines start and approve computer use')).toBeInTheDocument();
    expect(screen.getByText(/controls this computer's mouse and keyboard/)).toBeInTheDocument();
    expect(screen.getByText(/someone here has to accept it/)).toBeInTheDocument();
    expect(screen.getByText(/Off \(the default\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('peer-computer-control-desktop-only')).toBeNull();
  });

  it('reads a setting the server never sent as off', async () => {
    vi.spyOn(api.settings, 'get').mockResolvedValue({ memoryProfileId: null, githubEnabled: true, nextcloudEnabled: true } as never);
    render(<PeerComputerControl />);
    const box = screen.getByTestId('peer-computer-control');
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
  });

  it('turns it on and off through the settings in the desktop app', async () => {
    const patch = vi.spyOn(api.settings, 'patch').mockResolvedValueOnce(settings(true)).mockResolvedValueOnce(settings(false));
    render(<PeerComputerControl />);
    const box = screen.getByTestId('peer-computer-control');
    await waitFor(() => expect(box).toBeEnabled());
    const user = userEvent.setup();
    await user.click(box);
    expect(patch).toHaveBeenCalledWith({ peerComputerControl: true });
    await waitFor(() => expect(box).toBeChecked());
    await user.click(box);
    expect(patch).toHaveBeenLastCalledWith({ peerComputerControl: false });
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it('outside the desktop app it is disabled while off, and says it can only be turned on there', async () => {
    shell.desktop = false;
    const patch = vi.spyOn(api.settings, 'patch');
    render(<PeerComputerControl />);
    const note = await screen.findByTestId('peer-computer-control-desktop-only');
    expect(note).toHaveTextContent('This can only be turned on in the OtherBench desktop app on this computer');
    const box = screen.getByTestId('peer-computer-control');
    expect(box).toBeDisabled();
    await userEvent.setup().click(box);
    expect(patch).not.toHaveBeenCalled();
  });

  it('outside the desktop app it can still be turned off while on', async () => {
    shell.desktop = false;
    vi.spyOn(api.settings, 'get').mockResolvedValue(settings(true));
    const patch = vi.spyOn(api.settings, 'patch').mockResolvedValue(settings(false));
    render(<PeerComputerControl />);
    const box = screen.getByTestId('peer-computer-control');
    await waitFor(() => expect(box).toBeChecked());
    expect(box).toBeEnabled();
    expect(screen.getByTestId('peer-computer-control-desktop-only')).toHaveTextContent('From here you can turn it off.');
    await userEvent.setup().click(box);
    expect(patch).toHaveBeenCalledWith({ peerComputerControl: false });
    await waitFor(() => expect(box).not.toBeChecked());
    expect(box).toBeDisabled();
  });

  it('says why a change was refused, and keeps what the server has', async () => {
    vi.spyOn(api.settings, 'patch').mockRejectedValue(new ApiError(403, 'OtherBench is controlling this computer.'));
    render(<PeerComputerControl />);
    const box = screen.getByTestId('peer-computer-control');
    await waitFor(() => expect(box).toBeEnabled());
    await userEvent.setup().click(box);
    expect(await screen.findByRole('alert')).toHaveTextContent('OtherBench is controlling this computer.');
    expect(box).not.toBeChecked();
  });
});
