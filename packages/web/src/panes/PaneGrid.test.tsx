import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';

const synced: { chatId: string | null; reportStatus: boolean }[] = [];
vi.mock('../state/useChatSync.js', () => ({
  useChatSync: (chatId: string | null, reportStatus: boolean) => {
    synced.push({ chatId, reportStatus });
  },
}));
vi.mock('./Thread.js', () => ({
  Thread: ({ chat }: { chat: Chat | null }) => <div data-testid="thread">{chat?.title ?? 'no chat'}</div>,
}));

vi.mock('../viewer/ItemView.js', () => ({ ItemView: ({ item }: { item: { path: string } }) => <div data-testid="item-view">{item.path}</div> }));

import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { viewTabId } from '../viewer/items.js';
import { useGruntStore } from '../state/store.js';
import { CHAT_DRAG_MIME } from './sidebar/ChatRow.js';
import { PaneGrid } from './PaneGrid.js';

function chat(id: string): Chat {
  return {
    id, title: `Chat ${id}`, profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, archivedAt: null, autoMode: false,
    projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
  };
}

beforeEach(() => {
  synced.length = 0;
  window.localStorage.clear();
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ chats: [chat('a'), chat('b'), chat('c')], paneState: DEFAULT_PANE_STATE, activeChatId: null });
});

afterEach(cleanup);

const threads = (): string[] => screen.getAllByTestId('thread').map((t) => t.textContent ?? '');

describe('PaneGrid (#824)', () => {
  it('shows one chat in the single layout, and one per pane otherwise, each syncing its own chat', () => {
    useGruntStore.getState().openTab('a');
    useGruntStore.getState().openTab('b');
    const { rerender } = render(<PaneGrid narrow={false} />);
    expect(threads()).toEqual(['Chat b']);

    useGruntStore.getState().setLayout('columns-3');
    rerender(<PaneGrid narrow={false} />);
    expect(threads()).toEqual(['Chat b', 'Chat a', 'no chat']);
    expect(synced.slice(-3)).toEqual([
      { chatId: 'b', reportStatus: true },
      { chatId: 'a', reportStatus: false },
      { chatId: null, reportStatus: false },
    ]);
  });

  it('clicking into a pane focuses it, making its chat the active one', () => {
    useGruntStore.getState().openTab('a');
    useGruntStore.getState().openTab('b');
    useGruntStore.getState().setLayout('columns-2');
    render(<PaneGrid narrow={false} />);
    fireEvent.mouseDown(screen.getByTestId('pane-1'));
    expect(useGruntStore.getState().activeChatId).toBe('a');
    expect(screen.getByTestId('pane-1')).toHaveAttribute('data-focused', 'true');
  });

  it('a chat dropped onto a pane shows there', () => {
    useGruntStore.getState().setLayout('rows-2');
    render(<PaneGrid narrow={false} />);
    fireEvent.drop(screen.getByTestId('pane-1'), {
      dataTransfer: { types: [CHAT_DRAG_MIME], getData: (t: string) => (t === CHAT_DRAG_MIME ? 'c' : ''), dropEffect: 'none' },
    });
    expect(useGruntStore.getState().paneState.panes).toEqual([null, 'c']);
    expect(useGruntStore.getState().activeChatId).toBe('c');
  });

  it('a narrow window shows only the focused pane; the others stay mounted, hidden, so nothing reconnects', () => {
    useGruntStore.getState().openTab('a');
    useGruntStore.getState().openTab('b');
    useGruntStore.getState().setLayout('columns-2');
    useGruntStore.getState().focusPane(1);
    render(<PaneGrid narrow />);
    expect(screen.getByTestId('pane-1')).toBeVisible();
    expect(screen.getByTestId('pane-0')).not.toBeVisible();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('maximise fills the area with the focused pane, keeps the others mounted, and restores the layout', async () => {
    for (const id of ['a', 'b', 'c']) useGruntStore.getState().openTab(id);
    useGruntStore.getState().setLayout('columns-3');
    const user = userEvent.setup();
    render(<PaneGrid narrow={false} />);
    await user.click(within(screen.getByTestId('pane-2')).getByRole('button', { name: 'Maximise pane' }));
    expect(useGruntStore.getState().paneState).toMatchObject({ maximised: true, focusedPane: 2 });
    expect(screen.getByTestId('pane-2')).toBeVisible();
    expect(screen.getByTestId('pane-0')).not.toBeVisible();
    expect(threads()).toHaveLength(3);
    await user.click(within(screen.getByTestId('pane-2')).getByRole('button', { name: 'Restore pane' }));
    expect(screen.getByTestId('pane-0')).toBeVisible();
  });

  it('"one big, two stacked" and "four in a grid" lay out three and four panes with a divider per split', () => {
    for (const id of ['a', 'b', 'c', 'd']) useGruntStore.getState().openTab(id);
    useGruntStore.getState().setLayout('main-right-2');
    const { rerender } = render(<PaneGrid narrow={false} />);
    expect(threads()).toHaveLength(3);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
    useGruntStore.getState().setLayout('grid-4');
    rerender(<PaneGrid narrow={false} />);
    expect(threads()).toHaveLength(4);
    expect(screen.getAllByRole('separator')).toHaveLength(3);
  });

  it('a divider moves with the arrow keys and is remembered per layout; a double-click evens it out', async () => {
    useGruntStore.getState().setLayout('columns-2');
    const user = userEvent.setup();
    render(<PaneGrid narrow={false} />);
    const divider = screen.getByRole('separator', { name: 'Resize panes' });
    expect(divider).toHaveAttribute('aria-valuenow', '50');
    divider.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(divider).toHaveAttribute('aria-valuenow', '60');
    const [left, right] = useGruntStore.getState().paneState.sizes['columns-2/root']!;
    expect(left).toBeCloseTo(1.2);
    expect(right).toBeCloseTo(0.8);
    await user.dblClick(divider);
    expect(useGruntStore.getState().paneState.sizes['columns-2/root']).toEqual([1, 1]);
  });

  it('opening a chat from elsewhere fills the focused pane, or focuses the pane already showing it', () => {
    useGruntStore.getState().setLayout('columns-2');
    useGruntStore.getState().setActiveChatId('a');
    useGruntStore.getState().focusPane(1);
    useGruntStore.getState().setActiveChatId('b');
    expect(useGruntStore.getState().paneState.panes).toEqual(['a', 'b']);
    useGruntStore.getState().setActiveChatId('a');
    expect(useGruntStore.getState().paneState.focusedPane).toBe(0);
    // A deleted chat leaves its pane.
    useGruntStore.getState().removeChat('a');
    expect(useGruntStore.getState().paneState.panes).toEqual([null, 'b']);
    expect(useGruntStore.getState().activeChatId).toBeNull();
  });

  it('shows a viewer tab in its pane, without connecting to a chat', () => {
    const view = viewTabId('chat-1', { kind: 'file', path: 'a.md' });
    useGruntStore.setState({ activeChatId: view, paneState: { ...useGruntStore.getState().paneState, tabs: [view], panes: [view], focusedPane: 0 } });
    render(<PaneGrid narrow={false} />);
    expect(screen.getByTestId('item-view')).toHaveTextContent('a.md');
    expect(synced.some((s) => s.chatId === view)).toBe(false);
  });
});
