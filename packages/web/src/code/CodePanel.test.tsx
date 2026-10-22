import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Chat } from '@otherbench/core/ports/store.js';

vi.mock('../panes/Inspector.js', () => ({
  Inspector: ({ chat }: { chat: Chat | null }) => <div data-testid="inspector-stub">{chat?.id ?? 'none'}</div>,
}));
vi.mock('./IssuesTab.js', () => ({ IssuesTab: ({ app, owner }: { app: App; owner: string }) => <div data-testid="issues-stub" data-owner={owner}>{app.id}</div> }));
vi.mock('./terminal/TerminalTab.js', () => ({ TerminalTab: ({ app }: { app: App }) => <div data-testid="terminal-stub">{app.id}</div> }));
const terminalStatus = vi.hoisted(() => ({ value: null as null | { available: boolean; shells: never[] } }));
vi.mock('./terminal/status.js', () => ({ useTerminalStatus: () => terminalStatus.value }));
vi.mock('./DeckTab.js', () => ({ DeckTab: ({ owner }: { app: App; owner: string }) => <div data-testid="deck-stub" data-owner={owner} /> }));
vi.mock('./WikiTab.js', () => ({ WikiTab: ({ owner }: { app: App; owner: string }) => <div data-testid="wiki-stub" data-owner={owner} /> }));
vi.mock('./LinksTab.js', () => ({ LinksTab: ({ app }: { app: App }) => <div data-testid="links-stub">{app.id}</div> }));
vi.mock('./FilesTab.js', () => ({ FilesTab: ({ app, chatId }: { app: App; chatId: string | null }) => <div data-testid="files-stub">{`${app.id}:${chatId ?? 'none'}`}</div> }));

import { appTabId } from '../state/appTab.js';
import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { useOtherBenchStore } from '../state/store.js';
import { CodePanel } from './CodePanel.js';

const app = (id: string): App => ({ id, name: `App ${id}`, workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, sortOrder: 0, createdAt: 1, updatedAt: 1 });
const chat = (id: string, appId: string | null): Chat => ({
  id, title: `Chat ${id}`, profileId: 'prof', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
});

function focus(id: string | null): void {
  useOtherBenchStore.setState({ paneState: { ...DEFAULT_PANE_STATE, tabs: id ? [id] : [], panes: [id] }, activeChatId: id });
}

beforeEach(() => {
  terminalStatus.value = null;
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ mode: 'code', apps: [app('a1'), app('a2')], appsLoaded: true, chats: [chat('c1', 'a2')] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CodePanel', () => {
  it('opens on the saved tab', () => {
    useOtherBenchStore.setState({ codePanelTab: 'files' });
    focus(appTabId('a1'));
    render(<CodePanel collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('files-stub')).toHaveTextContent('a1:none');
  });

  it("follows the focused app chat's app, and the Chat tab holds the Inspector for that chat", async () => {
    focus('c1');
    render(<CodePanel collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByTestId('issues-stub')).toHaveTextContent('a2');
    // The chat's own Issues view.
    expect(screen.getByTestId('issues-stub')).toHaveAttribute('data-owner', 'c1');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.getByTestId('inspector-stub')).toHaveTextContent('c1');
    expect(useOtherBenchStore.getState().codePanelTab).toBe('chat');
  });

  it('shows Deck, Wiki and Links in order', () => {
    focus('c1');
    render(<CodePanel collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Issues', 'Deck', 'Wiki', 'Links', 'Files', 'Chat']);
  });

  it("the strip clips its measuring row, and a long app name can't crowd the tabs", () => {
    useOtherBenchStore.setState({ apps: [app('a1'), { ...app('a2'), name: 'A very long app name that would push every tab into More tabs' }] });
    focus('c1');
    render(<CodePanel collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByRole('tablist').parentElement).toHaveClass('overflow-hidden');
    const name = screen.getByTestId('code-panel-app-name');
    expect(name).toHaveClass('max-w-[25%]', 'truncate');
    expect(name).toHaveAttribute('title', 'A very long app name that would push every tab into More tabs');
    for (const t of screen.getAllByRole('tab')) expect(t).toHaveClass('px-2');
  });

  it('a saved deck tab renders the Deck tab with the chat as owner', () => {
    useOtherBenchStore.setState({ codePanelTab: 'deck' });
    focus('c1');
    render(<CodePanel collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByTestId('deck-stub')).toHaveAttribute('data-owner', 'c1');
  });

  it('the Files tab gets the focused app chat', async () => {
    focus('c1');
    render(<CodePanel collapsed={false} onToggleCollapsed={() => {}} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Files' }));
    expect(screen.getByTestId('files-stub')).toHaveTextContent('a2:c1');
  });

  it('with no app in the focused pane it asks for one', () => {
    focus(null);
    render(<CodePanel collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByTestId('code-panel-empty')).toHaveTextContent('Pick an app or a chat');
    expect(screen.queryByTestId('issues-stub')).not.toBeInTheDocument();
  });

  it('collapses to a strip that expands it', async () => {
    const toggle = vi.fn();
    focus(appTabId('a1'));
    const { rerender } = render(<CodePanel collapsed={true} onToggleCollapsed={toggle} />);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Expand code panel' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    rerender(<CodePanel collapsed={false} onToggleCollapsed={toggle} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse code panel' }));
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it('no Terminal tab when terminals are unavailable, and a saved Terminal tab shows Issues', () => {
    terminalStatus.value = { available: false, shells: [] };
    useOtherBenchStore.setState({ codePanelTab: 'terminal' });
    focus(appTabId('a1'));
    render(<CodePanel collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.queryByRole('tab', { name: 'Terminal' })).not.toBeInTheDocument();
    expect(screen.getByTestId('issues-stub')).toHaveTextContent('a1');
    expect(screen.getByTestId('issues-stub')).toHaveAttribute('data-owner', appTabId('a1'));
  });

  it('a Terminal tab when terminals are available, holding the focused app', async () => {
    terminalStatus.value = { available: true, shells: [] };
    focus('c1');
    render(<CodePanel collapsed={false} onToggleCollapsed={() => {}} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.getByTestId('terminal-stub')).toHaveTextContent('a2');
    expect(useOtherBenchStore.getState().codePanelTab).toBe('terminal');
  });
});
