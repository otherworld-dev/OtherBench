import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFeatures } from '../../state/features.js';
import { api } from '../../state/api.js';
import { FreshChatSection } from './FreshChatSection.js';

const settings = { memoryProfileId: null, githubEnabled: true, nextcloudEnabled: true, peerComputerControl: false, peerScheduleControl: false, handoverEnabled: true, handoverThresholdTokens: 300_000, deckStartCommand: '', issueStartCommand: '' };

describe('FreshChatSection', () => {
  beforeEach(() => {
    useFeatures.setState({ github: true, nextcloud: true, handoverEnabled: true, handoverThresholdTokens: 300_000, deckStartCommand: '', issueStartCommand: '' });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('switches the card off', async () => {
    const patch = vi.spyOn(api.settings, 'patch').mockResolvedValue({ ...settings, handoverEnabled: false });
    render(<FreshChatSection />);
    await userEvent.click(screen.getByLabelText('Suggest a fresh chat when a Claude Code chat gets big'));
    expect(patch).toHaveBeenCalledWith({ handoverEnabled: false });
    expect(useFeatures.getState().handoverEnabled).toBe(false);
  });

  it('saves the threshold in thousands of tokens', async () => {
    const patch = vi.spyOn(api.settings, 'patch').mockResolvedValue({ ...settings, handoverThresholdTokens: 450_000 });
    render(<FreshChatSection />);
    const field = screen.getByLabelText('Threshold (thousand tokens)');
    expect(field).toHaveValue(300);
    await userEvent.clear(field);
    await userEvent.type(field, '450');
    await userEvent.click(screen.getByRole('button', { name: 'Save threshold' }));
    expect(patch).toHaveBeenCalledWith({ handoverThresholdTokens: 450_000 });
    expect(useFeatures.getState().handoverThresholdTokens).toBe(450_000);
  });

  it('says what the server refused', async () => {
    vi.spyOn(api.settings, 'patch').mockRejectedValue(new Error('"handoverThresholdTokens" must be a whole number from 50000 to 2000000.'));
    render(<FreshChatSection />);
    const field = screen.getByLabelText('Threshold (thousand tokens)');
    await userEvent.clear(field);
    await userEvent.type(field, '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save threshold' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('must be a whole number from 50000 to 2000000');
  });
});
