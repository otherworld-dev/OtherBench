import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Overview, OverviewIssue, OverviewTile as Tile } from '@otherbench/core/types/overview.js';

vi.mock('./openFromOverview.js', () => ({ openChat: vi.fn(), openApp: vi.fn(), openIssue: vi.fn(), openCard: vi.fn() }));
vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, overview: { ...actual.api.overview, refresh: vi.fn() } } };
});

import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { openCard, openChat, openApp, openIssue } from './openFromOverview.js';
import { OverviewJumpList } from './OverviewJumpList.js';
import { OverviewView } from './OverviewView.js';

const issue = (n: number, over: Partial<OverviewIssue> = {}): OverviewIssue => ({
  number: n, title: `Issue ${n}`, state: 'open', kind: 'new', at: new Date(Date.now() - 2 * 3_600_000).toISOString(), who: 'sam', url: '', through: 'x', ...over,
});

const tile = (key: string, over: Partial<Tile> = {}): Tile => ({
  key, appId: key === 'chats' ? null : key, name: key.toUpperCase(), count: 0, faded: false, chats: [],
  issues: [], issuesError: null, deck: { due: [], doing: 1, todo: 2, backlog: 3 }, deckError: null, ...over,
});

const overview = (tiles: Tile[], over: Partial<Overview> = {}): Overview => ({
  checkedAt: new Date(2026, 9, 26, 7, 42).getTime(), checking: false, githubLogin: 'me', loginMismatches: [], unreachableMachines: [], total: 5, tiles, ...over,
});

function show(o: Overview | null): void {
  act(() => useOtherBenchStore.setState({ overview: o, overviewOpen: true }));
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
    show(overview([tile('b', { count: 3, issues: [issue(1)] }), tile('a', { faded: true })]));
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

  it('omits the Issues and Deck sections when the app has no repo or board', () => {
    show(overview([tile('a', { issues: null, deck: null })]));
    render(<OverviewView />);
    expect(screen.queryByText('Issues needing you')).toBeNull();
    expect(screen.queryByText('Deck')).toBeNull();
  });

  it('lists three issues, then "+N more" expands in place', () => {
    show(overview([tile('a', { issues: [1, 2, 3, 4, 5].map((n) => issue(n)) })]));
    render(<OverviewView />);
    expect(screen.queryByTestId('overview-issue-a-4')).toBeNull();
    fireEvent.click(screen.getByTestId('overview-more-a'));
    expect(screen.getByTestId('overview-issue-a-5')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-more-a')).toBeNull();
    expect(openApp).not.toHaveBeenCalled();
  });

  it('issue rows show state, kind and age; a click opens the issue without opening the app', () => {
    show(overview([tile('a', { issues: [issue(7, { state: 'closed', kind: 'comment' })] })]));
    render(<OverviewView />);
    const row = screen.getByTestId('overview-issue-a-7');
    expect(within(row).getByText('closed')).toBeInTheDocument();
    expect(row).toHaveTextContent('comment · 2h');
    fireEvent.click(row);
    expect(openIssue).toHaveBeenCalledWith('a', 7, 'closed');
    expect(openApp).not.toHaveBeenCalled();
  });

  it('the tile background opens the app', () => {
    show(overview([tile('a')]));
    render(<OverviewView />);
    fireEvent.click(screen.getByTestId('overview-tile-a'));
    expect(openApp).toHaveBeenCalledWith('a');
  });

  it('renders errors as one line in their section', () => {
    show(overview([tile('a', { issues: [], issuesError: 'gh failed', deck: null })]));
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
    show(overview([tile('chats', { chats, issues: null, deck: null })]));
    render(<OverviewView />);
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('No project')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('overview-chat-c1'));
    expect(openChat).toHaveBeenCalledWith('c1');
    expect(openApp).not.toHaveBeenCalled();
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
