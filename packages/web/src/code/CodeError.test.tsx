import { describe, expect, it } from 'vitest';
import { ApiError } from '../state/api.js';
import { NO_BOOKMARK_TAG, NO_DECK_BOARD, NO_WIKI_PAGE, codeErrorText } from './CodeError.js';

describe('codeErrorText', () => {
  it('gives the setup line for nextcloud-not-configured', () => {
    const err = new ApiError(409, 'raw server words', undefined, { code: 'nextcloud-not-configured' });
    expect(codeErrorText(err, 'fallback').message).toBe("Nextcloud isn't set up on this machine. Add it in Settings → Nextcloud");
  });

  it('shows the server message for codes without a line, and names the missing links', () => {
    const err = new ApiError(409, 'Deck ignored the move', undefined, { code: 'deck-move-ignored' });
    expect(codeErrorText(err, 'fallback').message).toBe('Deck ignored the move');
    expect(NO_DECK_BOARD).toBe('No Deck board set for this app');
    expect(NO_WIKI_PAGE).toBe('No Collectives page set for this app');
    expect(NO_BOOKMARK_TAG).toBe('No bookmark tag set for this app');
  });

  it("shows the server's line for nextcloud-app-missing, which names the app", () => {
    const err = new ApiError(409, "Nextcloud's Bookmarks app didn't answer. Check it's installed.", undefined, { code: 'nextcloud-app-missing' });
    expect(codeErrorText(err, 'fallback').message).toBe("Nextcloud's Bookmarks app didn't answer. Check it's installed.");
  });
});
