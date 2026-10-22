import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Chat } from '@otherbench/core/ports/store.js';
import type { DeckCardDetail } from '@otherbench/core/types/nextcloud.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: { ...actual.api, chats: { ...actual.api.chats, create: vi.fn() }, turns: { ...actual.api.turns, create: vi.fn() }, notes: { ...actual.api.notes, send: vi.fn() } },
  };
});

import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { cardDraft, startChatFromCard } from './startChatFromCard.js';

const app: App = { id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: 7, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
const card: DeckCardDetail = {
  id: 966, title: 'Terminal', stackId: 2, labels: [], duedate: null, done: false, archived: false,
  description: 'A built-in terminal.', boardId: 7, boardTitle: 'OtherBench', stackTitle: 'Doing', createdAt: 1, url: 'https://nc.example/index.php/apps/deck/board/7/card/966',
};
const created: Chat = {
  id: 'c9', title: 'Deck #966 Terminal', profileId: 'prof', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId: 'a1', memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ apps: [app], appsLoaded: true });
  vi.mocked(api.chats.create).mockResolvedValue(created);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('startChatFromCard', () => {
  it("creates a titled chat, prefills, opens the card in the chat's deck view, never sends", async () => {
    await startChatFromCard(app, card);
    expect(api.chats.create).toHaveBeenCalledWith({ appId: 'a1', title: 'Deck #966 Terminal' });
    const state = useOtherBenchStore.getState();
    expect(state.chats.map((c) => c.id)).toEqual(['c9']);
    expect(state.activeChatId).toBe('c9');
    expect(state.composerPrefills['c9']).toBe('Deck #966 Terminal\nhttps://nc.example/index.php/apps/deck/board/7/card/966\n\nA built-in terminal.');
    expect(state.deckViews['c9']).toEqual({ stackId: 2, selected: 966 });
    expect(state.deckCards[966]).toEqual(card);
    expect(api.turns.create).not.toHaveBeenCalled();
    expect(api.notes.send).not.toHaveBeenCalled();
  });

  it('a card with a blank description leaves just the number, title and URL', () => {
    expect(cardDraft({ ...card, description: '  \n' })).toBe('Deck #966 Terminal\nhttps://nc.example/index.php/apps/deck/board/7/card/966');
  });

  it('a failed create opens nothing and rejects', async () => {
    vi.mocked(api.chats.create).mockRejectedValue(new Error('nope'));
    await expect(startChatFromCard(app, card)).rejects.toThrow('nope');
    expect(useOtherBenchStore.getState().chats).toEqual([]);
    expect(useOtherBenchStore.getState().deckViews).toEqual({});
  });
});
