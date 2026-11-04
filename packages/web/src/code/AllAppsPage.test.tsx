import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, AppFolder, Chat } from '@otherbench/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, apps: { ...actual.api.apps, patch: vi.fn() } } };
});

import { useToasts } from '../lib/toasts.js';
import { api } from '../state/api.js';
import { ALL_APPS_TAB_ID } from '../state/allAppsTab.js';
import { appTabId } from '../state/appTab.js';
import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { resetSidebarGroupsForTests } from '../state/sidebarGroups.js';
import { useOtherBenchStore } from '../state/store.js';
import { AllAppsPage } from './AllAppsPage.js';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const app = (id: string, over: Partial<App> = {}): App => ({
  id, name: id, workspace: null, workspaceRoot: `E:/Git/${id}`, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, open: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const folder = (id: string, name: string, sortOrder = 0): AppFolder => ({ id, name, sortOrder, createdAt: 1, updatedAt: 1 });
const chat = (id: string, appId: string, over: Partial<Chat> = {}): Chat => ({
  id, title: id, profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});

beforeEach(() => {
  window.localStorage.clear();
  resetSidebarGroupsForTests();
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({
    mode: 'code',
    paneState: { ...DEFAULT_PANE_STATE, tabs: [], panes: [ALL_APPS_TAB_ID] },
    activeChatId: ALL_APPS_TAB_ID,
    appsLoaded: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const setup = (apps: App[], chats: Chat[] = [], folders: AppFolder[] = []): void => {
  useOtherBenchStore.setState({ apps, chats, appFolders: folders });
};
const user = () => userEvent.setup();

describe('AllAppsPage', () => {
  it('says how many apps and how many are open', () => {
    setup([app('a', { open: true }), app('b'), app('c', { open: true })]);
    render(<AllAppsPage />);
    expect(screen.getByText('3 apps · 2 open')).toBeTruthy();
  });

  it('shows a card with path, chat count, status words, last used and In sidebar when open', () => {
    setup(
      [app('alpha', { open: true })],
      [chat('c1', 'alpha', { updatedAt: NOW - 5 * 60_000 }), chat('c2', 'alpha', { updatedAt: NOW - 3_600_000 })]
    );
    useOtherBenchStore.setState({ appRunningTurns: { t1: 'c1' } });
    render(<AllAppsPage />);
    const card = screen.getByTestId('all-apps-card-alpha');
    expect(within(card).getByText('alpha')).toBeTruthy();
    expect(within(card).getByText('E:/Git/alpha')).toBeTruthy();
    expect(within(card).getByText('2 chats')).toBeTruthy();
    expect(within(card).getByText('Replying')).toBeTruthy();
    expect(within(card).getByText('5 min ago')).toBeTruthy();
    expect(within(card).getByText('In sidebar')).toBeTruthy();
  });

  it('says No chats yet for an app without chats and shows no In sidebar for a closed one', () => {
    setup([app('alpha')]);
    render(<AllAppsPage />);
    const card = screen.getByTestId('all-apps-card-alpha');
    expect(within(card).getByText('No chats yet')).toBeTruthy();
    expect(within(card).queryByText('In sidebar')).toBeNull();
  });

  it('says Not on this machine for an app with no folder here', () => {
    setup([app('alpha', { workspaceRoot: null })]);
    render(<AllAppsPage />);
    expect(within(screen.getByTestId('all-apps-card-alpha')).getByText('Not on this machine')).toBeTruthy();
  });

  it("clicking a closed app's card opens it and shows its home", async () => {
    setup([app('alpha')]);
    vi.mocked(api.apps.patch).mockResolvedValue(app('alpha', { open: true }));
    render(<AllAppsPage />);
    await user().click(screen.getByTestId('all-apps-card-alpha'));
    expect(api.apps.patch).toHaveBeenCalledWith('alpha', { open: true });
    expect(useOtherBenchStore.getState().apps[0]!.open).toBe(true);
    expect(useOtherBenchStore.getState().activeChatId).toBe(appTabId('alpha'));
  });

  it("clicking an open app's card shows its home without a PATCH", async () => {
    setup([app('alpha', { open: true })]);
    render(<AllAppsPage />);
    await user().click(screen.getByTestId('all-apps-card-alpha'));
    expect(api.apps.patch).not.toHaveBeenCalled();
    expect(useOtherBenchStore.getState().activeChatId).toBe(appTabId('alpha'));
  });

  it('still shows the home when opening fails, and says so', async () => {
    setup([app('alpha')]);
    vi.mocked(api.apps.patch).mockRejectedValue(new Error('offline'));
    render(<AllAppsPage />);
    await user().click(screen.getByTestId('all-apps-card-alpha'));
    expect(useOtherBenchStore.getState().activeChatId).toBe(appTabId('alpha'));
    expect(useToasts.getState().toasts.map((t) => t.text).join(' ')).toContain("Couldn't add the app to the sidebar");
  });

  it('remembers the grid/list switch in localStorage', async () => {
    setup([app('alpha')]);
    const { unmount } = render(<AllAppsPage />);
    expect(screen.getByTestId('all-apps-grid')).toBeTruthy();
    await user().click(screen.getByRole('button', { name: 'List' }));
    expect(window.localStorage.getItem('otherbench.allApps.layout')).toBe('list');
    expect(screen.getByTestId('all-apps-list')).toBeTruthy();
    unmount();
    render(<AllAppsPage />);
    expect(screen.getByTestId('all-apps-list')).toBeTruthy();
  });

  it('+ New app opens the app form', async () => {
    setup([]);
    render(<AllAppsPage />);
    await user().click(screen.getByRole('button', { name: '+ New app' }));
    expect(useOtherBenchStore.getState().appPage).toEqual({ mode: 'create' });
  });

  it('filters by the search box and hides sections with no match', async () => {
    setup([app('alpha', { folderId: 'f1' }), app('beta')], [], [folder('f1', 'Business')]);
    render(<AllAppsPage />);
    await user().type(screen.getByRole('searchbox'), 'beta');
    expect(screen.queryByTestId('all-apps-card-alpha')).toBeNull();
    expect(screen.getByTestId('all-apps-card-beta')).toBeTruthy();
    expect(screen.queryByText('Business')).toBeNull();
  });

  it('shows No apps yet in an empty folder', () => {
    setup([], [], [folder('f1', 'Business')]);
    render(<AllAppsPage />);
    expect(screen.getByText('No apps yet')).toBeTruthy();
  });

  it('folds a section and keeps it folded across a re-render', async () => {
    setup([app('alpha', { folderId: 'f1' })], [], [folder('f1', 'Business')]);
    const { unmount } = render(<AllAppsPage />);
    await user().click(screen.getByRole('button', { name: /Business/ }));
    expect(screen.queryByTestId('all-apps-card-alpha')).toBeNull();
    unmount();
    render(<AllAppsPage />);
    expect(screen.queryByTestId('all-apps-card-alpha')).toBeNull();
  });
});
