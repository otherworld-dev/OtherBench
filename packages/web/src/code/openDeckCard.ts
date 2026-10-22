import { openInBrowser } from '../desktop/bridge.js';
import { toast } from '../lib/toasts.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { panelOwner } from './panelOwner.js';

/**
 * A "Deck #N" in a message, clicked (spec 2026-10-22-nextcloud-tabs). In Code
 * mode, with the focused pane in an app that has a Deck board, the Code
 * panel's Deck tab opens on the card, in the focused chat's (or app home's)
 * Deck view; the tab fetches it from there. Otherwise the card is found on
 * whichever board holds it and opened in Nextcloud in the browser.
 */
export async function openDeckCard(cardId: number): Promise<void> {
  const state = useOtherBenchStore.getState();
  const at = state.mode === 'code' ? panelOwner(state) : null;
  // An app without a board would show "no Deck board" rather than the card.
  if (at && at.app.deckBoardId !== null) {
    state.setCodePanelTab('deck');
    state.setDeckView(at.owner, { selected: cardId });
    return;
  }
  try {
    const card = await api.nextcloud.card(cardId);
    // Only a website goes to the browser, whatever the server answered.
    if (!/^https?:\/\//i.test(card.url)) throw new Error(`Deck #${cardId} has no web URL`);
    await openInBrowser(card.url);
  } catch (err) {
    console.error(`[otherbench-web] couldn't open Deck #${cardId}:`, err);
    toast({ text: `Couldn't open Deck #${cardId}.`, tone: 'error' });
  }
}
