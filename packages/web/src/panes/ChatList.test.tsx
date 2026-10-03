import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';

const desktopListeners = new Map<string, () => void>();
const unlisten = vi.fn();
vi.mock('../desktop/bridge.js', () => ({
  onDesktopEvent: vi.fn(async (name: string, cb: () => void) => {
    desktopListeners.set(name, cb);
    return unlisten;
  }),
}));

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      chats: { ...actual.api.chats, create: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      projects: { list: vi.fn(), create: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      search: vi.fn(),
      health: vi.fn(),
    },
  };
});

import { ApiError, api, type SearchResult } from '../state/api.js';
import { COLLAPSED_GROUPS_STORAGE_KEY, NO_PROJECT_KEY, resetSidebarGroupsForTests, setGroupCollapsed } from '../state/sidebarGroups.js';
import { useGruntStore } from '../state/store.js';
import { ChatList } from './ChatList.js';
import { CHAT_DRAG_MIME } from './sidebar/ChatRow.js';

const mockedCreate = vi.mocked(api.chats.create);
const mockedPatch = vi.mocked(api.chats.patch);
const mockedDelete = vi.mocked(api.chats.delete);
const mockedProjectList = vi.mocked(api.projects.list);
const mockedProjectCreate = vi.mocked(api.projects.create);
const mockedProjectPatch = vi.mocked(api.projects.patch);
const mockedProjectDelete = vi.mocked(api.projects.delete);
const mockedSearch = vi.mocked(api.search);
const mockedHealth = vi.mocked(api.health);

const profile: Profile = {
  id: 'profile-1',
  name: 'Everyday',
  description: null,
  colour: null,
  connectionId: 'conn-1',
  modelId: 'm',
  systemPrompt: null,
  params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
  isDefault: true,
  archivedAt: null,
};

const chat: Chat = {
  id: 'chat-new',
  title: 'New Chat',
  profileId: 'profile-1',
  headMessageId: null,
  workspaceRoot: null,
  pinned: false,
  autoMode: false,
  projectId: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

function makeChat(overrides: Partial<Chat> & { id: string }): Chat {
  return { ...chat, title: `Chat ${overrides.id}`, ...overrides };
}

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return { name: overrides.id, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...overrides };
}

/** The chat ids shown in one sidebar group, top to bottom. */
function rowIds(groupTestId: string): string[] {
  return within(screen.getByTestId(groupTestId))
    .queryAllByTestId(/^chat-row-/)
    .map((el) => el.getAttribute('data-testid')!.slice('chat-row-'.length));
}

function headingOrder(): string[] {
  return screen.getAllByTestId(/^group-heading-/).map((el) => el.getAttribute('data-testid')!.slice('group-heading-'.length));
}

/** A fake DataTransfer: jsdom has none. `chatId: null` stands for a non-chat drag (files). */
function dataTransfer(chatId: string | null) {
  return {
    types: chatId === null ? ['Files'] : [CHAT_DRAG_MIME],
    getData: (type: string) => (type === CHAT_DRAG_MIME && chatId !== null ? chatId : ''),
    setData: vi.fn(),
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ profiles: [profile] });
  desktopListeners.clear();
  window.localStorage.clear();
  resetSidebarGroupsForTests();
  mockedHealth.mockResolvedValue({ status: 'ok', time: '', platform: 'linux' });
  // Like the server: PATCH returns the stored row with the body applied.
  mockedPatch.mockImplementation(async (id, body) => ({ ...useGruntStore.getState().chats.find((c) => c.id === id)!, ...body }));
  mockedProjectPatch.mockImplementation(async (id, body) => ({ ...useGruntStore.getState().projects.find((p) => p.id === id)!, ...body }));
  mockedProjectList.mockImplementation(async () => useGruntStore.getState().projects);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatList desktop integration', () => {
  it('starts a new chat with the default profile when the tray asks for one', async () => {
    mockedCreate.mockResolvedValue(chat);
    render(<ChatList />);
    await waitFor(() => expect(desktopListeners.has('tray-new-chat')).toBe(true));

    desktopListeners.get('tray-new-chat')!();

    await waitFor(() => expect(useGruntStore.getState().activeChatId).toBe('chat-new'));
    expect(mockedCreate).toHaveBeenCalledWith({ profileId: 'profile-1' });
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = render(<ChatList />);
    await waitFor(() => expect(desktopListeners.has('tray-new-chat')).toBe(true));

    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe('ChatList groups', () => {
  it('shows Pinned, then projects by sortOrder and name, then No project; pinned chats only under Pinned; archived nowhere', () => {
    useGruntStore.setState({
      projects: [makeProject({ id: 'p-b', name: 'Beta', sortOrder: 1 }), makeProject({ id: 'p-a', name: 'alpha', sortOrder: 1 }), makeProject({ id: 'p-z', name: 'Zed' })],
      chats: [
        makeChat({ id: 'c1', projectId: 'p-a' }),
        makeChat({ id: 'c2', projectId: 'p-b', pinned: true }),
        makeChat({ id: 'c3' }),
        makeChat({ id: 'c4', projectId: 'p-a', archivedAt: 5, title: 'Archived one' }),
      ],
    });
    render(<ChatList />);

    expect(headingOrder()).toEqual(['p-z', 'p-a', 'p-b', NO_PROJECT_KEY]);
    expect(rowIds('group-pinned')).toEqual(['c2']);
    expect(rowIds('group-p-b')).toEqual([]);
    expect(screen.getByTestId('group-count-p-b')).toHaveTextContent('1');
    expect(rowIds('group-p-a')).toEqual(['c1']);
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['c3']);
    expect(screen.queryByText('Archived one')).toBeNull();
    expect(within(screen.getByTestId('group-p-z')).getByText('No chats yet')).toBeInTheDocument();
    expect(within(screen.getByTestId(`group-${NO_PROJECT_KEY}`)).queryByRole('button', { name: 'Project actions' })).toBeNull();
    expect(within(screen.getByTestId(`group-${NO_PROJECT_KEY}`)).queryByRole('button', { name: /^New chat in/ })).toBeNull();
  });

  it('collapses a group from its heading, remembers it across a remount, and keeps aria-expanded in step', async () => {
    const user = userEvent.setup();
    useGruntStore.setState({ projects: [makeProject({ id: 'p-a', name: 'Alpha' })], chats: [makeChat({ id: 'c1', projectId: 'p-a' })] });
    const { unmount } = render(<ChatList />);

    const heading = screen.getByRole('button', { name: /^Alpha/ });
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    await user.click(heading);
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(rowIds('group-p-a')).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)!)).toEqual(['p-a']);

    unmount();
    resetSidebarGroupsForTests();
    render(<ChatList />);
    expect(screen.getByRole('button', { name: /^Alpha/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it("a project's + creates a chat with only its projectId, opens it, and expands the group if it was collapsed (review focus 1)", async () => {
    const user = userEvent.setup();
    useGruntStore.setState({ projects: [makeProject({ id: 'p-a', name: 'Alpha', workspaceRoot: '/w' })] });
    window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(['p-a']));
    mockedCreate.mockResolvedValue(makeChat({ id: 'c-new', projectId: 'p-a', workspaceRoot: '/w' }));
    render(<ChatList />);

    await user.click(screen.getByRole('button', { name: 'New chat in Alpha' }));

    expect(mockedCreate).toHaveBeenCalledWith({ projectId: 'p-a' });
    await waitFor(() => expect(useGruntStore.getState().activeChatId).toBe('c-new'));
    expect(screen.getByRole('button', { name: /^Alpha/ })).toHaveAttribute('aria-expanded', 'true');
    expect(rowIds('group-p-a')).toEqual(['c-new']);
  });

  it('"+ New chat" creates in No project and expands No project if it was collapsed (review focus 1)', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify([NO_PROJECT_KEY]));
    mockedCreate.mockResolvedValue(makeChat({ id: 'c-new' }));
    render(<ChatList />);

    await user.click(screen.getByRole('button', { name: '+ New chat' }));

    expect(mockedCreate).toHaveBeenCalledWith({ profileId: 'profile-1' });
    await waitFor(() => expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['c-new']));
  });

  it('searching filters every group, hides groups without a match, and shows collapsed groups expanded', async () => {
    const user = userEvent.setup();
    useGruntStore.setState({
      projects: [makeProject({ id: 'p-a', name: 'Alpha' }), makeProject({ id: 'p-b', name: 'Beta' })],
      chats: [makeChat({ id: 'c1', projectId: 'p-a' }), makeChat({ id: 'c2', projectId: 'p-b' }), makeChat({ id: 'c3' })],
    });
    window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(['p-b']));
    mockedSearch.mockResolvedValue([{ messageId: 'm1', chatId: 'c2', snippet: 'x' }]);
    render(<ChatList />);
    const box = screen.getByRole('searchbox', { name: 'Search chats' });

    await user.type(box, 'x');

    await waitFor(() => expect(screen.queryByTestId('group-p-a')).toBeNull());
    expect(screen.queryByTestId(`group-${NO_PROJECT_KEY}`)).toBeNull();
    expect(rowIds('group-p-b')).toEqual(['c2']);

    await user.clear(box);
    await waitFor(() => expect(screen.getByTestId('group-p-a')).toBeInTheDocument());
    expect(rowIds('group-p-b')).toEqual([]); // collapsed again
  });

  it('clearing the search while a search is in flight shows the full list (review focus 2)', async () => {
    const user = userEvent.setup();
    useGruntStore.setState({ chats: [makeChat({ id: 'c1' }), makeChat({ id: 'c2' })] });
    let resolveSearch!: (results: SearchResult[]) => void;
    mockedSearch.mockImplementation(() => new Promise((resolve) => (resolveSearch = resolve)));
    render(<ChatList />);
    const box = screen.getByRole('searchbox', { name: 'Search chats' });

    await user.type(box, 'x');
    await user.clear(box);
    await act(async () => resolveSearch([{ messageId: 'm', chatId: 'c1', snippet: '' }]));

    expect(rowIds(`group-${NO_PROJECT_KEY}`).sort()).toEqual(['c1', 'c2']);
  });

  it('"+ New project" opens a name field: Enter creates it once (trimmed), Esc cancels, empty is refused', async () => {
    const user = userEvent.setup();
    mockedProjectCreate.mockResolvedValue(makeProject({ id: 'p-new', name: 'Gamma' }));
    render(<ChatList />);

    await user.click(screen.getByRole('button', { name: '+ New project' }));
    const input = screen.getByRole('textbox', { name: 'Project name' });
    expect(input).toHaveAttribute('maxLength', '80');
    await user.keyboard('{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(mockedProjectCreate).not.toHaveBeenCalled();

    await user.type(input, '  Gamma  {Enter}');
    await waitFor(() => expect(screen.getByTestId('group-p-new')).toBeInTheDocument());
    expect(mockedProjectCreate).toHaveBeenCalledTimes(1);
    expect(mockedProjectCreate).toHaveBeenCalledWith({ name: 'Gamma' });
    expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '+ New project' }));
    await user.type(screen.getByRole('textbox', { name: 'Project name' }), 'Nope{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull();
    expect(mockedProjectCreate).toHaveBeenCalledTimes(1);
  });

  it("shows the server's message when creating a project fails", async () => {
    const user = userEvent.setup();
    mockedProjectCreate.mockRejectedValue(new ApiError(400, '"name" must be 1-80 characters after trimming.'));
    render(<ChatList />);

    await user.click(screen.getByRole('button', { name: '+ New project' }));
    await user.type(screen.getByRole('textbox', { name: 'Project name' }), 'Bad{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('"name" must be 1-80 characters after trimming.');
  });
});

describe('ChatList drag and drop', () => {
  beforeEach(() => {
    useGruntStore.setState({
      projects: [makeProject({ id: 'p-a', name: 'Alpha' })],
      chats: [makeChat({ id: 'c1' }), makeChat({ id: 'c2', projectId: 'p-a' })],
    });
  });

  it('highlights a project heading while a chat is dragged over it, and dropping moves the chat there', async () => {
    render(<ChatList />);
    const heading = screen.getByTestId('group-heading-p-a');

    fireEvent.dragOver(heading, { dataTransfer: dataTransfer('c1') });
    expect(heading).toHaveAttribute('data-drop-active', 'true');
    fireEvent.drop(heading, { dataTransfer: dataTransfer('c1') });
    expect(heading).not.toHaveAttribute('data-drop-active');

    expect(mockedPatch).toHaveBeenCalledWith('c1', { projectId: 'p-a' });
    await waitFor(() => expect(rowIds('group-p-a').sort()).toEqual(['c1', 'c2']));
  });

  it('dropping on No project moves the chat out of its project', async () => {
    render(<ChatList />);
    fireEvent.drop(screen.getByTestId(`group-heading-${NO_PROJECT_KEY}`), { dataTransfer: dataTransfer('c2') });
    expect(mockedPatch).toHaveBeenCalledWith('c2', { projectId: null });
    await waitFor(() => expect(rowIds(`group-${NO_PROJECT_KEY}`).sort()).toEqual(['c1', 'c2']));
  });

  it('ignores drags that are not chats, clears the highlight on leave, and sends nothing for a drop on the chat\'s own group (review focus 3)', () => {
    render(<ChatList />);
    const heading = screen.getByTestId('group-heading-p-a');

    fireEvent.dragOver(heading, { dataTransfer: dataTransfer(null) });
    expect(heading).not.toHaveAttribute('data-drop-active');
    fireEvent.dragOver(heading, { dataTransfer: dataTransfer('c2') });
    fireEvent.dragLeave(heading, { dataTransfer: dataTransfer('c2') });
    expect(heading).not.toHaveAttribute('data-drop-active');

    fireEvent.drop(heading, { dataTransfer: dataTransfer('c2') });
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('a pinned chat dropped on a project joins it but stays under Pinned, and the project count goes up', async () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1', pinned: true })] });
    render(<ChatList />);
    expect(screen.getByTestId('group-count-p-a')).toHaveTextContent('0');

    fireEvent.drop(screen.getByTestId('group-heading-p-a'), { dataTransfer: dataTransfer('c1') });

    await waitFor(() => expect(screen.getByTestId('group-count-p-a')).toHaveTextContent('1'));
    expect(rowIds('group-pinned')).toEqual(['c1']);
    expect(rowIds('group-p-a')).toEqual([]);
  });
});

describe('ChatList chat menu', () => {
  function setup() {
    useGruntStore.setState({
      projects: [makeProject({ id: 'p-a', name: 'Alpha', sortOrder: 0 }), makeProject({ id: 'p-b', name: 'Beta', sortOrder: 1 })],
      chats: [makeChat({ id: 'c1', title: 'First', projectId: 'p-a' }), makeChat({ id: 'c2', title: 'Second' })],
      activeChatId: 'c1',
    });
    render(<ChatList />);
    return userEvent.setup();
  }
  const row = (title: string) => screen.getByRole('button', { name: title });

  it('right-click opens the menu on Rename; Escape closes it and returns focus to the row', async () => {
    const user = setup();
    fireEvent.contextMenu(row('First'), { clientX: 40, clientY: 50 });

    expect(screen.getByRole('menu', { name: 'Chat actions' })).toBeInTheDocument();
    for (const name of ['Rename', 'Pin', 'Move to project…', 'Archive', 'Delete…']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(row('First')).toHaveFocus());
  });

  it('Shift+F10 and the context-menu key on a focused row open the same menu', async () => {
    const user = setup();
    row('Second').focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.getByRole('menu', { name: 'Chat actions' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(row('Second')).toHaveFocus());

    fireEvent.keyDown(row('Second'), { key: 'ContextMenu' });
    expect(screen.getByRole('menu', { name: 'Chat actions' })).toBeInTheDocument();
  });

  it('the ⋯ button toggles the menu, and a click outside or a scroll closes it', async () => {
    const user = setup();
    const more = within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Chat actions' });

    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    await user.click(more);
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(more);
    const search = screen.getByRole('searchbox', { name: 'Search chats' });
    await user.click(search);
    expect(screen.queryByRole('menu')).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(search).toHaveFocus(); // a pointerdown-outside dismiss does not steal focus (R4)

    await user.click(more);
    fireEvent.scroll(screen.getByTestId('chat-list-scroll'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Rename edits the title in place: Enter saves the trimmed title, Esc cancels, empty is refused', async () => {
    const user = setup();
    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Chat title' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('First');

    await user.clear(input);
    await user.keyboard('{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(mockedPatch).not.toHaveBeenCalled();

    await user.type(input, '  Renamed  {Enter}');
    await waitFor(() => expect(row('Renamed')).toBeInTheDocument());
    expect(mockedPatch).toHaveBeenCalledWith('c1', { title: 'Renamed' });
    await waitFor(() => expect(row('Renamed')).toHaveFocus());

    fireEvent.contextMenu(row('Renamed'));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await user.type(screen.getByRole('textbox', { name: 'Chat title' }), 'xyz{Escape}');
    expect(row('Renamed')).toBeInTheDocument();
    expect(mockedPatch).toHaveBeenCalledTimes(1);
  });

  it('a title change from elsewhere while renaming does not overwrite what the user typed (review focus 4)', async () => {
    const user = setup();
    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Chat title' });
    await user.clear(input);
    await user.type(input, 'Mine');

    act(() => useGruntStore.getState().upsertChat({ ...useGruntStore.getState().chats.find((c) => c.id === 'c1')!, title: 'Auto title' }));

    expect(input).toHaveValue('Mine');
    await user.keyboard('{Enter}');
    expect(mockedPatch).toHaveBeenCalledWith('c1', { title: 'Mine' });
  });

  it('the menu reflects the chat as it is now, not as it was when opened (review focus 4)', () => {
    setup();
    fireEvent.contextMenu(row('First'));

    act(() => useGruntStore.getState().upsertChat({ ...useGruntStore.getState().chats.find((c) => c.id === 'c1')!, pinned: true }));

    expect(screen.getByRole('menuitem', { name: 'Unpin' })).toBeInTheDocument();
  });

  it('Pin moves the chat under Pinned and puts focus back on its row; the menu then offers Unpin', async () => {
    const user = setup();
    fireEvent.contextMenu(row('Second'));
    await user.click(screen.getByRole('menuitem', { name: 'Pin' }));

    expect(mockedPatch).toHaveBeenCalledWith('c2', { pinned: true });
    await waitFor(() => expect(rowIds('group-pinned')).toEqual(['c2']));
    await waitFor(() => expect(row('Second')).toHaveFocus());
    fireEvent.contextMenu(row('Second'));
    expect(screen.getByRole('menuitem', { name: 'Unpin' })).toBeInTheDocument();
  });

  it('Move to project… lists every project plus No project, marks and focuses the current one, and moves the chat', async () => {
    const user = setup();
    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Move to project…' }));

    const sub = screen.getByRole('menu', { name: 'Move to project…' });
    expect(within(sub).getAllByRole('menuitemradio').map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(within(sub).getByRole('menuitemradio', { name: 'Alpha' })).toHaveFocus();
    await user.click(within(sub).getByRole('menuitemradio', { name: 'Beta' }));

    expect(mockedPatch).toHaveBeenCalledWith('c1', { projectId: 'p-b' });
    await waitFor(() => expect(rowIds('group-p-b')).toEqual(['c1']));
    expect(useGruntStore.getState().chats.find((c) => c.id === 'c1')!.workspaceRoot).toBeNull();
  });

  it('a chat whose project no longer exists shows under No project; its menu marks No project, and choosing it cleans up (review focus 5)', async () => {
    useGruntStore.setState({ projects: [], chats: [makeChat({ id: 'c9', title: 'Orphan', projectId: 'gone' })] });
    render(<ChatList />);
    const user = userEvent.setup();
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['c9']);

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Orphan' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to project…' }));
    const noProject = screen.getByRole('menuitemradio', { name: 'No project' });
    expect(noProject).toHaveAttribute('aria-checked', 'true');
    await user.click(noProject);

    expect(mockedPatch).toHaveBeenCalledWith('c9', { projectId: null });
  });

  it('Archive hides the chat and clears the selection when it was open', async () => {
    const user = setup();
    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));

    expect(mockedPatch).toHaveBeenCalledWith('c1', { archivedAt: expect.any(Number) });
    await waitFor(() => expect(screen.queryByTestId('chat-row-c1')).toBeNull());
    expect(useGruntStore.getState().activeChatId).toBeNull();
  });

  it('Delete… asks first: Cancel keeps the chat and refocuses its row, Delete removes it', async () => {
    const user = setup();
    mockedDelete.mockResolvedValue(undefined);

    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    const dialog = screen.getByRole('alertdialog', { name: "Delete 'First'? This can't be undone." });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mockedDelete).not.toHaveBeenCalled();
    await waitFor(() => expect(row('First')).toHaveFocus());

    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(mockedDelete).toHaveBeenCalledWith('c1');
    await waitFor(() => expect(screen.queryByTestId('chat-row-c1')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useGruntStore.getState().activeChatId).toBeNull();
  });
});

describe('ChatList chat menu focus and unarchive (R4)', () => {
  it('Esc with the opener row hidden (its group collapsed) falls back to the chat list', async () => {
    useGruntStore.setState({ projects: [makeProject({ id: 'p-a', name: 'Alpha' })], chats: [makeChat({ id: 'c1', title: 'First', projectId: 'p-a' })] });
    render(<ChatList />);
    const user = userEvent.setup();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'First' }));
    act(() => setGroupCollapsed('p-a', true));
    expect(screen.queryByTestId('chat-row-c1')).toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Chats' })).toHaveFocus());
  });

  it('a chat deleted elsewhere closes its open menu and leaves focus in the list', async () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1', title: 'First' })] });
    render(<ChatList />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'First' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    act(() => useGruntStore.getState().removeChat('c1'));

    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Chats' })).toHaveFocus());
  });

  it('after Delete, focus lands on a neighbouring row', async () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1', title: 'First' }), makeChat({ id: 'c2', title: 'Second' })], activeChatId: null });
    mockedDelete.mockResolvedValue(undefined);
    render(<ChatList />);
    const user = userEvent.setup();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'First' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByTestId('chat-row-c1')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus());
  });

  it('Unpin sends pinned: false even if the chat was pinned after the menu opened', async () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1', title: 'First' })] });
    render(<ChatList />);
    const user = userEvent.setup();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'First' }));
    act(() => useGruntStore.getState().upsertChat({ ...useGruntStore.getState().chats.find((c) => c.id === 'c1')!, pinned: true }));
    await user.click(screen.getByRole('menuitem', { name: 'Unpin' }));
    expect(mockedPatch).toHaveBeenCalledWith('c1', { pinned: false });
  });
});

describe('ChatList + New project focus (Task 9 carry-over)', () => {
  it('returns focus to + New project after a commit and after a cancel', async () => {
    const user = userEvent.setup();
    mockedProjectCreate.mockResolvedValue(makeProject({ id: 'p-new', name: 'Gamma' }));
    render(<ChatList />);
    const button = () => screen.getByRole('button', { name: '+ New project' });

    await user.click(button());
    await user.type(screen.getByRole('textbox', { name: 'Project name' }), 'Gamma{Enter}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull());
    await waitFor(() => expect(button()).toHaveFocus());

    await user.click(button());
    await user.type(screen.getByRole('textbox', { name: 'Project name' }), 'x{Escape}');
    await waitFor(() => expect(button()).toHaveFocus());
  });

  it('keeps keyboard focus on a + button while a chat is being created (aria-disabled, not disabled)', async () => {
    const user = userEvent.setup();
    let resolveCreate!: (c: Chat) => void;
    mockedCreate.mockImplementation(() => new Promise((resolve) => (resolveCreate = resolve)));
    render(<ChatList />);
    const newChat = screen.getByRole('button', { name: '+ New chat' });
    newChat.focus();
    await user.keyboard('{Enter}');

    expect(newChat).toHaveFocus();
    expect(newChat).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Enter}');
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    await act(async () => resolveCreate(makeChat({ id: 'c-new' })));
    expect(newChat).toHaveFocus();
  });
});

describe('ChatList project menu', () => {
  function setup() {
    useGruntStore.setState({
      profiles: [profile, { ...profile, id: 'profile-2', name: 'Coder', isDefault: false }, { ...profile, id: 'profile-old', name: 'Old', isDefault: false, archivedAt: 9 }],
      projects: [makeProject({ id: 'p-a', name: 'Alpha', sortOrder: 0 }), makeProject({ id: 'p-b', name: 'Beta', sortOrder: 1 })],
      chats: [makeChat({ id: 'c1', title: 'First', projectId: 'p-a' })],
    });
    render(<ChatList />);
    return userEvent.setup();
  }
  const actions = (key: string) => within(screen.getByTestId(`group-heading-${key}`)).getByRole('button', { name: 'Project actions' });
  const heading = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

  it('offers the project actions, with Move up disabled on the first project and Move down on the last', async () => {
    const user = setup();
    await user.click(actions('p-a'));
    expect(screen.getByRole('menu', { name: 'Project actions' })).toBeInTheDocument();
    for (const name of ['Rename', 'Set folder…', 'Default profile…', 'Delete…']) expect(screen.getByRole('menuitem', { name })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toBeEnabled();

    await user.keyboard('{Escape}');
    await user.click(actions('p-b'));
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
  });

  it('Shift+F10 on a project heading opens its menu; Escape returns focus to the heading', async () => {
    const user = setup();
    heading('Alpha').focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.getByRole('menu', { name: 'Project actions' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(heading('Alpha')).toHaveFocus());
  });

  it('opening a chat menu closes an open project menu, and the other way round', async () => {
    const user = setup();
    await user.click(actions('p-a'));
    await user.click(within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Chat actions' }));
    expect(screen.getAllByRole('menu').map((m) => m.getAttribute('aria-label'))).toEqual(['Chat actions']);

    await user.click(actions('p-a'));
    expect(screen.getAllByRole('menu').map((m) => m.getAttribute('aria-label'))).toEqual(['Project actions']);
  });

  it('Rename edits the name in place and saves it', async () => {
    const user = setup();
    await user.click(actions('p-a'));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Project name' });
    await user.clear(input);
    await user.type(input, 'Renamed{Enter}');

    expect(mockedProjectPatch).toHaveBeenCalledWith('p-a', { name: 'Renamed' });
    await waitFor(() => expect(heading('Renamed')).toBeInTheDocument());
  });

  it('Set folder… saves a valid folder onto the project', async () => {
    const user = setup();
    await user.click(actions('p-a'));
    await user.click(screen.getByRole('menuitem', { name: 'Set folder…' }));
    const input = within(screen.getByTestId('group-p-a')).getByRole('textbox', { name: 'Project folder' });
    await user.type(input, 'relative');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('project-folder-error')).toBeInTheDocument();
    expect(mockedProjectPatch).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, '/home/me/alpha{Enter}');

    expect(mockedProjectPatch).toHaveBeenCalledWith('p-a', { workspaceRoot: '/home/me/alpha' });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Project folder' })).toBeNull());
    expect(useGruntStore.getState().projects.find((p) => p.id === 'p-a')!.workspaceRoot).toBe('/home/me/alpha');
    expect(useGruntStore.getState().chats.find((c) => c.id === 'c1')!.workspaceRoot).toBeNull(); // existing chats untouched
  });

  it('Default profile… saves the chosen profile', async () => {
    const user = setup();
    await user.click(actions('p-a'));
    await user.click(screen.getByRole('menuitem', { name: 'Default profile…' }));
    const select = screen.getByRole('combobox', { name: 'Default profile' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['App default', 'Everyday', 'Coder']);

    await user.selectOptions(select, 'profile-2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockedProjectPatch).toHaveBeenCalledWith('p-a', { defaultProfileId: 'profile-2' });
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Default profile' })).toBeNull());
  });

  it('Move down swaps the project with the next one', async () => {
    const user = setup();
    await user.click(actions('p-a'));
    await user.click(screen.getByRole('menuitem', { name: 'Move down' }));

    await waitFor(() => expect(headingOrder()).toEqual(['p-b', 'p-a', NO_PROJECT_KEY]));
    expect(mockedProjectPatch).toHaveBeenCalledWith('p-b', { sortOrder: 0 });
    expect(mockedProjectPatch).toHaveBeenCalledWith('p-a', { sortOrder: 1 });
  });

  it('Delete… confirms, then the project goes and its chats show under No project', async () => {
    const user = setup();
    mockedProjectDelete.mockResolvedValue(undefined);
    await user.click(actions('p-a'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));

    const dialog = screen.getByRole('alertdialog', { name: "Delete project 'Alpha'?" });
    expect(dialog).toHaveTextContent('Its chats move to No project.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(mockedProjectDelete).toHaveBeenCalledWith('p-a');
    await waitFor(() => expect(screen.queryByTestId('group-p-a')).toBeNull());
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['c1']);
  });
});
