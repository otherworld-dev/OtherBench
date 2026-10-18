import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { projectTabId } from '../state/projectTab.js';
import { useOtherBenchStore } from '../state/store.js';
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
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ chats: [chat('a', { projectId: 'p1' }), chat('b', { projectId: 'p2' }), chat('c')], paneState: DEFAULT_PANE_STATE, activeChatId: null });
});

afterEach(cleanup);

describe('TabBar (#824)', () => {
  it('is hidden with no tabs and one pane; opening a tab shows it and opens the chat', () => {
    const { rerender } = render(<TabBar narrow={false} />);
    expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
    useOtherBenchStore.getState().openTab('b');
    rerender(<TabBar narrow={false} />);
    expect(tabNames()).toEqual(['Chat b']);
    expect(useOtherBenchStore.getState().activeChatId).toBe('b');
  });

  it('a sidebar click shows a chat without making it a tab; clicking a tab shows that chat', async () => {
    useOtherBenchStore.getState().openTab('a');
    useOtherBenchStore.getState().openTab('b');
    useOtherBenchStore.getState().setActiveChatId('c');
    const user = userEvent.setup();
    render(<TabBar narrow={false} />);
    expect(tabNames()).toEqual(['Chat a', 'Chat b']);
    expect(screen.getAllByRole('tab').every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
    await user.click(screen.getByRole('tab', { name: 'Chat a' }));
    expect(useOtherBenchStore.getState().activeChatId).toBe('a');
  });

  it('closing a tab takes its chat out of the pane, showing the next tab instead', async () => {
    useOtherBenchStore.getState().openTab('a');
    useOtherBenchStore.getState().openTab('b');
    const user = userEvent.setup();
    render(<TabBar narrow={false} />);
    await user.click(screen.getByRole('button', { name: 'Close tab Chat b' }));
    expect(useOtherBenchStore.getState().paneState.tabs).toEqual(['a']);
    expect(useOtherBenchStore.getState().activeChatId).toBe('a');
    await user.click(screen.getByRole('button', { name: 'Close tab Chat a' }));
    expect(useOtherBenchStore.getState().paneState.tabs).toEqual([]);
    expect(useOtherBenchStore.getState().activeChatId).toBeNull();
  });

  it('switching layout keeps the tab bar, numbers tabs by pane, and fills new panes with tabs', async () => {
    useOtherBenchStore.getState().openTab('a');
    useOtherBenchStore.getState().openTab('b');
    const user = userEvent.setup();
    render(<TabBar narrow={false} />);
    await user.click(screen.getByRole('button', { name: 'Layout: One chat' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Two side by side' }));
    expect(screen.queryByRole('menu', { name: 'Layout' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Layout: Two side by side' })).toBeInTheDocument();
    expect(useOtherBenchStore.getState().paneState.panes).toEqual(['b', 'a']);
    expect(screen.getByTestId('tab-pane-b')).toHaveTextContent('1');
    expect(screen.getByTestId('tab-pane-a')).toHaveTextContent('2');
  });

  it('offers no layouts in a narrow window', () => {
    useOtherBenchStore.getState().openTab('a');
    render(<TabBar narrow />);
    expect(screen.queryByRole('button', { name: /^Layout/ })).not.toBeInTheDocument();
  });

  it('picks the layout from one dropdown that lists every layout and ticks the current one', async () => {
    useOtherBenchStore.getState().openTab('a');
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
    useOtherBenchStore.getState().openTab('a');
    useOtherBenchStore.getState().openTab('b');
    useOtherBenchStore.setState({ appRunningTurns: { m1: 'a' }, appPendingApprovals: { r1: { chatId: 'b', messageId: 'm2', requestId: 'r1', toolName: 'Write' } } });
    render(<TabBar narrow={false} />);
    expect(screen.getByTestId('tab-status-a')).toHaveAttribute('data-status', 'working');
    expect(screen.getByTestId('tab-status-b')).toHaveAttribute('data-status', 'waiting');
  });

  it('marks a tab waiting for you when its reply asks a question', () => {
    useOtherBenchStore.getState().openTab('a');
    useOtherBenchStore.setState({ appPendingApprovals: { a1: { chatId: 'a', messageId: 'm1', requestId: 'a1', toolName: 'ask_user', kind: 'question' } } });
    render(<TabBar narrow={false} />);
    expect(screen.getByTestId('tab-status-a')).toHaveAttribute('data-status', 'waiting');
    expect(screen.getByRole('img', { name: 'waiting for you' })).toBeInTheDocument();
  });

  it('a chat dragged from the sidebar onto a tab opens as a tab there; a dragged tab moves', () => {
    useOtherBenchStore.getState().openTab('a');
    useOtherBenchStore.getState().openTab('b');
    render(<TabBar narrow={false} />);
    fireEvent.drop(screen.getByTestId('tab-a'), { dataTransfer: dataTransfer(CHAT_DRAG_MIME, 'c') });
    expect(useOtherBenchStore.getState().paneState.tabs).toEqual(['c', 'a', 'b']);
    const drop = createEvent.drop(screen.getByTestId('tab-bar'), { dataTransfer: dataTransfer(TAB_DRAG_MIME, 'c') });
    fireEvent(screen.getByTestId('tab-bar'), drop);
    expect(useOtherBenchStore.getState().paneState.tabs).toEqual(['a', 'b', 'c']);
  });

  it('arrow keys move between tabs and Delete closes the focused one', async () => {
    for (const id of ['a', 'b', 'c']) useOtherBenchStore.getState().openTab(id);
    useOtherBenchStore.getState().setActiveChatId('a');
    const user = userEvent.setup();
    render(<TabBar narrow={false} />);
    screen.getByRole('tab', { name: 'Chat a' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(useOtherBenchStore.getState().activeChatId).toBe('b');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Chat b' })).toHaveFocus());
    await user.keyboard('{Delete}');
    expect(useOtherBenchStore.getState().paneState.tabs).toEqual(['a', 'c']);
  });

  it("shows a viewer tab by its file's name", () => {
    const view = viewTabId('chat-1', { kind: 'file', path: 'C:\\ws\\notes.md' });
    useOtherBenchStore.setState({ paneState: { ...useOtherBenchStore.getState().paneState, tabs: [view] } });
    render(<TabBar narrow={false} />);
    expect(screen.getByRole('tab', { name: 'notes.md' })).toBeInTheDocument();
  });

  it('names the tab strip for any kind of tab, and says what closing each kind leaves behind', () => {
    useOtherBenchStore.getState().setProjects([{ id: 'p1', name: 'Alpha', description: '', instructions: '', workspace: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }]);
    useOtherBenchStore.setState({ paneState: { ...DEFAULT_PANE_STATE, tabs: ['a', projectTabId('p1')], panes: ['a'] }, activeChatId: 'a' });
    render(<TabBar narrow={false} />);
    expect(screen.getByRole('tablist', { name: 'Open tabs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close tab Chat a' })).toHaveAttribute('title', 'Close tab (the chat stays in the sidebar)');
    expect(screen.getByRole('button', { name: 'Close tab Alpha' })).toHaveAttribute('title', 'Close tab (the project stays in the sidebar)');
  });

  it('labels a project tab Loading… until the project list arrives', () => {
    useOtherBenchStore.setState({ paneState: { ...DEFAULT_PANE_STATE, tabs: [projectTabId('p1')], panes: [projectTabId('p1')] }, activeChatId: projectTabId('p1') });
    render(<TabBar narrow={false} />);
    expect(screen.getByRole('tab', { name: /Loading…/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Missing project/ })).toBeNull();
  });

  it('labels a project tab with the project name, or Missing project, with no status dot', () => {
    useOtherBenchStore.getState().setProjects([{ id: 'p1', name: 'Alpha', description: '', instructions: '', workspace: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }]);
    useOtherBenchStore.setState({
      paneState: { ...DEFAULT_PANE_STATE, tabs: [projectTabId('p1'), projectTabId('gone')], panes: [projectTabId('p1')] },
      activeChatId: projectTabId('p1'),
      appRunningTurns: { m1: projectTabId('p1') },
    });
    render(<TabBar narrow={false} />);
    expect(screen.getByRole('tab', { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Missing project/ })).toBeInTheDocument();
    expect(screen.queryByTestId(`tab-status-${projectTabId('p1')}`)).toBeNull();
  });
});
