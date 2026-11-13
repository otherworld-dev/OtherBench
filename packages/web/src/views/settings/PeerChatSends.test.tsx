import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../state/api.js';
import { PeerChatSends } from './PeerChatSends.js';

const settings = (peerChatSends: boolean) => ({ memoryProfileId: null, githubEnabled: true, nextcloudEnabled: true, peerComputerControl: false, peerScheduleControl: false, peerChatSends, handoverEnabled: true, handoverThresholdTokens: 300_000, deckStartCommand: '', issueStartCommand: '' });

describe('PeerChatSends', () => {
  beforeEach(() => {
    vi.spyOn(api.settings, 'get').mockResolvedValue(settings(false));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows this machine's setting, off by default, and says what turning it on does", async () => {
    render(<PeerChatSends />);
    const box = screen.getByTestId('peer-chat-sends');
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    expect(screen.getByText('Let chats on paired machines send work to chats here')).toBeInTheDocument();
    expect(screen.getByText(/which start on it by themselves/)).toBeInTheDocument();
  });

  it('reads a setting the server never sent as off', async () => {
    vi.spyOn(api.settings, 'get').mockResolvedValue({ memoryProfileId: null, githubEnabled: true, nextcloudEnabled: true } as never);
    render(<PeerChatSends />);
    const box = screen.getByTestId('peer-chat-sends');
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
  });

  it('turns it on and off, and shows a refusal without changing the box', async () => {
    const patch = vi
      .spyOn(api.settings, 'patch')
      .mockResolvedValueOnce(settings(true))
      .mockResolvedValueOnce(settings(false))
      .mockRejectedValueOnce(new ApiError(500, 'Disk full.'));
    render(<PeerChatSends />);
    const box = screen.getByTestId('peer-chat-sends');
    await waitFor(() => expect(box).toBeEnabled());
    await userEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(patch).toHaveBeenCalledWith({ peerChatSends: true });
    await userEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(patch).toHaveBeenLastCalledWith({ peerChatSends: false });
    await userEvent.click(box);
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full.');
    expect(box).not.toBeChecked();
  });
});
