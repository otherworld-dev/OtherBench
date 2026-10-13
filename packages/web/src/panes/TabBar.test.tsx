import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { useGruntStore } from '../state/store.js';
import { CHAT_DRAG_MIME } from './sidebar/ChatRow.js';
import { TAB_DRAG_MIME, TabBar } from './TabBar.js';
import { viewTabId } from '../viewer/items.js';

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return {
    id, title: `Chat ${id}`, profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
    projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
  };
}

const tabNames = (): string[] => within(screen.getByRole('tablist')).getAllByRole('tab').map((t) => t.getAttribute('title') ?? '');

/** A fake DataTransfer: jsdom has none. */
function dataTransfer(type: string, value: string) {
  return { types: [type], getData: (t: string) => (t === type ? value : ''), setData: () => {}, dropEffect: 'none', effectAllowed: 'all' };
}

beforeEach(() => {
  window.localStorage.clear();
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ chats: [chat('a', { projectId: 'p1' }), chat('b', { projectId: 'p2' }), chat('c')], paneState: DEFAULT_PANE_STATE, activeChatId: null });
});

afterEach(cleanup);

describe('TabBar (#824)', () => {
  it('is hidden with no tabs and one pane; opening a tab shows it and opens the chat', () => {
    const { rerender } = render(<TabBar narrow={false} />);
    expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
    useGruntStore.getState().openTab('b');
    rerender(<TabBar narrow={false} />);
    expect(tabNames()).toEqual(['Chat b']);
    expect(useGruntStore.getState().activeChatId).toBe('b');
  });

  it('a sidebar click shows a chat without making it a tab; clicking a tab shows that chat', async () => {
    useGruntStore.getState().openTab('a');
    useGruntStore.getState().openTab('b');
    useGruntStore.getState().setActiveChatId('c');
    const user = userEvent.setup();
    render(<TabBar narrow={false} />);
    expect(tabNames()).toEqual(['Chat a', 'Chat b']);
    expect(screen.getAllByRole('tab').every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
    await user.click(screen.getByRole('tab', { name: 'Chat a' }));
    expect(useGruntStore.getState().activeChatId).toBe('a');
  });

  it('closing a tab leaves the chat where it is showing', async () => {
    useGruntStore.getState().openTab('a');
    const user = userEvent.setup();
    render(<TabBar narrow={false} />);
    await user.click(screen.getByRole('button', { name: 'Close tab Chat a' }));
    expect(useGruntStore.getState().paneState.tabs).toEqual([]);
    expect(useGruntStore.getState().activeChatId).toBe('a');
  });

  it('switching layout keeps the tab bar, numbers tabs by pane, and fills new panes with tabs', async () => {
    useGruntStore.getState().openTab('a');
    useGruntStore.getState().openTab('b');
    const user = userEvent.setup();
    render(<TabBar narrow={false} />);
    await user.click(screen.getByRole('button', { name: 'Layout: One chat' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Two side by side' }));
    expect(screen.queryByRole('menu', { name: 'Layout' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Layout: Two side by side' })).toBeInTheDocument();
    expect(useGruntStore.getState().paneState.panes).toEqual(['b', 'a']);
    expect(screen.getByTestId('tab-pane-b')).toHaveTextContent('1');
    expect(screen.getByTestId('tab-pane-a')).toHaveTextContent('2');
  });

  it('offers no layouts in a narrow window', () => {
    useGruntStore.getState().openTab('a');
    render(<TabBar narrow />);
    expect(screen.queryByRole('button', { name: /^Layout/ })).not.toBeInTheDocument();
  });

  it('picks the layout from one dropdown that lists every layout and ticks the current one', async () => {
    useGruntStore.getState().openTab('a');
    const user = userEvent.setup();
    render(<TabBar narrow={false} />);
    const button = screen.getByRole('button', { name: 'Layout: One chat' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.getAllByRole('button').filter((b) => /side by side|stacked|grid/i.test(b.getAttribute('aria-label') ?? ''))).toEqual([]);
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent!.replace('✓', '').trim())).toEqual(['One chat', 'Two side by side', 'Two stacked', 'Three side by side', 'One big, two stacked', 'Four in a grid']);
    expect(screen.getByRole('menuitemradio', { name: 'One chat' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Layout' })).toBeNull();
    expect(button).toHaveFocus();
  });

  it('marks a tab replying, or waiting for an approval', () => {
    useGruntStore.getState().openTab('a');
    useGruntStore.getState().openTab('b');
    useGruntStore.setState({ appRunningTurns: { m1: 'a' }, appPendingApprovals: { r1: { chatId: 'b', messageId: 'm2', requestId: 'r1', toolName: 'Write' } } });
    render(<TabBar narrow={false} />);
    expect(screen.getByTestId('tab-status-a')).toHaveAttribute('data-status', 'working');
    expect(screen.getByTestId('tab-status-b')).toHaveAttribute('data-status', 'waiting');
  });

  it('a chat dragged from the sidebar onto a tab opens as a tab there; a dragged tab moves', () => {
    useGruntStore.getState().openTab('a');
    useGruntStore.getState().openTab('b');
    render(<TabBar narrow={false} />);
    fireEvent.drop(screen.getByTestId('tab-a'), { dataTransfer: dataTransfer(CHAT_DRAG_MIME, 'c') });
    expect(useGruntStore.getState().paneState.tabs).toEqual(['c', 'a', 'b']);
    const drop = createEvent.drop(screen.getByTestId('tab-bar'), { dataTransfer: dataTransfer(TAB_DRAG_MIME, 'c') });
    fireEvent(screen.getByTestId('tab-bar'), drop);
    expect(useGruntStore.getState().paneState.tabs).toEqual(['a', 'b', 'c']);
  });

  it('arrow keys move between tabs and Delete closes the focused one', async () => {
    for (const id of ['a', 'b', 'c']) useGruntStore.getState().openTab(id);
    useGruntStore.getState().setActiveChatId('a');
    const user = userEvent.setup();
    render(<TabBar narrow={false} />);
    screen.getByRole('tab', { name: 'Chat a' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(useGruntStore.getState().activeChatId).toBe('b');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Chat b' })).toHaveFocus());
    await user.keyboard('{Delete}');
    expect(useGruntStore.getState().paneState.tabs).toEqual(['a', 'c']);
  });

  it("shows a viewer tab by its file's name", () => {
    const view = viewTabId('chat-1', { kind: 'file', path: 'C:\\ws\\notes.md' });
    useGruntStore.setState({ paneState: { ...useGruntStore.getState().paneState, tabs: [view] } });
    render(<TabBar narrow={false} />);
    expect(screen.getByRole('tab', { name: 'notes.md' })).toBeInTheDocument();
  });
});
