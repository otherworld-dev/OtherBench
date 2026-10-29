import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';
import type { GithubNotification, Overview, OverviewTile as Tile } from '@otherbench/core/types/overview.js';

vi.mock('./openFromOverview.js', () => ({ openChat: vi.fn(), openApp: vi.fn(), openIssue: vi.fn(), openCard: vi.fn() }));
vi.mock('../desktop/bridge.js', async (importOriginal) => ({ ...(await importOriginal<object>()), openInBrowser: vi.fn(async () => {}) }));
vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, overview: { ...actual.api.overview, refresh: vi.fn(), markDone: vi.fn(), markRead: vi.fn(), tickOlder: vi.fn() }, chats: { ...actual.api.chats, patch: vi.fn() } } };
});

import { openInBrowser } from '../desktop/bridge.js';
import { useToasts } from '../lib/toasts.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { openCard, openChat, openApp, openIssue } from './openFromOverview.js';
import { OverviewJumpList } from './OverviewJumpList.js';
import { OverviewView } from './OverviewView.js';

const note = (n: number, over: Partial<GithubNotification> = {}): GithubNotification => ({
  id: String(n), repo: 'o/a', kind: 'issue', title: `Issue ${n}`, number: n, reason: 'review_requested', unread: false,
  updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), url: `https://github.com/o/a/issues/${n}`, ...over,
});

const tile = (key: string, over: Partial<Tile> = {}): Tile => ({
  key, appId: key === 'chats' ? null : key, name: key.toUpperCase(), count: 0, faded: false, chats: [],
  notifications: [], notificationsError: null, notificationsMore: false, deck: { due: [], doing: 1, todo: 2, backlog: 3 }, deckError: null, ...over,
});

const overview = (tiles: Tile[], over: Partial<Overview> = {}): Overview => ({
  checkedAt: new Date(2026, 9, 26, 7, 42).getTime(), checking: false, githubLogin: 'me', loginMismatches: [], unreachableMachines: [], total: 5, tiles, ...over,
});

/** Shows `o`, with an app in the store for each app tile (the Chat action needs the app). */
function show(o: Overview | null): void {
  const apps = (o?.tiles ?? []).filter((t) => t.appId !== null).map((t) => ({ id: t.appId, name: t.name, githubRepo: 'o/a' }) as App);
  act(() => useOtherBenchStore.setState({ overview: o, overviewOpen: true, apps }));
}

describe('OverviewView', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows a loading state while the overview has not arrived', () => {
    show(null);
    render(<OverviewView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders tiles in the given order, faded ones at half opacity, with counts', () => {
    show(overview([tile('b', { count: 3, notifications: [note(1)] }), tile('a', { faded: true })]));
    render(<OverviewView />);
    const tiles = screen.getAllByTestId(/^overview-tile-/);
    expect(tiles.map((t) => t.getAttribute('data-testid'))).toEqual(['overview-tile-b', 'overview-tile-a']);
    expect(tiles[1]).toHaveClass('opacity-50');
    expect(tiles[0]).not.toHaveClass('opacity-50');
    expect(within(tiles[0]!).getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/checked 07:42/)).toBeInTheDocument();
  });

  it('shows checking… and the unreachable and login lines', () => {
    show(overview([], { checkedAt: null, checking: true, unreachableMachines: ['Laptop'], loginMismatches: [{ machine: 'Laptop', login: 'x' }] }));
    render(<OverviewView />);
    expect(screen.getByText(/checking…/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn't reach Laptop/)).toBeInTheDocument();
    expect(screen.getByText(/Laptop's gh is signed in as x, this machine's as me/)).toBeInTheDocument();
  });

  it('refresh stores the returned overview', async () => {
    show(overview([]));
    const next = overview([tile('z')], { total: 9 });
    vi.mocked(api.overview.refresh).mockResolvedValue(next);
    render(<OverviewView />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('overview-refresh'));
    });
    expect(useOtherBenchStore.getState().overview).toBe(next);
  });

  it('omits the GitHub and Deck sections when the app has no repo or board', () => {
    show(overview([tile('a', { notifications: null, deck: null })]));
    render(<OverviewView />);
    expect(screen.queryByText('GitHub')).toBeNull();
    expect(screen.queryByText('Deck')).toBeNull();
  });

  it('lists three notifications, then "+N more" expands in place', () => {
    show(overview([tile('a', { notifications: [1, 2, 3, 4, 5].map((n) => note(n)) })]));
    render(<OverviewView />);
    expect(screen.queryByTestId('overview-notification-4')).toBeNull();
    fireEvent.click(screen.getByTestId('overview-more-a'));
    expect(screen.getByTestId('overview-notification-5')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-more-a')).toBeNull();
    expect(openApp).not.toHaveBeenCalled();
  });

  it('a row shows kind, reason and age, bold while unread; an issue opens in the app and is marked read', async () => {
    vi.mocked(api.overview.markRead).mockResolvedValue(overview([]));
    show(overview([tile('a', { notifications: [note(7, { unread: true })] })]));
    render(<OverviewView />);
    const row = screen.getByTestId('overview-notification-7');
    expect(within(row).getByText('issue')).toBeInTheDocument();
    expect(row).toHaveTextContent('#7 Issue 7');
    expect(row).toHaveTextContent('review requested · 2h');
    expect(row.querySelector('.font-semibold')).not.toBeNull();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(openIssue).toHaveBeenCalledWith('a', 7, 'open');
    expect(api.overview.markRead).toHaveBeenCalledWith('7');
    expect(openApp).not.toHaveBeenCalled();
  });

  it('a PR, CI run or anything in the GitHub tile opens in the browser; a read one is not marked again', () => {
    show(overview([
      tile('a', { notifications: [note(9, { kind: 'pr', url: 'https://github.com/o/a/pull/9' }), note(3, { kind: 'ci', number: null, title: 'CI failed', url: 'https://github.com/o/a/actions' })] }),
      tile('github', { appId: null, name: 'GitHub', deck: null, notifications: [note(5, { repo: 'o/else', url: 'https://github.com/o/else/issues/5' })] }),
    ]));
    render(<OverviewView />);
    fireEvent.click(screen.getByTestId('overview-notification-9'));
    fireEvent.click(screen.getByTestId('overview-notification-3'));
    fireEvent.click(screen.getByTestId('overview-notification-5'));
    expect(vi.mocked(openInBrowser).mock.calls.map((c) => c[0])).toEqual(['https://github.com/o/a/pull/9', 'https://github.com/o/a/actions', 'https://github.com/o/else/issues/5']);
    expect(openIssue).not.toHaveBeenCalled();
    expect(api.overview.markRead).not.toHaveBeenCalled();
    expect(screen.getByTestId('overview-notification-3')).toHaveTextContent('CI failed');
    expect(screen.getByTestId('overview-notification-3')).not.toHaveTextContent('#');
    expect(within(screen.getByTestId('overview-tile-github')).getByText('o/else')).toBeInTheDocument();
    expect(screen.getByTestId('overview-notification-5')).not.toHaveTextContent('o/else');
  });

  it('offers Chat only in an app tile, since a chat needs an app', () => {
    show(overview([tile('a', { notifications: [note(7)] }), tile('github', { appId: null, name: 'GitHub', deck: null, notifications: [note(8)] })]));
    render(<OverviewView />);
    expect(screen.getByRole('button', { name: 'Start a chat on #7 Issue 7' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start a chat on #8 Issue 8' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done: #8 Issue 8' })).toBeInTheDocument();
  });

  it('More on GitHub links the inbox when there were more than fetched', () => {
    show(overview([tile('a', { notifications: [note(1)], notificationsMore: true })]));
    render(<OverviewView />);
    fireEvent.click(screen.getByRole('button', { name: 'More on GitHub' }));
    expect(openInBrowser).toHaveBeenCalledWith('https://github.com/notifications');
  });

  it('the tile background opens the app', () => {
    show(overview([tile('a')]));
    render(<OverviewView />);
    fireEvent.click(screen.getByTestId('overview-tile-a'));
    expect(openApp).toHaveBeenCalledWith('a');
  });

  it('the tile name is a button that opens the app', () => {
    show(overview([tile('a')]));
    render(<OverviewView />);
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    expect(openApp).toHaveBeenCalledTimes(1);
    expect(openApp).toHaveBeenCalledWith('a');
  });

  it('renders errors as one line in their section', () => {
    show(overview([tile('a', { notifications: [], notificationsError: 'gh failed', deck: null })]));
    render(<OverviewView />);
    expect(screen.getByText('gh failed')).toBeInTheDocument();
  });

  it('shows due cards and counts; a due card opens the card', () => {
    const deck = { due: [{ cardId: 4, title: 'Release', duedate: '', overdueDays: 0 }, { cardId: 5, title: 'Shots', duedate: '', overdueDays: 2 }], doing: 1, todo: 2, backlog: 3 };
    show(overview([tile('a', { deck })]));
    render(<OverviewView />);
    const card = screen.getByTestId('overview-card-4');
    expect(card).toHaveTextContent('due today');
    expect(screen.getByTestId('overview-card-5')).toHaveTextContent('overdue 2d');
    expect(card).toHaveClass('text-[var(--danger)]');
    expect(screen.getByText(/Doing 1 · To Do 2 · Backlog 3/)).toBeInTheDocument();
    fireEvent.click(card);
    expect(openCard).toHaveBeenCalledWith('a', 4);
  });

  it('groups chats under project names and opens a chat on click', () => {
    const chats = [
      { chatId: 'c1', title: 'One', waiting: true, at: 1, projectId: 'p', projectName: 'Plan' },
      { chatId: 'c2', title: 'Two', waiting: false, at: 1, projectId: null, projectName: null },
    ];
    show(overview([tile('chats', { chats, notifications: null, deck: null })]));
    render(<OverviewView />);
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('No project')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('overview-chat-c1'));
    expect(openChat).toHaveBeenCalledWith('c1');
    expect(openApp).not.toHaveBeenCalled();
  });

  it("lists an app tile's chats flat, with no project sub-headings", () => {
    const chats = [
      { chatId: 'c1', title: 'One', waiting: false, at: 1, projectId: null, projectName: null },
      { chatId: 'c2', title: 'Two', waiting: false, at: 1, projectId: 'p', projectName: 'Plan' },
    ];
    show(overview([tile('a', { chats })]));
    render(<OverviewView />);
    expect(screen.getByTestId('overview-chat-c1')).toBeInTheDocument();
    expect(screen.getByTestId('overview-chat-c2')).toBeInTheDocument();
    expect(screen.queryByText('No project')).toBeNull();
    expect(screen.queryByText('Plan')).toBeNull();
  });
});

describe('OverviewView tick-off', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const chats = [{ chatId: 'c1', title: 'One', waiting: false, at: 1, projectId: null, projectName: null }];

  it('a waiting chat has Archive but no Tick off: the reply it waits on would land before the tick and never show', () => {
    show(overview([tile('chats', { chats: [{ ...chats[0]!, waiting: true }], notifications: null, deck: null })]));
    render(<OverviewView />);
    expect(screen.queryByRole('button', { name: 'Tick off One' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Archive One' })).toBeInTheDocument();
  });

  it('row actions take no room until the row is hovered or has focus', () => {
    show(overview([tile('chats', { chats, notifications: null, deck: null }), tile('a', { notifications: [note(7)] })]));
    render(<OverviewView />);
    for (const name of ['Tick off One', 'Archive One', 'Done: #7 Issue 7', 'Start a chat on #7 Issue 7']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toHaveClass('hidden', 'group-hover:inline-flex', 'group-focus-within:inline-flex');
      expect(button, name).not.toHaveClass('opacity-0');
    }
  });

  it('Tick off on a chat sets dealtWithAt; Archive sets archivedAt', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    vi.mocked(api.chats.patch).mockResolvedValue({} as never);
    show(overview([tile('chats', { chats, notifications: null, deck: null })]));
    render(<OverviewView />);
    fireEvent.click(screen.getByRole('button', { name: 'Tick off One' }));
    expect(api.chats.patch).toHaveBeenCalledWith('c1', { dealtWithAt: 1234 });
    fireEvent.click(screen.getByRole('button', { name: 'Archive One' }));
    expect(api.chats.patch).toHaveBeenCalledWith('c1', { archivedAt: 1234 });
    expect(openChat).not.toHaveBeenCalled();
  });

  it('Done takes the row away at once and stores the answer', async () => {
    const next = overview([tile('a', { notifications: [] })], { total: 0 });
    let answer: (o: Overview) => void = () => {};
    vi.mocked(api.overview.markDone).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    show(overview([tile('a', { count: 1, notifications: [note(7)] })], { total: 1 }));
    render(<OverviewView />);
    fireEvent.click(screen.getByRole('button', { name: 'Done: #7 Issue 7' }));
    expect(api.overview.markDone).toHaveBeenCalledWith('7');
    expect(screen.queryByTestId('overview-notification-7')).toBeNull();
    expect(useOtherBenchStore.getState().overview?.total).toBe(0);
    await act(async () => answer(next));
    expect(useOtherBenchStore.getState().overview).toBe(next);
    expect(openIssue).not.toHaveBeenCalled();
  });

  it('Done that GitHub refuses puts the row back and says so', async () => {
    vi.mocked(api.overview.markDone).mockRejectedValue(new Error('HTTP 500'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = overview([tile('a', { count: 1, notifications: [note(7)] })], { total: 1 });
    show(before);
    render(<OverviewView />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done: #7 Issue 7' }));
    });
    expect(useOtherBenchStore.getState().overview).toBe(before);
    expect(screen.getByTestId('overview-notification-7')).toBeInTheDocument();
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ text: "Couldn't mark that done on GitHub.", tone: 'error' });
  });

  it('Tick off older than… sends now minus the span after a confirm step, then says what it did', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(api.overview.tickOlder).mockResolvedValue({ chats: 12 });
    show(overview([tile('a')]));
    render(<OverviewView />);
    fireEvent.click(screen.getByRole('button', { name: 'Tick off older than…' }));
    fireEvent.click(screen.getByRole('button', { name: '1 week' }));
    expect(api.overview.tickOlder).not.toHaveBeenCalled();
    expect(screen.getByText(/counts are unknown until it's done/i)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    expect(api.overview.tickOlder).toHaveBeenCalledWith(now - 7 * 86_400_000);
    expect(screen.getByText('Ticked off 12 chats')).toBeInTheDocument();
  });

  it('Everything sends now', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(api.overview.tickOlder).mockResolvedValue({ chats: 1 });
    show(overview([]));
    render(<OverviewView />);
    fireEvent.click(screen.getByRole('button', { name: 'Tick off older than…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Everything' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    expect(api.overview.tickOlder).toHaveBeenCalledWith(now);
    expect(screen.getByText('Ticked off 1 chat')).toBeInTheDocument();
  });
});

describe('OverviewJumpList', () => {
  afterEach(cleanup);

  it('lists tile names with counts and scrolls the tile into view', () => {
    show(overview([tile('a', { count: 2 }), tile('b')]));
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <>
        <OverviewJumpList />
        <OverviewView />
      </>,
    );
    const button = screen.getByTestId('overview-jump-a');
    expect(button).toHaveTextContent('2');
    fireEvent.click(button);
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});
