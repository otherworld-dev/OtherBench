import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, AppFolder, Chat } from '@otherbench/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      apps: { ...actual.api.apps, patch: vi.fn(), delete: vi.fn(), list: vi.fn() },
      appFolders: { ...actual.api.appFolders, create: vi.fn(), patch: vi.fn(), delete: vi.fn(), list: vi.fn() },
    },
  };
});

import { useToasts } from '../lib/toasts.js';
import { PROJECT_DRAG_MIME } from '../panes/sidebar/ProjectGroup.js';
import { ApiError, api } from '../state/api.js';
import { ALL_APPS_TAB_ID } from '../state/allAppsTab.js';
import { appTabId } from '../state/appTab.js';
import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { resetSidebarGroupsForTests, setGroupCollapsed } from '../state/sidebarGroups.js';
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
    expect(within(card).queryByText('0 chats')).toBeNull();
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

  it('Enter and Space on a focused card open the app and show its home', async () => {
    setup([app('alpha'), app('beta')]);
    vi.mocked(api.apps.patch).mockImplementation(async (id) => app(id, { open: true }));
    render(<AllAppsPage />);
    const u = user();
    screen.getByTestId('all-apps-card-alpha').focus();
    await u.keyboard('{Enter}');
    expect(api.apps.patch).toHaveBeenCalledWith('alpha', { open: true });
    expect(useOtherBenchStore.getState().activeChatId).toBe(appTabId('alpha'));

    screen.getByTestId('all-apps-card-beta').focus();
    await u.keyboard(' ');
    expect(api.apps.patch).toHaveBeenCalledWith('beta', { open: true });
    expect(useOtherBenchStore.getState().activeChatId).toBe(appTabId('beta'));
    expect(useOtherBenchStore.getState().apps.map((a) => a.open)).toEqual([true, true]);
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
    const fold = screen.getByRole('button', { name: /Business/ });
    expect(document.getElementById(fold.getAttribute('aria-controls')!)).toBeTruthy();
    await user().click(fold);
    expect(screen.queryByTestId('all-apps-card-alpha')).toBeNull();
    // Folded, it points at no list: there is none in the page.
    expect(fold.getAttribute('aria-controls')).toBeNull();
    unmount();
    render(<AllAppsPage />);
    expect(screen.queryByTestId('all-apps-card-alpha')).toBeNull();
  });

  it('a search shows a folded section unfolded, and the fold comes back when the search clears', async () => {
    setup([app('alpha', { folderId: 'f1' }), app('beta')], [], [folder('f1', 'Business')]);
    setGroupCollapsed('folder:f1', true);
    render(<AllAppsPage />);
    expect(screen.queryByTestId('all-apps-card-alpha')).toBeNull();
    const u = user();
    await u.type(screen.getByRole('searchbox'), 'alp');
    expect(screen.getByTestId('all-apps-card-alpha')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Business/ }).getAttribute('aria-expanded')).toBe('true');
    // The stored fold is untouched by the search.
    expect(window.localStorage.getItem('otherbench.collapsedGroups')).toContain('folder:f1');
    await u.clear(screen.getByRole('searchbox'));
    expect(screen.queryByTestId('all-apps-card-alpha')).toBeNull();
    expect(screen.getByRole('button', { name: /Business/ }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('AllAppsPage folders, card menu and drag (plan 2026-11-04-open-apps Task 6)', () => {
  const mockedAppPatch = vi.mocked(api.apps.patch);
  const mockedAppDelete = vi.mocked(api.apps.delete);
  const mockedAppList = vi.mocked(api.apps.list);
  const mockedFolderCreate = vi.mocked(api.appFolders.create);
  const mockedFolderPatch = vi.mocked(api.appFolders.patch);
  const mockedFolderDelete = vi.mocked(api.appFolders.delete);
  const mockedFolderList = vi.mocked(api.appFolders.list);

  const games = folder('F1', 'Games', 0);
  const work = folder('F2', 'Work', 1);
  // Games holds Alpha and Beta; Work holds Wiki; Gamma is Unfiled, its sortOrder below Alpha's.
  const filed = [
    app('A', { name: 'Alpha', folderId: 'F1', sortOrder: 1, open: true }),
    app('B', { name: 'Beta', folderId: 'F1', sortOrder: 2 }),
    app('W', { name: 'Wiki', folderId: 'F2', sortOrder: 0 }),
    app('G', { name: 'Gamma', sortOrder: 0 }),
  ];

  function setupFolders(over: { apps?: App[]; folders?: AppFolder[] } = {}) {
    mockedAppPatch.mockImplementation(async (id, body) => ({ ...useOtherBenchStore.getState().apps.find((a) => a.id === id)!, ...body }));
    mockedFolderPatch.mockImplementation(async (id, body) => ({ ...useOtherBenchStore.getState().appFolders.find((f) => f.id === id)!, ...body }));
    setup(over.apps ?? filed, [], over.folders ?? [work, games]);
    render(<AllAppsPage />);
    return user();
  }

  /** The page's sections and their cards, in order: `folder:F1`, `A`, `B`, ... */
  const layoutOrder = (): string[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="all-apps-section-"], [data-testid^="all-apps-card-"]')).map((el) =>
      el.getAttribute('data-testid')!.replace(/^all-apps-(section|card)-/, '')
    );
  const card = (id: string) => screen.getByTestId(`all-apps-card-${id}`);
  const section = (key: string) => screen.getByTestId(`all-apps-section-${key}`);
  const heading = (key: string) => screen.getByTestId(`all-apps-heading-${key}`);
  const fold = (key: string) => within(heading(key)).getAllByRole('button')[0]!;
  const transfer = (key: string) => ({ types: [PROJECT_DRAG_MIME], getData: (t: string) => (t === PROJECT_DRAG_MIME ? key : ''), setData: vi.fn(), dropEffect: 'none', effectAllowed: 'all' });
  const rect = (el: HTMLElement) => {
    el.getBoundingClientRect = () => ({ top: 100, height: 20, bottom: 120, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) });
  };
  /** A drag event at the first (`before`) or second (`after`) half of `el`: left/right in the grid, top/bottom in the list. */
  const at = (kind: 'dragOver' | 'drop', el: HTMLElement, key: string, half: 'before' | 'after') => {
    rect(el);
    const ev = createEvent[kind](el, { dataTransfer: transfer(key) });
    Object.defineProperty(ev, 'clientX', { value: half === 'before' ? 25 : 75 });
    Object.defineProperty(ev, 'clientY', { value: half === 'before' ? 105 : 115 });
    fireEvent(el, ev);
  };
  const dragCard = (id: string) => fireEvent.dragStart(card(id), { dataTransfer: transfer(id) });
  const dragFolder = (key: string) => fireEvent.dragStart(fold(key), { dataTransfer: transfer(key) });
  const openCardMenu = async (u: ReturnType<typeof user>, id: string) => u.click(within(card(id)).getByRole('button', { name: 'App actions' }));
  const openFolderMenu = async (u: ReturnType<typeof user>, key: string) => u.click(within(heading(key)).getByRole('button', { name: 'Folder actions' }));

  it('shows a section per folder in folder order, then Unfiled, each counting its apps', () => {
    setupFolders();
    expect(layoutOrder()).toEqual(['folder:F1', 'A', 'B', 'folder:F2', 'W', 'folder:unfiled', 'G']);
    expect(within(heading('folder:F1')).getByText('2')).toBeTruthy();
  });

  it('with folders but no apps, shows the folders rather than the no-apps note', () => {
    setupFolders({ apps: [] });
    expect(section('folder:F1')).toBeTruthy();
    expect(screen.queryByText(/No apps yet\. Add one/)).toBeNull();
  });

  it('a search that matches only inside a folder shows that folder and no "No apps match"', async () => {
    const u = setupFolders();
    await u.type(screen.getByRole('searchbox'), 'alpha');
    expect(layoutOrder()).toEqual(['folder:F1', 'A']);
    expect(screen.queryByText('No apps match.')).toBeNull();
  });

  it('+ New folder creates "New folder" with its name being edited', async () => {
    mockedFolderCreate.mockResolvedValue(folder('F9', 'New folder', 2));
    const u = setupFolders();
    const button = screen.getByRole('button', { name: '+ New folder' });
    expect(button.className).not.toContain('btn-primary');
    expect(screen.getByRole('button', { name: '+ New app' }).className).toContain('btn-primary');
    await u.click(button);
    expect(mockedFolderCreate).toHaveBeenCalledWith({});
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    expect(input).toHaveProperty('value', 'New folder');
    await u.clear(input);
    await u.type(input, 'PhD{Enter}');
    expect(mockedFolderPatch).toHaveBeenCalledWith('F9', { name: 'PhD' });
    await waitFor(() => expect(within(heading('folder:F9')).getByText('PhD')).toBeTruthy());
  });

  it('a double-click on + New folder makes one folder', async () => {
    let release: (f: AppFolder) => void = () => {};
    mockedFolderCreate.mockReturnValue(new Promise<AppFolder>((resolve) => (release = resolve)));
    const u = setupFolders();
    await u.dblClick(screen.getByRole('button', { name: '+ New folder' }));
    release(folder('F9', 'New folder', 2));
    await screen.findByRole('textbox', { name: 'Folder name' });
    expect(mockedFolderCreate).toHaveBeenCalledTimes(1);
  });

  it('+ New folder while searching clears the search so the new folder and its rename show', async () => {
    mockedFolderCreate.mockResolvedValue(folder('F9', 'New folder', 2));
    const u = setupFolders();
    const search = screen.getByRole('searchbox');
    await u.type(search, 'alpha');
    await u.click(screen.getByRole('button', { name: '+ New folder' }));
    expect(await screen.findByRole('textbox', { name: 'Folder name' })).toBeTruthy();
    expect(search).toHaveProperty('value', '');
    expect(card('G')).toBeTruthy();
  });

  it('a failed + New folder says so under the header', async () => {
    mockedFolderCreate.mockRejectedValue(new ApiError(500, 'disk full'));
    const u = setupFolders();
    await u.click(screen.getByRole('button', { name: '+ New folder' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't create the folder: disk full");
  });

  it('folder menu: Rename, Move up, Move down, Delete…; Rename saves the name; Unfiled has no menu', async () => {
    const u = setupFolders();
    expect(within(heading('folder:unfiled')).queryByRole('button', { name: 'Folder actions' })).toBeNull();
    await openFolderMenu(u, 'folder:F1');
    const menu = screen.getByRole('menu', { name: 'Folder actions' });
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Rename', 'Move up', 'Move down', 'Delete…']);
    expect(within(menu).getByRole('menuitem', { name: 'Move up' })).toHaveProperty('disabled', true);
    await u.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Folder name' });
    await u.clear(input);
    await u.type(input, 'Play{Enter}');
    expect(mockedFolderPatch).toHaveBeenCalledWith('F1', { name: 'Play' });
    await waitFor(() => expect(within(heading('folder:F1')).getByText('Play')).toBeTruthy());
  });

  it("a folder's Move down and Move up reorder the folders, saving the order", async () => {
    const u = setupFolders();
    await openFolderMenu(u, 'folder:F1');
    await u.click(screen.getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(layoutOrder()).toEqual(['folder:F2', 'W', 'folder:F1', 'A', 'B', 'folder:unfiled', 'G']));
    expect(mockedFolderPatch.mock.calls).toEqual([
      ['F2', { sortOrder: 0 }],
      ['F1', { sortOrder: 1 }],
    ]);
    mockedFolderPatch.mockClear();
    await openFolderMenu(u, 'folder:F1');
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toHaveProperty('disabled', true);
    await u.click(screen.getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(layoutOrder()[0]).toBe('folder:F1'));
    expect(mockedFolderPatch.mock.calls).toEqual([
      ['F1', { sortOrder: 0 }],
      ['F2', { sortOrder: 1 }],
    ]);
  });

  it('deleting a folder moves its apps to Unfiled, and the open app home stays open', async () => {
    mockedFolderDelete.mockResolvedValue(undefined);
    const u = setupFolders();
    useOtherBenchStore.setState({ activeChatId: appTabId('A') });
    await openFolderMenu(u, 'folder:F1');
    await u.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Games?' });
    expect(dialog.textContent).toContain('Its apps move out of the folder; nothing is deleted.');
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(mockedFolderDelete).toHaveBeenCalledWith('F1');
    await waitFor(() => expect(screen.queryByTestId('all-apps-section-folder:F1')).toBeNull());
    expect(layoutOrder()).toEqual(['folder:F2', 'W', 'folder:unfiled', 'G', 'A', 'B']);
    expect(useOtherBenchStore.getState().activeChatId).toBe(appTabId('A'));
    expect(mockedAppDelete).not.toHaveBeenCalled();
  });

  it('a 404 on deleting a folder counts as already gone', async () => {
    mockedFolderDelete.mockRejectedValue(new ApiError(404, 'Folder "F1" not found.'));
    const u = setupFolders();
    await openFolderMenu(u, 'folder:F1');
    await u.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await u.click(within(screen.getByRole('alertdialog', { name: 'Delete Games?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByTestId('all-apps-section-folder:F1')).toBeNull());
    expect(layoutOrder()).toEqual(['folder:F2', 'W', 'folder:unfiled', 'G', 'A', 'B']);
  });

  it('the card menu offers Open, Close app, Rename, Edit…, Move to folder…, Move up, Move down, Delete…', async () => {
    const u = setupFolders();
    await openCardMenu(u, 'A');
    const menu = screen.getByRole('menu', { name: 'App actions' });
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent.replace('▸', ''))).toEqual(['Open', 'Close app', 'Rename', 'Edit…', 'Move to folder…', 'Move up', 'Move down', 'Delete…']);
    // The ⋯ button doesn't open the app.
    expect(useOtherBenchStore.getState().activeChatId).toBe(ALL_APPS_TAB_ID);
  });

  it('the card menu: Open opens a closed app and its home, Close app closes an open one, Edit… opens the form', async () => {
    const u = setupFolders();
    await openCardMenu(u, 'B');
    await u.click(screen.getByRole('menuitem', { name: 'Open' }));
    expect(mockedAppPatch).toHaveBeenCalledWith('B', { open: true });
    expect(useOtherBenchStore.getState().activeChatId).toBe(appTabId('B'));
    useOtherBenchStore.setState({ activeChatId: ALL_APPS_TAB_ID });
    await openCardMenu(u, 'A');
    await u.click(screen.getByRole('menuitem', { name: 'Close app' }));
    expect(mockedAppPatch).toHaveBeenCalledWith('A', { open: false });
    await waitFor(() => expect(useOtherBenchStore.getState().apps.find((a) => a.id === 'A')!.open).toBe(false));
    await openCardMenu(u, 'G');
    await u.click(screen.getByRole('menuitem', { name: 'Edit…' }));
    expect(useOtherBenchStore.getState().appPage).toMatchObject({ mode: 'edit', appId: 'G' });
  });

  it('Move to folder… files the app last in that folder and opens a folded one', async () => {
    setGroupCollapsed('folder:F1', true);
    const u = setupFolders();
    await openCardMenu(u, 'G');
    await u.click(screen.getByRole('menuitem', { name: 'Move to folder…' }));
    const submenu = screen.getByRole('menu', { name: 'Move to folder…' });
    expect(within(submenu).getAllByRole('menuitemradio').map((i) => [i.textContent.replace('✓', '').trim(), i.getAttribute('aria-checked')])).toEqual([
      ['No folder', 'true'],
      ['Games', 'false'],
      ['Work', 'false'],
    ]);
    await u.click(within(submenu).getByRole('menuitemradio', { name: 'Games' }));
    // Games is renumbered 0..n-1, the moved app last.
    expect(mockedAppPatch.mock.calls).toEqual([
      ['A', { sortOrder: 0 }],
      ['B', { sortOrder: 1 }],
      ['G', { folderId: 'F1', sortOrder: 2 }],
    ]);
    await waitFor(() => expect(layoutOrder()).toEqual(['folder:F1', 'A', 'B', 'G', 'folder:F2', 'W']));
    expect(fold('folder:F1').getAttribute('aria-expanded')).toBe('true');
  });

  it('Move to folder… on the current folder files nothing and returns focus to the card', async () => {
    const u = setupFolders();
    await openCardMenu(u, 'A');
    await u.click(screen.getByRole('menuitem', { name: 'Move to folder…' }));
    await u.click(within(screen.getByRole('menu', { name: 'Move to folder…' })).getByRole('menuitemradio', { name: 'Games' }));
    expect(mockedAppPatch).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(card('A')));
  });

  it("Move to folder… that fails says so and shows the server's apps", async () => {
    const u = setupFolders();
    mockedAppPatch.mockReset();
    mockedAppPatch.mockRejectedValue(new Error('offline'));
    mockedAppList.mockResolvedValue(filed);
    await openCardMenu(u, 'G');
    await u.click(screen.getByRole('menuitem', { name: 'Move to folder…' }));
    await u.click(within(screen.getByRole('menu', { name: 'Move to folder…' })).getByRole('menuitemradio', { name: 'Work' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't move the app/);
    expect(mockedAppList).toHaveBeenCalled();
    expect(within(section('folder:F2')).queryByTestId('all-apps-card-G')).toBeNull();
  });

  it('Move up / Move down reorder within the section; Move up is off on the first app of a folder even with an Unfiled app sorting above', async () => {
    const u = setupFolders();
    await openCardMenu(u, 'A');
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toHaveProperty('disabled', true);
    await u.click(screen.getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(layoutOrder()).toEqual(['folder:F1', 'B', 'A', 'folder:F2', 'W', 'folder:unfiled', 'G']));
    // Games renumbers to 0..1 on its own; Alpha already has 1.
    expect(mockedAppPatch.mock.calls).toEqual([['B', { sortOrder: 0 }]]);
    mockedAppPatch.mockClear();
    await openCardMenu(u, 'A');
    await u.click(screen.getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(layoutOrder().slice(0, 3)).toEqual(['folder:F1', 'A', 'B']));
    expect(mockedAppPatch.mock.calls).toEqual([
      ['A', { sortOrder: 0 }],
      ['B', { sortOrder: 1 }],
    ]);
  });

  it('Rename on a card edits its name inline; clicking the field does not open the app', async () => {
    const u = setupFolders();
    await openCardMenu(u, 'G');
    await u.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = within(card('G')).getByRole('textbox', { name: 'App name' });
    await u.click(input);
    expect(useOtherBenchStore.getState().activeChatId).toBe(ALL_APPS_TAB_ID);
    await u.clear(input);
    await u.type(input, 'Gamma two{Enter}');
    expect(mockedAppPatch).toHaveBeenCalledWith('G', { name: 'Gamma two' });
    await waitFor(() => expect(within(card('G')).getByText('Gamma two')).toBeTruthy());
    expect(useOtherBenchStore.getState().activeChatId).toBe(ALL_APPS_TAB_ID);
  });

  it('Delete… confirms then removes the app', async () => {
    mockedAppDelete.mockResolvedValue(undefined);
    const u = setupFolders();
    await openCardMenu(u, 'A');
    await u.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Alpha?' });
    expect(dialog.textContent).toContain('Its chats move back to Chat mode; nothing is deleted.');
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(mockedAppDelete).toHaveBeenCalledWith('A');
    await waitFor(() => expect(screen.queryByTestId('all-apps-card-A')).toBeNull());
    expect(useOtherBenchStore.getState().apps.map((a) => a.id)).toEqual(['B', 'W', 'G']);
  });

  it('card menu for an app deleted meanwhile closes without error', async () => {
    const u = setupFolders();
    await openCardMenu(u, 'A');
    expect(screen.getByRole('menu', { name: 'App actions' })).toBeTruthy();
    act(() => useOtherBenchStore.getState().removeApp('A'));
    expect(screen.queryByRole('menu', { name: 'App actions' })).toBeNull();
    // A drag onto a folder that has gone meanwhile does nothing either.
    dragCard('G');
    const target = section('folder:F2');
    act(() => useOtherBenchStore.getState().removeAppFolder('F2'));
    at('drop', target, 'G', 'after');
    expect(mockedAppPatch).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('dragging a card onto another section files it there, last, and opens a folded one', async () => {
    setGroupCollapsed('folder:F2', true);
    setupFolders();
    dragCard('G');
    at('dragOver', section('folder:F2'), 'G', 'before');
    expect(section('folder:F2').getAttribute('data-drop-active')).toBe('true');
    at('drop', section('folder:F2'), 'G', 'before');
    await waitFor(() => expect(layoutOrder()).toEqual(['folder:F1', 'A', 'B', 'folder:F2', 'W', 'G']));
    expect(mockedAppPatch.mock.calls).toEqual([['G', { folderId: 'F2', sortOrder: 1 }]]);
    expect(section('folder:F2').getAttribute('data-drop-active')).toBeNull();
  });

  it("a card's own section takes no drop", () => {
    setupFolders();
    dragCard('A');
    at('dragOver', section('folder:F1'), 'A', 'before');
    expect(section('folder:F1').getAttribute('data-drop-active')).toBeNull();
    at('drop', section('folder:F1'), 'A', 'before');
    expect(mockedAppPatch).not.toHaveBeenCalled();
  });

  it('dragging a card onto a card places it before or after, filing it in that section', async () => {
    setupFolders();
    dragCard('B');
    at('dragOver', card('W'), 'B', 'before');
    expect(card('W').getAttribute('data-drop-position')).toBe('before');
    at('drop', card('W'), 'B', 'before');
    await waitFor(() => expect(layoutOrder()).toEqual(['folder:F1', 'A', 'folder:F2', 'B', 'W', 'folder:unfiled', 'G']));
    expect(mockedAppPatch.mock.calls).toEqual([
      ['B', { folderId: 'F2', sortOrder: 0 }],
      ['W', { sortOrder: 1 }],
    ]);
    mockedAppPatch.mockClear();
    // Out of its folder, after the Unfiled card it lands on.
    dragCard('A');
    at('drop', card('G'), 'A', 'after');
    await waitFor(() => expect(layoutOrder()).toEqual(['folder:F1', 'folder:F2', 'B', 'W', 'folder:unfiled', 'G', 'A']));
    expect(mockedAppPatch.mock.calls).toEqual([['A', { folderId: null, sortOrder: 1 }]]);
  });

  it('dragging a card within its section reorders it, top/bottom halves in the list layout', async () => {
    window.localStorage.setItem('otherbench.allApps.layout', 'list');
    setupFolders();
    dragCard('B');
    at('dragOver', card('A'), 'B', 'before');
    expect(card('A').getAttribute('data-drop-position')).toBe('before');
    at('drop', card('A'), 'B', 'before');
    await waitFor(() => expect(layoutOrder().slice(0, 3)).toEqual(['folder:F1', 'B', 'A']));
    // Games renumbers to 0..1; Alpha already has 1.
    expect(mockedAppPatch.mock.calls).toEqual([['B', { sortOrder: 0 }]]);
  });

  it('dragging a section heading reorders folders; a failure says so and reloads', async () => {
    setupFolders();
    dragFolder('folder:F2');
    at('dragOver', heading('folder:F1'), 'folder:F2', 'before');
    expect(heading('folder:F1').getAttribute('data-drop-position')).toBe('before');
    at('drop', heading('folder:F1'), 'folder:F2', 'before');
    await waitFor(() => expect(layoutOrder()[0]).toBe('folder:F2'));
    expect(mockedFolderPatch.mock.calls).toEqual([
      ['F2', { sortOrder: 0 }],
      ['F1', { sortOrder: 1 }],
    ]);

    mockedFolderPatch.mockRejectedValue(new Error('offline'));
    mockedFolderList.mockResolvedValue([games, { ...work, sortOrder: 1 }]);
    dragFolder('folder:F1');
    at('drop', heading('folder:F2'), 'folder:F1', 'before');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't reorder the folders/);
    await waitFor(() => expect(layoutOrder()[0]).toBe('folder:F1'));
  });

  it('a folder heading takes no drop of its own folder, and a card or Unfiled takes no folder', () => {
    setupFolders();
    dragFolder('folder:F1');
    at('dragOver', heading('folder:F1'), 'folder:F1', 'before');
    expect(heading('folder:F1').getAttribute('data-drop-position')).toBeNull();
    at('dragOver', card('W'), 'folder:F1', 'before');
    expect(card('W').getAttribute('data-drop-position')).toBeNull();
    at('drop', card('W'), 'folder:F1', 'before');
    at('dragOver', heading('folder:unfiled'), 'folder:F1', 'before');
    expect(heading('folder:unfiled').getAttribute('data-drop-position')).toBeNull();
    at('drop', heading('folder:unfiled'), 'folder:F1', 'before');
    expect(mockedFolderPatch).not.toHaveBeenCalled();
    expect(mockedAppPatch).not.toHaveBeenCalled();
  });

  it('searching turns dragging off', async () => {
    const u = setupFolders();
    await u.type(screen.getByRole('searchbox'), 'a');
    expect(card('A').getAttribute('draggable')).toBe('false');
    expect(fold('folder:F1').getAttribute('draggable')).toBe('false');
  });
});
