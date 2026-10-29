import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Chat } from '@otherbench/core/ports/store.js';
import { applyOpenRequest } from '../desktop/useDocks.js';
import { openCard, openIssue } from '../overview/openFromOverview.js';
import { MODE_STORAGE_KEY } from './mode.js';
import { CODE_PANE_STATE_STORAGE_KEY, DEFAULT_PANE_STATE, PANE_STATE_STORAGE_KEY, type PaneState } from './panes.js';
import { OVERVIEW_OPEN_STORAGE_KEY, useOtherBenchStore, WINDOW_ROLE } from './store.js';

const bridge = vi.hoisted(() => ({ openIn: vi.fn(async () => {}), showWindow: vi.fn(async () => {}) }));
vi.mock('../desktop/bridge.js', async (importOriginal) => ({ ...(await importOriginal<object>()), ...bridge }));

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1', title: 'Hello', profileId: 'p1', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null,
    pinned: false, projectPinned: false, unread: false, autoMode: false, projectId: null, appId: null, memoryCursor: null,
    memoryExcluded: false, sortOrder: 0, archivedAt: null, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function makeApp(overrides: Partial<App> = {}): App {
  return { id: 'a', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...overrides };
}

const s = () => useOtherBenchStore.getState();
const chatPanes: PaneState = { ...DEFAULT_PANE_STATE, tabs: ['plain-1'], panes: ['plain-1'] };
const codePanes: PaneState = { ...DEFAULT_PANE_STATE, tabs: ['app-chat'], panes: ['app-chat'] };

describe('the main window with Code or the Overview undocked', () => {
  beforeEach(() => {
    window.localStorage.clear();
    bridge.openIn.mockClear();
    bridge.showWindow.mockClear();
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    useOtherBenchStore.setState({
      mode: 'chat',
      paneState: chatPanes,
      otherPaneState: codePanes,
      activeChatId: 'plain-1',
      chats: [makeChat({ id: 'plain-1' }), makeChat({ id: 'plain-2' }), makeChat({ id: 'app-chat', appId: 'a' })],
      apps: [makeApp()],
    });
  });

  it('is the main window in tests', () => {
    expect(WINDOW_ROLE).toBe('main');
  });

  it('leaves Code mode when Code is undocked, and reads Code back from storage when it docks again', () => {
    s().setMode('code');
    s().setUndocked(['code']);
    expect(s().mode).toBe('chat');
    expect(s().paneState).toEqual(chatPanes);

    // The Code window changed Code's tabs meanwhile; the main window takes them on docking.
    const fromCodeWindow: PaneState = { ...DEFAULT_PANE_STATE, tabs: ['app-chat'], panes: ['app-chat'], focusedPane: 0 };
    window.localStorage.setItem(CODE_PANE_STATE_STORAGE_KEY, JSON.stringify(fromCodeWindow));
    s().setUndocked([]);
    expect(s().mode).toBe('chat');
    expect(s().otherPaneState).toMatchObject({ tabs: ['app-chat'], panes: ['app-chat'] });
  });

  it("sends an app chat to the Code window instead of opening it here", () => {
    s().setUndocked(['code']);
    s().setActiveChatId('app-chat');
    s().openTab('app-chat');
    s().openAppHome('a');
    expect(bridge.openIn.mock.calls).toEqual([
      ['code', { kind: 'chat', chatId: 'app-chat' }],
      ['code', { kind: 'tab', chatId: 'app-chat' }],
      ['code', { kind: 'home', appId: 'a' }],
    ]);
    expect(s().mode).toBe('chat');
    expect(s().activeChatId).toBe('plain-1');
  });

  it('still opens its own chats, and everything while Code is docked', () => {
    s().setUndocked(['code']);
    s().setActiveChatId('plain-2');
    expect(s().activeChatId).toBe('plain-2');
    s().setUndocked([]);
    s().setActiveChatId('app-chat');
    expect(s().mode).toBe('code');
    expect(bridge.openIn).not.toHaveBeenCalled();
  });

  it('brings the Code window forward for Code mode, and the Overview window for the Overview', () => {
    s().setUndocked(['code', 'overview']);
    s().setMode('code');
    s().setOverviewOpen(true);
    expect(bridge.showWindow.mock.calls).toEqual([['code'], ['overview']]);
    expect(s().mode).toBe('chat');
    expect(s().overviewOpen).toBe(false);
  });

  it('closes its own Overview when the Overview is undocked', () => {
    s().setOverviewOpen(true);
    s().setUndocked(['overview']);
    expect(s().overviewOpen).toBe(false);
  });

  it("doesn't save Code's pane state or the mode while Code is in its own window", () => {
    s().setUndocked(['code']);
    window.localStorage.clear();
    s().setActiveChatId('plain-2');
    s().removeChat('app-chat');
    expect(window.localStorage.getItem(PANE_STATE_STORAGE_KEY)).not.toBeNull();
    expect(window.localStorage.getItem(CODE_PANE_STATE_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();
  });

  it('opens what another window handed over here, never sending it on, even when its list says otherwise', () => {
    s().setUndocked(['code']);
    applyOpenRequest({ kind: 'chat', chatId: 'app-chat' });
    expect(bridge.openIn).not.toHaveBeenCalled();
    expect(s().mode).toBe('code');
    expect(s().activeChatId).toBe('app-chat');
    // Afterwards this window routes as before.
    s().setActiveChatId('plain-1');
    s().setActiveChatId('app-chat');
    expect(bridge.openIn.mock.calls).toEqual([['code', { kind: 'chat', chatId: 'app-chat' }]]);
  });

  it("sends the Overview's issues and cards to the Code window with their panel", () => {
    s().setUndocked(['code']);
    openIssue('a', 7, 'closed');
    openCard('a', 12);
    expect(bridge.openIn.mock.calls).toEqual([
      ['code', { kind: 'issue', appId: 'a', n: 7, state: 'closed' }],
      ['code', { kind: 'card', appId: 'a', cardId: 12 }],
    ]);
    expect(window.localStorage.getItem(OVERVIEW_OPEN_STORAGE_KEY)).toBeNull();
  });
});
