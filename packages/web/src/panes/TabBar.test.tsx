import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { useGruntStore } from '../state/store.js';
import { CHAT_DRAG_MIME } from './sidebar/ChatRow.js';
import { TAB_DRAG_MIME, TabBar } from './TabBar.js';

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return {
    id, title: `Chat ${id}`, profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, archivedAt: null, autoMode: false,
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
    await user.click(screen.getByRole('button', { name: 'Two side by side' }));
    expect(screen.getByRole('button', { name: 'Two side by side' })).toHaveAttribute('aria-pressed', 'true');
    expect(useGruntStore.getState().paneState.panes).toEqual(['b', 'a']);
    expect(screen.getByTestId('tab-pane-b')).toHaveTextContent('1');
    expect(screen.getByTestId('tab-pane-a')).toHaveTextContent('2');
  });

  it('offers no layouts in a narrow window', () => {
    useGruntStore.getState().openTab('a');
    render(<TabBar narrow />);
    expect(screen.queryByRole('group', { name: 'Layout' })).not.toBeInTheDocument();
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
});
