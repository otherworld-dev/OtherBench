import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../state/api.js';
import { PeerScheduleControl } from './PeerScheduleControl.js';

const settings = (peerScheduleControl: boolean) => ({ memoryProfileId: null, githubEnabled: true, nextcloudEnabled: true, peerComputerControl: false, peerScheduleControl, handoverEnabled: true, handoverThresholdTokens: 300_000, deckStartCommand: '', issueStartCommand: '' });

describe('PeerScheduleControl', () => {
  beforeEach(() => {
    vi.spyOn(api.settings, 'get').mockResolvedValue(settings(false));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows this machine's setting, off by default, and says what turning it on lets a paired machine do", async () => {
    render(<PeerScheduleControl />);
    const box = screen.getByTestId('peer-schedule-control');
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    expect(screen.getByText("Let paired machines manage this machine’s schedules")).toBeInTheDocument();
    expect(screen.getByText(/starts runs on this computer with nobody watching/)).toBeInTheDocument();
    expect(screen.getByText(/notes which machine made each change/)).toBeInTheDocument();
  });

  it('reads a setting the server never sent as off', async () => {
    vi.spyOn(api.settings, 'get').mockResolvedValue({ memoryProfileId: null, githubEnabled: true, nextcloudEnabled: true } as never);
    render(<PeerScheduleControl />);
    const box = screen.getByTestId('peer-schedule-control');
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
  });

  it('turns it on and off, and shows a refusal without changing the box', async () => {
    const patch = vi
      .spyOn(api.settings, 'patch')
      .mockResolvedValueOnce(settings(true))
      .mockResolvedValueOnce(settings(false))
      .mockRejectedValueOnce(new ApiError(500, 'Disk full.'));
    render(<PeerScheduleControl />);
    const box = screen.getByTestId('peer-schedule-control');
    await waitFor(() => expect(box).toBeEnabled());
    await userEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(patch).toHaveBeenCalledWith({ peerScheduleControl: true });
    await userEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(patch).toHaveBeenLastCalledWith({ peerScheduleControl: false });
    await userEvent.click(box);
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full.');
    expect(box).not.toBeChecked();
  });
});
