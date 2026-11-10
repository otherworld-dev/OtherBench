import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { ...actual.api, settings: { get: vi.fn(), patch: vi.fn() } } };
});

import { ApiError, api } from '../../state/api.js';
import { useFeatures } from '../../state/features.js';
import { FeaturesPanel } from './FeaturesPanel.js';

const mockedGet = vi.mocked(api.settings.get);
const mockedPatch = vi.mocked(api.settings.patch);
const settings = (githubEnabled: boolean, nextcloudEnabled: boolean) => ({ memoryProfileId: null, githubEnabled, nextcloudEnabled, peerComputerControl: true, peerScheduleControl: false, handoverEnabled: true, handoverThresholdTokens: 300_000, deckStartCommand: '', issueStartCommand: '' });

beforeEach(() => {
  window.localStorage.clear();
  useFeatures.setState({ github: true, nextcloud: true });
  mockedGet.mockReset().mockResolvedValue(settings(true, true));
  mockedPatch.mockReset();
});
afterEach(cleanup);

describe('FeaturesPanel', () => {
  it('shows the switches as the server has them', async () => {
    mockedGet.mockResolvedValue(settings(true, false));
    render(<FeaturesPanel />);
    await waitFor(() => expect(screen.getByTestId('feature-nextcloudEnabled')).not.toBeChecked());
    expect(screen.getByTestId('feature-githubEnabled')).toBeChecked();
  });

  it('turning one off saves it, and every part of this window hears and remembers it', async () => {
    mockedPatch.mockResolvedValue(settings(false, true));
    render(<FeaturesPanel />);
    await userEvent.setup().click(screen.getByTestId('feature-githubEnabled'));
    expect(mockedPatch).toHaveBeenCalledWith({ githubEnabled: false });
    await waitFor(() => expect(useFeatures.getState().github).toBe(false));
    expect(screen.getByTestId('feature-githubEnabled')).not.toBeChecked();
    expect(JSON.parse(window.localStorage.getItem('otherbench.features') ?? '{}')).toEqual({ github: false, nextcloud: true, handoverEnabled: true, handoverThresholdTokens: 300_000, deckStartCommand: '', issueStartCommand: '' });
  });

  it("says why when the server won't save it, and leaves the switch as it was", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedPatch.mockRejectedValue(new ApiError(400, '"githubEnabled" must be true or false.'));
    render(<FeaturesPanel />);
    await userEvent.setup().click(screen.getByTestId('feature-githubEnabled'));
    expect(await screen.findByRole('alert')).toHaveTextContent('"githubEnabled" must be true or false.');
    expect(screen.getByTestId('feature-githubEnabled')).toBeChecked();
  });

  it('saves a Deck start command, and only shows the box for a feature that is on', async () => {
    useFeatures.setState({ github: false, nextcloud: true, deckStartCommand: '', issueStartCommand: '' });
    mockedGet.mockResolvedValue(settings(false, true));
    mockedPatch.mockResolvedValue({ ...settings(false, true), deckStartCommand: '/start {card}' });
    render(<FeaturesPanel />);
    expect(screen.queryByLabelText('GitHub issue')).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Deck card'), '/start {{card}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockedPatch).toHaveBeenCalledWith({ deckStartCommand: '/start {card}' });
    await waitFor(() => expect(useFeatures.getState().deckStartCommand).toBe('/start {card}'));
    expect(screen.getByLabelText('Deck card')).toHaveValue('/start {card}');
  });
});
