import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../state/api.js';
import { PeerComputerControl } from './PeerComputerControl.js';

const settings = (peerComputerControl: boolean) => ({ memoryProfileId: null, githubEnabled: true, nextcloudEnabled: true, peerComputerControl });

describe('PeerComputerControl', () => {
  beforeEach(() => {
    vi.spyOn(api.settings, 'get').mockResolvedValue(settings(true));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows this machine's setting, on by default, and says what it lets a paired machine do", async () => {
    render(<PeerComputerControl />);
    await waitFor(() => expect(screen.getByTestId('peer-computer-control')).toBeChecked());
    expect(screen.getByText('Let paired machines start and approve computer use')).toBeInTheDocument();
    expect(screen.getByText(/click and type in apps here/)).toBeInTheDocument();
  });

  it('turns it off and on through the settings', async () => {
    const patch = vi.spyOn(api.settings, 'patch').mockResolvedValue(settings(false));
    render(<PeerComputerControl />);
    const box = screen.getByTestId('peer-computer-control');
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.setup().click(box);
    expect(patch).toHaveBeenCalledWith({ peerComputerControl: false });
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it('says why a change was refused, and keeps what the server has', async () => {
    vi.spyOn(api.settings, 'patch').mockRejectedValue(new ApiError(403, 'OtherBench is controlling this computer.'));
    render(<PeerComputerControl />);
    const box = screen.getByTestId('peer-computer-control');
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.setup().click(box);
    expect(await screen.findByRole('alert')).toHaveTextContent('OtherBench is controlling this computer.');
    expect(box).toBeChecked();
  });
});
