import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Chat } from '@otherbench/core/ports/store.js';
import type { DeckCardDetail } from '@otherbench/core/types/nextcloud.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, nextcloud: { ...actual.api.nextcloud, card: vi.fn() } } };
});
vi.mock('../desktop/bridge.js', () => ({ openInBrowser: vi.fn(async () => {}) }));

import { openInBrowser } from '../desktop/bridge.js';
import { useToasts } from '../lib/toasts.js';
import { NARROW_BREAKPOINT } from '../lib/useMediaQuery.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { openDeckCard } from './openDeckCard.js';

const app: App = { id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: 7, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
const chat: Chat = {
  id: 'c1', title: 'Work', profileId: 'prof', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId: 'a1', memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
};
const card: DeckCardDetail = {
  id: 967, title: 'Links', stackId: 2, labels: [], duedate: null, done: false, archived: false,
  description: '', boardId: 7, boardTitle: 'OtherBench', stackTitle: 'Doing', createdAt: 1, url: 'https://nc.example/index.php/apps/deck/board/7/card/967',
};

beforeEach(() => {
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ apps: [app], chats: [chat], activeChatId: 'c1', codePanelTab: 'issues' });
  useToasts.setState({ toasts: [] });
  vi.mocked(api.nextcloud.card).mockResolvedValue(card);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('openDeckCard', () => {
  it('in code mode opens the Deck tab on the card for the focused chat', async () => {
    useOtherBenchStore.setState({ mode: 'code' });
    await openDeckCard(967);
    const state = useOtherBenchStore.getState();
    expect(state.codePanelTab).toBe('deck');
    expect(state.deckViews['c1']).toEqual({ stackId: null, selected: 967 });
    expect(api.nextcloud.card).not.toHaveBeenCalled();
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('in code mode expands a collapsed panel so the card shows', async () => {
    useOtherBenchStore.setState({ mode: 'code', inspectorCollapsed: true });
    await openDeckCard(967);
    const state = useOtherBenchStore.getState();
    expect(state.inspectorCollapsed).toBe(false);
    expect(state.inspectorOverlayOpen).toBe(false);
    expect(state.deckViews['c1']?.selected).toBe(967);
  });

  it('in code mode on a narrow window opens the panel overlay', async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === NARROW_BREAKPOINT, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      useOtherBenchStore.setState({ mode: 'code', inspectorCollapsed: true, inspectorOverlayOpen: false });
      await openDeckCard(967);
      const state = useOtherBenchStore.getState();
      expect(state.inspectorOverlayOpen).toBe(true);
      // The docked preference is the wide layout's; a narrow window leaves it alone.
      expect(state.inspectorCollapsed).toBe(true);
      expect(state.codePanelTab).toBe('deck');
    } finally {
      window.matchMedia = original;
    }
  });

  it("in chat mode opens the card's URL in the browser", async () => {
    useOtherBenchStore.setState({ mode: 'chat' });
    await openDeckCard(967);
    expect(api.nextcloud.card).toHaveBeenCalledWith(967);
    expect(openInBrowser).toHaveBeenCalledWith(card.url);
    expect(useOtherBenchStore.getState().codePanelTab).toBe('issues');
    expect(useOtherBenchStore.getState().deckViews).toEqual({});
  });

  it("in code mode with an app that has no Deck board it opens the card's URL instead", async () => {
    useOtherBenchStore.setState({ mode: 'code', apps: [{ ...app, deckBoardId: null }] });
    await openDeckCard(967);
    expect(openInBrowser).toHaveBeenCalledWith(card.url);
    expect(useOtherBenchStore.getState().deckViews).toEqual({});
  });

  it("a card that can't be fetched is shown as an error toast", async () => {
    useOtherBenchStore.setState({ mode: 'chat' });
    vi.mocked(api.nextcloud.card).mockRejectedValue(new Error('404'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await openDeckCard(967);
    expect(openInBrowser).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts.map((t) => [t.text, t.tone])).toEqual([["Couldn't open Deck #967.", 'error']]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
