import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';

const synced: { chatId: string | null; reportStatus: boolean }[] = [];
vi.mock('../state/useChatSync.js', () => ({
  useChatSync: (chatId: string | null, reportStatus: boolean) => {
    synced.push({ chatId, reportStatus });
  },
}));
vi.mock('./Thread.js', () => ({
  Thread: ({ chat }: { chat: Chat | null }) => <div data-testid="thread">{chat?.title ?? 'no chat'}</div>,
}));

vi.mock('../code/AppHome.js', () => ({ AppHome: ({ appId }: { appId: string }) => <div data-testid="app-home-stub">{appId}</div> }));
vi.mock('../views/ProjectHome.js', () => ({ ProjectHome: ({ projectId }: { projectId: string }) => <div data-testid="project-home-stub">{projectId}</div> }));

vi.mock('../viewer/ItemView.js', () => ({ ItemView: ({ item }: { item: { path: string } }) => <div data-testid="item-view">{item.path}</div> }));

import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { appTabId } from '../state/appTab.js';
import { projectTabId } from '../state/projectTab.js';
import { viewTabId } from '../viewer/items.js';
import { useOtherBenchStore } from '../state/store.js';
import { CHAT_DRAG_MIME } from './sidebar/ChatRow.js';
import { PaneGrid } from './PaneGrid.js';

function chat(id: string): Chat {
  return {
    id, title: `Chat ${id}`, profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
    projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
  };
}

/** `ids` as tabs, the last on show in the one pane. */
function openTabs(...ids: string[]): void {
  useOtherBenchStore.setState({ paneState: { ...DEFAULT_PANE_STATE, tabs: ids, panes: [ids.at(-1)!] }, activeChatId: ids.at(-1)! });
}

beforeEach(() => {
  synced.length = 0;
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ chats: [chat('a'), chat('b'), chat('c')], paneState: DEFAULT_PANE_STATE, activeChatId: null });
});

afterEach(cleanup);

const threads = (): string[] => screen.getAllByTestId('thread').map((t) => t.textContent ?? '');

describe('PaneGrid (#824)', () => {
  it('shows one chat in the single layout, and one per pane otherwise, each syncing its own chat', () => {
    openTabs('a', 'b');
    const { rerender } = render(<PaneGrid narrow={false} />);
    expect(threads()).toEqual(['Chat b']);

    useOtherBenchStore.getState().setLayout('columns-3');
    rerender(<PaneGrid narrow={false} />);
    expect(threads()).toEqual(['Chat b', 'Chat a', 'no chat']);
    expect(synced.slice(-3)).toEqual([
      { chatId: 'b', reportStatus: true },
      { chatId: 'a', reportStatus: false },
      { chatId: null, reportStatus: false },
    ]);
  });

  it('clicking into a pane focuses it, making its chat the active one', () => {
    openTabs('a', 'b');
    useOtherBenchStore.getState().setLayout('columns-2');
    render(<PaneGrid narrow={false} />);
    fireEvent.mouseDown(screen.getByTestId('pane-1'));
    expect(useOtherBenchStore.getState().activeChatId).toBe('a');
    expect(screen.getByTestId('pane-1')).toHaveAttribute('data-focused', 'true');
  });

  it('a chat dropped onto a pane shows there', () => {
    useOtherBenchStore.getState().setLayout('rows-2');
    render(<PaneGrid narrow={false} />);
    fireEvent.drop(screen.getByTestId('pane-1'), {
      dataTransfer: { types: [CHAT_DRAG_MIME], getData: (t: string) => (t === CHAT_DRAG_MIME ? 'c' : ''), dropEffect: 'none' },
    });
    expect(useOtherBenchStore.getState().paneState.panes).toEqual([null, 'c']);
    expect(useOtherBenchStore.getState().activeChatId).toBe('c');
  });

  it('the pin button pins a pane so the next chat opens in the other one, even after replying in the pinned pane', async () => {
    openTabs('a', 'b');
    useOtherBenchStore.getState().setLayout('columns-2');
    render(<PaneGrid narrow={false} />);
    await userEvent.click(within(screen.getByTestId('pane-0')).getByRole('button', { name: 'Pin pane' }));
    expect(within(screen.getByTestId('pane-0')).getByRole('button', { name: 'Unpin pane' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.mouseDown(screen.getByTestId('pane-0'));
    useOtherBenchStore.getState().setActiveChatId('c');
    expect(useOtherBenchStore.getState().paneState).toMatchObject({ panes: ['b', 'c'], focusedPane: 1 });
  });

  it('an empty pane has nothing to pin', () => {
    useOtherBenchStore.getState().setLayout('columns-2');
    render(<PaneGrid narrow={false} />);
    expect(within(screen.getByTestId('pane-0')).getByRole('button', { name: 'Pin pane' })).toBeDisabled();
  });

  it('a chat dropped onto a pinned pane replaces it, and the pane stays pinned', () => {
    openTabs('a', 'b');
    useOtherBenchStore.getState().setLayout('columns-2');
    useOtherBenchStore.getState().togglePanePin(0);
    render(<PaneGrid narrow={false} />);
    fireEvent.drop(screen.getByTestId('pane-0'), {
      dataTransfer: { types: [CHAT_DRAG_MIME], getData: (t: string) => (t === CHAT_DRAG_MIME ? 'c' : ''), dropEffect: 'none' },
    });
    expect(useOtherBenchStore.getState().paneState).toMatchObject({ panes: ['c', 'a'], pinned: [0] });
  });

  it('a narrow window shows only the focused pane; the others stay mounted, hidden, so nothing reconnects', () => {
    openTabs('a', 'b');
    useOtherBenchStore.getState().setLayout('columns-2');
    useOtherBenchStore.getState().focusPane(1);
    render(<PaneGrid narrow />);
    expect(screen.getByTestId('pane-1')).toBeVisible();
    expect(screen.getByTestId('pane-0')).not.toBeVisible();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('maximise fills the area with the focused pane, keeps the others mounted, and restores the layout', async () => {
    openTabs('a', 'b', 'c');
    useOtherBenchStore.getState().setLayout('columns-3');
    const user = userEvent.setup();
    render(<PaneGrid narrow={false} />);
    await user.click(within(screen.getByTestId('pane-2')).getByRole('button', { name: 'Maximise pane' }));
    expect(useOtherBenchStore.getState().paneState).toMatchObject({ maximised: true, focusedPane: 2 });
    expect(screen.getByTestId('pane-2')).toBeVisible();
    expect(screen.getByTestId('pane-0')).not.toBeVisible();
    expect(threads()).toHaveLength(3);
    await user.click(within(screen.getByTestId('pane-2')).getByRole('button', { name: 'Restore pane' }));
    expect(screen.getByTestId('pane-0')).toBeVisible();
  });

  it('"one big, two stacked" and "four in a grid" lay out three and four panes with a divider per split', () => {
    openTabs('a', 'b', 'c', 'd');
    useOtherBenchStore.getState().setLayout('main-right-2');
    const { rerender } = render(<PaneGrid narrow={false} />);
    expect(threads()).toHaveLength(3);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
    useOtherBenchStore.getState().setLayout('grid-4');
    rerender(<PaneGrid narrow={false} />);
    expect(threads()).toHaveLength(4);
    expect(screen.getAllByRole('separator')).toHaveLength(3);
  });

  it('a divider moves with the arrow keys and is remembered per layout; a double-click evens it out', async () => {
    useOtherBenchStore.getState().setLayout('columns-2');
    const user = userEvent.setup();
    render(<PaneGrid narrow={false} />);
    const divider = screen.getByRole('separator', { name: 'Resize panes' });
    expect(divider).toHaveAttribute('aria-valuenow', '50');
    divider.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(divider).toHaveAttribute('aria-valuenow', '60');
    const [left, right] = useOtherBenchStore.getState().paneState.sizes['columns-2/root']!;
    expect(left).toBeCloseTo(1.2);
    expect(right).toBeCloseTo(0.8);
    await user.dblClick(divider);
    expect(useOtherBenchStore.getState().paneState.sizes['columns-2/root']).toEqual([1, 1]);
  });

  it('opening a chat from elsewhere fills the focused pane, or focuses the pane already showing it', () => {
    useOtherBenchStore.getState().setLayout('columns-2');
    useOtherBenchStore.getState().setActiveChatId('a');
    useOtherBenchStore.getState().focusPane(1);
    useOtherBenchStore.getState().setActiveChatId('b');
    expect(useOtherBenchStore.getState().paneState.panes).toEqual(['a', 'b']);
    useOtherBenchStore.getState().setActiveChatId('a');
    expect(useOtherBenchStore.getState().paneState.focusedPane).toBe(0);
    // A deleted chat leaves its pane.
    useOtherBenchStore.getState().removeChat('a');
    expect(useOtherBenchStore.getState().paneState.panes).toEqual([null, 'b']);
    expect(useOtherBenchStore.getState().activeChatId).toBeNull();
  });

  it('shows a viewer tab in its pane, without connecting to a chat', () => {
    const view = viewTabId('chat-1', { kind: 'file', path: 'a.md' });
    useOtherBenchStore.setState({ activeChatId: view, paneState: { ...useOtherBenchStore.getState().paneState, tabs: [view], panes: [view], focusedPane: 0 } });
    render(<PaneGrid narrow={false} />);
    expect(screen.getByTestId('item-view')).toHaveTextContent('a.md');
    expect(synced.some((s) => s.chatId === view)).toBe(false);
  });

  it('shows a project tab as its home page, named in the pane header, with no chat sync', () => {
    const tab = projectTabId('p1');
    useOtherBenchStore.setState({
      projects: [{ id: 'p1', name: 'Alpha', description: '', instructions: '', workspace: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }],
      paneState: { ...DEFAULT_PANE_STATE, layout: 'columns-2', tabs: [tab, 'a'], panes: [tab, 'a'], focusedPane: 0 },
      activeChatId: tab,
    });
    render(<PaneGrid narrow={false} />);
    expect(screen.getByTestId('project-home-stub')).toHaveTextContent('p1');
    expect(within(screen.getByTestId('pane-0')).getByText('Alpha')).toBeInTheDocument();
    expect(synced.filter((s) => s.chatId === tab)).toEqual([]);
  });

  it('shows an app tab as its home page, named in the pane header, with no chat sync (spec 2026-10-20-code-tab-design)', () => {
    const tab = appTabId('a1');
    useOtherBenchStore.setState({
      mode: 'code',
      apps: [{ id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }],
      appsLoaded: true,
      paneState: { ...DEFAULT_PANE_STATE, layout: 'columns-2', tabs: [tab, 'a'], panes: [tab, 'a'], focusedPane: 0 },
      activeChatId: tab,
    });
    render(<PaneGrid narrow={false} />);
    expect(screen.getByTestId('app-home-stub')).toHaveTextContent('a1');
    expect(within(screen.getByTestId('pane-0')).getByText('OtherBench')).toBeInTheDocument();
    expect(synced.filter((s) => s.chatId === tab)).toEqual([]);
  });
});
