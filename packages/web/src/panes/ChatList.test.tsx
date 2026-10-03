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
import { COLLAPSED_GROUPS_STORAGE_KEY, NO_PROJECT_KEY, resetSidebarGroupsForTests } from '../state/sidebarGroups.js';
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

    await user.type(input, '  Gamma  {Enter}{Enter}');
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
