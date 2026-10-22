import type { App } from '@otherbench/core/ports/store.js';
import type { DeckCardDetail } from '@otherbench/core/types/nextcloud.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';

/** What the new chat's box starts with: "Deck #N" and the title, the card's URL, then its description when it has one. */
export function cardDraft(card: DeckCardDetail): string {
  const head = `Deck #${card.id} ${card.title}\n${card.url}`;
  return card.description.trim() === '' ? head : `${head}\n\n${card.description}`;
}

/**
 * "Start a chat on this" for a Deck card (spec 2026-10-22-nextcloud-tabs,
 * Goal 2), as `startChatFromIssue` does for an issue: a new chat in the app,
 * titled after the card, opened, with the card in its composer. It is never
 * sent. The chat is put in the store before it is opened, and its Deck view
 * opens on the card, in the card's column, so the card is at hand while the
 * chat works on it. A failed create opens nothing and rejects.
 */
export async function startChatFromCard(app: App, card: DeckCardDetail): Promise<void> {
  const chat = await api.chats.create({ appId: app.id, title: `Deck #${card.id} ${card.title}` });
  const { upsertChat, prefillComposer, setActiveChatId, cacheDeckCard, setDeckView } = useOtherBenchStore.getState();
  upsertChat(chat);
  cacheDeckCard(card);
  setDeckView(chat.id, { stackId: card.stackId, selected: card.id });
  prefillComposer(chat.id, cardDraft(card));
  setActiveChatId(chat.id);
}
