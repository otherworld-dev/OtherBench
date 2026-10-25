import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';
import type { DeckBoardView, DeckCardDetail, DeckCardSummary } from '@otherbench/core/types/nextcloud.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      apps: { ...actual.api.apps, deck: { board: vi.fn(), create: vi.fn() } },
      nextcloud: {
        ...actual.api.nextcloud,
        card: vi.fn(),
        updateCard: vi.fn(),
        cardAction: vi.fn(),
        moveCard: vi.fn(),
        labels: vi.fn(),
        deleteCard: vi.fn(),
      },
    },
  };
});
vi.mock('../desktop/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktop/bridge.js')>();
  return { ...actual, openInBrowser: vi.fn(async () => undefined) };
});
vi.mock('./startChatFromCard.js', () => ({ startChatFromCard: vi.fn(async () => undefined) }));

import { openInBrowser } from '../desktop/bridge.js';
import { ApiError, api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { DeckTab } from './DeckTab.js';
import { startChatFromCard } from './startChatFromCard.js';

const app = (over: Partial<App> = {}): App => ({
  id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: 7, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const feature = { id: 5, title: 'feature', color: '00aa00' };
const bug = { id: 6, title: 'bug', color: 'aa0000' };
const summary = (id: number, title: string, stackId: number, over: Partial<DeckCardSummary> = {}): DeckCardSummary => ({
  id, title, stackId, labels: [], duedate: null, done: false, archived: false, ...over,
});
const board = (): DeckBoardView => ({
  board: { id: 7, title: 'OtherBench' },
  stacks: [
    { id: 1, title: 'Backlog', order: 0, cards: [summary(901, 'Old idea', 1)] },
    { id: 2, title: 'Doing', order: 1, cards: [summary(966, 'Terminal', 2, { labels: [feature] }), summary(970, 'Shipped thing', 2, { done: true })] },
    { id: 3, title: 'Done', order: 2, cards: [] },
  ],
  archived: [summary(950, 'Put away', 2, { archived: true, done: true })],
  labels: [feature, bug],
  doingStackId: 2,
  url: 'https://nc.example/index.php/apps/deck/board/7',
});
const detail = (over: Partial<DeckCardDetail> = {}): DeckCardDetail => ({
  ...summary(966, 'Terminal', 2, { labels: [feature] }),
  description: 'See ![diagram](https://example.com/d.png) and **this**.',
  boardId: 7,
  boardTitle: 'OtherBench',
  stackTitle: 'Doing',
  createdAt: 1_760_000_000,
  url: 'https://nc.example/index.php/apps/deck/board/7/card/966',
  ...over,
});

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  vi.mocked(api.apps.deck.board).mockResolvedValue(board());
  vi.mocked(api.apps.deck.create).mockResolvedValue(detail({ id: 980, title: 'New one', stackId: 2, labels: [], description: '' }));
  vi.mocked(api.nextcloud.card).mockImplementation(async (id: number) => (id === 980 ? detail({ id: 980, title: 'New one', labels: [], description: '' }) : detail()));
  vi.mocked(api.nextcloud.updateCard).mockResolvedValue(detail());
  vi.mocked(api.nextcloud.cardAction).mockResolvedValue(undefined);
  vi.mocked(api.nextcloud.moveCard).mockResolvedValue(undefined);
  vi.mocked(api.nextcloud.labels).mockResolvedValue(undefined);
  vi.mocked(api.nextcloud.deleteCard).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Renders the tab and opens card 966 from the Doing column. */
async function openTerminal(a: App = app()): Promise<{ user: ReturnType<typeof userEvent.setup>; view: HTMLElement }> {
  const user = userEvent.setup();
  render(<DeckTab app={a} owner="c1" />);
  await user.click(await screen.findByTestId('card-row-966'));
  const view = await screen.findByTestId('card-detail');
  return { user, view };
}

describe('DeckTab', () => {
  it('without a board it shows the alert and fetches nothing', async () => {
    render(<DeckTab app={app({ deckBoardId: null })} owner="c1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No Deck board set for this app');
    expect(api.apps.deck.board).not.toHaveBeenCalled();
  });

  it('opens on the Doing column and lists its cards with numbers', async () => {
    render(<DeckTab app={app()} owner="c1" />);
    const row = await screen.findByTestId('card-row-966');
    expect(row).toHaveTextContent('#966');
    expect(row).toHaveTextContent('Terminal');
    expect(within(row).getByText('feature')).toBeInTheDocument();
    expect(api.apps.deck.board).toHaveBeenCalledWith('a1');
    expect(screen.getByText('OtherBench')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Doing 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Backlog 1' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Done 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archived 1' })).toBeInTheDocument();
    expect(screen.queryByTestId('card-row-901')).not.toBeInTheDocument();
    expect(screen.queryByText('Old idea')).not.toBeInTheDocument();
  });

  it('switching column is remembered for the owner', async () => {
    const user = userEvent.setup();
    render(<DeckTab app={app()} owner="c1" />);
    await screen.findByTestId('card-row-966');
    await user.click(screen.getByRole('button', { name: 'Backlog 1' }));
    expect(await screen.findByTestId('card-row-901')).toHaveTextContent('Old idea');
    expect(screen.queryByTestId('card-row-966')).not.toBeInTheDocument();
    expect(useOtherBenchStore.getState().deckViews['c1']?.stackId).toBe(1);
  });

  it('a remembered column that no longer exists falls back to Doing', async () => {
    useOtherBenchStore.getState().setDeckView('c1', { stackId: 99 });
    render(<DeckTab app={app()} owner="c1" />);
    expect(await screen.findByTestId('card-row-966')).toBeInTheDocument();
  });

  it('Archived lists archived cards', async () => {
    const user = userEvent.setup();
    render(<DeckTab app={app()} owner="c1" />);
    await screen.findByTestId('card-row-966');
    await user.click(screen.getByRole('button', { name: 'Archived 1' }));
    expect(await screen.findByTestId('card-row-950')).toHaveTextContent('Put away');
    expect(screen.queryByTestId('card-row-966')).not.toBeInTheDocument();
    expect(useOtherBenchStore.getState().deckViews['c1']?.stackId).toBe('archived');
  });

  it('a done but unarchived card shows a tick in its column', async () => {
    render(<DeckTab app={app()} owner="c1" />);
    const done = await screen.findByTestId('card-row-970');
    expect(within(done).getByLabelText('Done')).toHaveTextContent('✓');
    expect(within(screen.getByTestId('card-row-966')).queryByLabelText('Done')).not.toBeInTheDocument();
  });

  it('opening a card shows its description; a remote image is not loaded', async () => {
    const { user, view } = await openTerminal();
    expect(api.nextcloud.card).toHaveBeenCalledWith(966, 7);
    expect(within(view).getByRole('heading', { name: '#966 Terminal' })).toBeInTheDocument();
    expect(within(view).getByText('this').tagName).toBe('STRONG');
    expect(within(view).getByText('[image: diagram]')).toBeInTheDocument();
    expect(view.querySelector('img')).toBeNull();
    expect(within(view).getByTestId('card-column')).toHaveTextContent('Doing');
    expect(within(view).queryByText(/^On the .* board$/)).not.toBeInTheDocument();
    await user.click(within(view).getByRole('link', { name: /Open in Nextcloud/ }));
    expect(openInBrowser).toHaveBeenCalledWith('https://nc.example/index.php/apps/deck/board/7/card/966');
    await user.click(screen.getByRole('button', { name: 'Back to the board' }));
    expect(await screen.findByTestId('card-row-966')).toBeInTheDocument();
    expect(useOtherBenchStore.getState().deckViews['c1']?.selected).toBeNull();
  });

  it('a card on another board says which board', async () => {
    vi.mocked(api.nextcloud.card).mockResolvedValue(detail({ boardId: 12, boardTitle: 'Glados MCP', stackTitle: 'To Do' }));
    const { view } = await openTerminal();
    expect(within(view).getByText('On the Glados MCP board')).toBeInTheDocument();
  });

  it("a card on another board is fetched and changed on its own board, so nothing rescans the app's", async () => {
    vi.mocked(api.nextcloud.card).mockResolvedValue(detail({ boardId: 12, boardTitle: 'Glados MCP', stackTitle: 'To Do' }));
    const { user, view } = await openTerminal();
    expect(api.nextcloud.card).toHaveBeenLastCalledWith(966, 7);
    await user.click(within(view).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.nextcloud.cardAction).toHaveBeenCalledWith(966, 'done', 12));
    await waitFor(() => expect(api.nextcloud.card).toHaveBeenCalledTimes(2));
    expect(api.nextcloud.card).toHaveBeenLastCalledWith(966, 12);
  });

  it('a card deleted elsewhere shows the error, drops the cached card and reloads the list', async () => {
    await openTerminal();
    expect(api.apps.deck.board).toHaveBeenCalledTimes(1);
    vi.mocked(api.nextcloud.card).mockRejectedValue(
      new ApiError(404, "Deck card #966 isn't on any board this account can see.", undefined, { code: 'nextcloud-not-found' })
    );
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent("Deck card #966 isn't on any board this account can see.");
    await waitFor(() => expect(useOtherBenchStore.getState().deckCards[966]).toBeUndefined());
    // The focus refresh and the reload after the card went missing.
    await waitFor(() => expect(api.apps.deck.board).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument();
  });

  it('a refresh that fails for another reason shows the error above the cached card', async () => {
    const { view } = await openTerminal();
    vi.mocked(api.nextcloud.card).mockRejectedValue(new ApiError(409, "Couldn't reach Nextcloud at https://nc.example.", undefined, { code: 'nextcloud-unreachable' }));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await within(view).findByRole('alert')).toHaveTextContent("Couldn't reach Nextcloud at https://nc.example.");
    expect(within(view).getByRole('heading', { name: '#966 Terminal' })).toBeInTheDocument();
    expect(useOtherBenchStore.getState().deckCards[966]).toBeDefined();
  });

  it('a failed action fetches the board and the card again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.nextcloud.cardAction).mockRejectedValue(new ApiError(409, 'Nextcloud answered HTTP 500.', undefined, { code: 'nextcloud-failed' }));
    const { user, view } = await openTerminal();
    expect(api.apps.deck.board).toHaveBeenCalledTimes(1);
    await user.click(within(view).getByRole('button', { name: 'Archive' }));
    expect(await within(view).findByRole('alert')).toHaveTextContent('Nextcloud answered HTTP 500.');
    await waitFor(() => expect(api.apps.deck.board).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.nextcloud.card).toHaveBeenCalledTimes(2));
  });

  it('Move to calls moveCard and refetches', async () => {
    const { user, view } = await openTerminal();
    expect(api.nextcloud.card).toHaveBeenCalledTimes(1);
    expect(api.apps.deck.board).toHaveBeenCalledTimes(1);
    await user.selectOptions(within(view).getByRole('combobox', { name: 'Move to' }), 'Backlog');
    await waitFor(() => expect(api.nextcloud.moveCard).toHaveBeenCalledWith(966, 1, 7));
    await waitFor(() => expect(api.nextcloud.card).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.apps.deck.board).toHaveBeenCalledTimes(2));
  });

  it('Done calls cardAction done', async () => {
    const { user, view } = await openTerminal();
    await user.click(within(view).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.nextcloud.cardAction).toHaveBeenCalledWith(966, 'done', 7));
    await waitFor(() => expect(api.nextcloud.card).toHaveBeenCalledTimes(2));
  });

  it('Archive calls cardAction archive', async () => {
    const { user, view } = await openTerminal();
    await user.click(within(view).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(api.nextcloud.cardAction).toHaveBeenCalledWith(966, 'archive', 7));
  });

  it('Reopen shows for an archived card', async () => {
    vi.mocked(api.nextcloud.card).mockResolvedValue(detail({ archived: true, done: true }));
    const { user, view } = await openTerminal();
    expect(within(view).queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    expect(within(view).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    await user.click(within(view).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(api.nextcloud.cardAction).toHaveBeenCalledWith(966, 'reopen', 7));
  });

  it('Labels toggles a label on the card', async () => {
    const { user, view } = await openTerminal();
    await user.click(within(view).getByRole('button', { name: 'Labels' }));
    expect(within(view).getByRole('checkbox', { name: 'feature' })).toBeChecked();
    await user.click(within(view).getByRole('checkbox', { name: 'bug' }));
    await waitFor(() => expect(api.nextcloud.labels).toHaveBeenCalledWith(966, { add: [6] }, 7));
    await user.click(within(view).getByRole('checkbox', { name: 'feature' }));
    await waitFor(() => expect(api.nextcloud.labels).toHaveBeenCalledWith(966, { remove: [5] }, 7));
  });

  it('Delete asks first, then deletes and returns to the list', async () => {
    const { user, view } = await openTerminal();
    await user.click(within(view).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete card #966?' });
    expect(api.nextcloud.deleteCard).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.nextcloud.deleteCard).toHaveBeenCalledWith(966, 7));
    expect(await screen.findByTestId('card-row-966')).toBeInTheDocument();
    expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.nextcloud.card).toHaveBeenCalledTimes(1);
    expect(useOtherBenchStore.getState().deckCards[966]).toBeUndefined();
  });

  it('Edit saves title, description and due date; a cleared due date sends null', async () => {
    const { user, view } = await openTerminal();
    await user.click(within(view).getByRole('button', { name: 'Edit' }));
    const title = within(view).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue('Terminal');
    await user.clear(title);
    await user.type(title, 'Built-in terminal');
    const description = within(view).getByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.type(description, 'New text');
    const due = within(view).getByLabelText('Due date');
    await user.type(due, '2026-11-05');
    await user.click(within(view).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.nextcloud.updateCard).toHaveBeenCalledWith(
        966,
        { title: 'Built-in terminal', description: 'New text', duedate: new Date('2026-11-05T00:00:00').toISOString() },
        7
      )
    );
    await waitFor(() => expect(within(view).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());

    vi.mocked(api.nextcloud.card).mockResolvedValue(detail({ duedate: '2026-11-05T00:00:00+00:00' }));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(api.nextcloud.card).toHaveBeenCalledTimes(3));
    await user.click(within(view).getByRole('button', { name: 'Edit' }));
    await user.clear(within(view).getByLabelText('Due date'));
    await user.click(within(view).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.nextcloud.updateCard).toHaveBeenLastCalledWith(966, { duedate: null }, 7));
  });

  it('a deck-move-ignored error shows the server message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.nextcloud.moveCard).mockRejectedValue(
      new ApiError(409, 'Deck ignored the move; the card is still in Doing.', undefined, { code: 'deck-move-ignored' })
    );
    const { user, view } = await openTerminal();
    await user.selectOptions(within(view).getByRole('combobox', { name: 'Move to' }), 'Done');
    expect(await within(view).findByRole('alert')).toHaveTextContent('Deck ignored the move; the card is still in Doing.');
  });

  it('+ Card creates in the shown column and opens it', async () => {
    const user = userEvent.setup();
    render(<DeckTab app={app()} owner="c1" />);
    await screen.findByTestId('card-row-966');
    await user.click(screen.getByRole('button', { name: '+ Card' }));
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'New card title' }), 'New one');
    await user.type(screen.getByRole('textbox', { name: 'New card description' }), 'Some detail');
    await user.click(add);
    await waitFor(() => expect(api.apps.deck.create).toHaveBeenCalledWith('a1', { stackId: 2, title: 'New one', description: 'Some detail' }));
    const view = await screen.findByTestId('card-detail');
    expect(within(view).getByRole('heading', { name: '#980 New one' })).toBeInTheDocument();
    expect(useOtherBenchStore.getState().deckViews['c1']?.selected).toBe(980);
  });

  it('Chat on a row starts a chat from the card', async () => {
    const user = userEvent.setup();
    const a = app();
    render(<DeckTab app={a} owner="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Start a chat on #966' }));
    await waitFor(() => expect(startChatFromCard).toHaveBeenCalledWith(a, detail()));
    expect(api.nextcloud.card).toHaveBeenCalledWith(966, 7);
    expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument();
  });

  it('"Start a chat on this" starts a chat from the open card', async () => {
    const a = app();
    const { user, view } = await openTerminal(a);
    await user.click(within(view).getByRole('button', { name: 'Start a chat on this' }));
    expect(startChatFromCard).toHaveBeenCalledWith(a, detail());
  });

  it('refreshes on window focus', async () => {
    render(<DeckTab app={app()} owner="c1" />);
    await screen.findByTestId('card-row-966');
    expect(api.apps.deck.board).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(api.apps.deck.board).toHaveBeenCalledTimes(2));
  });

  it('a board that fails to load says why', async () => {
    vi.mocked(api.apps.deck.board).mockRejectedValue(new ApiError(409, 'Nextcloud is not configured.', undefined, { code: 'nextcloud-not-configured' }));
    render(<DeckTab app={app()} owner="c1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Nextcloud isn't set up on this machine");
  });
});
