import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      chats: { ...actual.api.chats, list: vi.fn(), create: vi.fn(), patch: vi.fn(), delete: vi.fn(), export: vi.fn() },
      projects: { list: vi.fn(), create: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      searchChats: vi.fn(),
      health: vi.fn(),
    },
  };
});

vi.mock('../lib/saveFile.js', () => ({ saveFile: vi.fn() }));

import { saveFile } from '../lib/saveFile.js';
import { ApiError, api } from '../state/api.js';
import { COLLAPSED_GROUPS_STORAGE_KEY, NO_PROJECT_KEY, resetSidebarGroupsForTests, setGroupCollapsed } from '../state/sidebarGroups.js';
import { resetGroupSortsForTests, setGroupSort } from '../state/sidebarSort.js';
import { useGruntStore } from '../state/store.js';
import { ChatList } from './ChatList.js';
import { CHAT_DRAG_MIME } from './sidebar/ChatRow.js';

const mockedCreate = vi.mocked(api.chats.create);
const mockedPatch = vi.mocked(api.chats.patch);
const mockedChatList = vi.mocked(api.chats.list);
const mockedExport = vi.mocked(api.chats.export);
const mockedSaveFile = vi.mocked(saveFile);
const mockedDelete = vi.mocked(api.chats.delete);
const mockedProjectList = vi.mocked(api.projects.list);
const mockedProjectCreate = vi.mocked(api.projects.create);
const mockedProjectPatch = vi.mocked(api.projects.patch);
const mockedProjectDelete = vi.mocked(api.projects.delete);
const mockedSearch = vi.mocked(api.searchChats);
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
  workspace: null,
  runsOn: 'node-self',
  workspaceRoot: null,
  pinned: false,
  projectPinned: false,
  unread: false,
  autoMode: false,
  projectId: null,
  memoryCursor: null,
  memoryExcluded: false,
  sortOrder: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

function makeChat(overrides: Partial<Chat> & { id: string }): Chat {
  return { ...chat, title: `Chat ${overrides.id}`, ...overrides };
}

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return { name: overrides.id, description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...overrides };
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
  resetGroupSortsForTests();
  mockedHealth.mockResolvedValue({ status: 'ok', time: '', platform: 'linux' });
  // Like the server: PATCH returns the stored row with the body applied.
  // (These tests never patch folders, whose entries a server would store in another shape.)
  mockedPatch.mockImplementation(async (id, body) => ({ ...useGruntStore.getState().chats.find((c) => c.id === id)!, ...body }) as Chat);
  mockedProjectPatch.mockImplementation(async (id, body) => ({ ...useGruntStore.getState().projects.find((p) => p.id === id)!, ...body }) as Project);
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

  it('skips archived profiles when picking the app default profile', async () => {
    useGruntStore.setState({
      profiles: [
        { ...profile, id: 'old-default', isDefault: true, archivedAt: 9 },
        { ...profile, id: 'live', isDefault: false },
      ],
    });
    mockedCreate.mockResolvedValue(chat);
    render(<ChatList />);
    await waitFor(() => expect(desktopListeners.has('tray-new-chat')).toBe(true));
    desktopListeners.get('tray-new-chat')!();
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith({ profileId: 'live' }));
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

  it("names a pinned chat's project in Pinned only, and none for a chat with no project", () => {
    useGruntStore.setState({
      projects: [makeProject({ id: 'p-a', name: 'Alpha' })],
      chats: [
        makeChat({ id: 'c1', projectId: 'p-a', pinned: true }),
        makeChat({ id: 'c2', pinned: true }),
        makeChat({ id: 'c3', projectId: 'p-a' }),
      ],
    });
    render(<ChatList />);

    expect(within(screen.getByTestId('chat-row-c1')).getByTestId('row-project-name')).toHaveTextContent('Alpha');
    expect(screen.getByRole('button', { name: /, in Alpha$/ })).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-row-c2')).queryByTestId('row-project-name')).toBeNull();
    expect(within(screen.getByTestId('chat-row-c3')).queryByTestId('row-project-name')).toBeNull();
  });

  it('collapses a group from its arrow, remembers it across a remount, and keeps aria-expanded in step', async () => {
    const user = userEvent.setup();
    useGruntStore.setState({ projects: [makeProject({ id: 'p-a', name: 'Alpha' })], chats: [makeChat({ id: 'c1', projectId: 'p-a' })] });
    const { unmount } = render(<ChatList />);

    const arrow = screen.getByRole('button', { name: 'Collapse Alpha' });
    expect(arrow).toHaveAttribute('aria-expanded', 'true');
    await user.click(arrow);
    expect(arrow).toHaveAttribute('aria-expanded', 'false');
    expect(arrow).toHaveAccessibleName('Expand Alpha');
    expect(rowIds('group-p-a')).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)!)).toEqual(['p-a']);

    unmount();
    resetSidebarGroupsForTests();
    render(<ChatList />);
    expect(screen.getByRole('button', { name: 'Expand Alpha' })).toHaveAttribute('aria-expanded', 'false');
  });

  it("opens a project's page as a tab from its name, leaving the group as it was", async () => {
    const user = userEvent.setup();
    useGruntStore.setState({ projects: [makeProject({ id: 'p-a', name: 'Alpha' })], chats: [makeChat({ id: 'c1', projectId: 'p-a' })] });
    render(<ChatList />);

    await user.click(screen.getByRole('button', { name: /^Alpha/ }));

    expect(useGruntStore.getState().paneState.tabs).toContain('project:p-a');
    expect(useGruntStore.getState().activeChatId).toBe('project:p-a');
    expect(screen.getByRole('button', { name: 'Collapse Alpha' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^Alpha/ })).toHaveAttribute('aria-current', 'true');
  });

  it("a project's + creates a chat with only its projectId, opens it, and expands the group if it was collapsed (review focus 1)", async () => {
    const user = userEvent.setup();
    useGruntStore.setState({ projects: [makeProject({ id: 'p-a', name: 'Alpha', workspace: null, workspaceRoot: '/w' })] });
    window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(['p-a']));
    mockedCreate.mockResolvedValue(makeChat({ id: 'c-new', projectId: 'p-a', workspaceRoot: '/w' }));
    render(<ChatList />);

    await user.click(screen.getByRole('button', { name: 'New chat in Alpha' }));

    expect(mockedCreate).toHaveBeenCalledWith({ projectId: 'p-a' });
    await waitFor(() => expect(useGruntStore.getState().activeChatId).toBe('c-new'));
    expect(screen.getByRole('button', { name: 'Collapse Alpha' })).toHaveAttribute('aria-expanded', 'true');
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
    mockedSearch.mockResolvedValue([{ chatId: 'c2' }]);
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
    let resolveSearch!: (results: { chatId: string }[]) => void;
    mockedSearch.mockImplementation(() => new Promise((resolve) => (resolveSearch = resolve)));
    render(<ChatList />);
    const box = screen.getByRole('searchbox', { name: 'Search chats' });

    await user.type(box, 'x');
    await user.clear(box);
    await act(async () => resolveSearch([{ chatId: 'c1' }]));

    expect(rowIds(`group-${NO_PROJECT_KEY}`).sort()).toEqual(['c1', 'c2']);
  });

  it('New project opens the project page for a new project', async () => {
    const user = userEvent.setup();
    render(<ChatList />);
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(useGruntStore.getState().projectPage).toEqual({ mode: 'create' });
    expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull();
    expect(mockedProjectCreate).not.toHaveBeenCalled();
  });

});

describe('ChatList status dots', () => {
  it('marks chats with a reply ready, replying or waiting for an approval, and each group heading by its most urgent chat', () => {
    useGruntStore.setState({
      projects: [makeProject({ id: 'p-a', name: 'Alpha' })],
      chats: [
        makeChat({ id: 'ready', unread: true }),
        makeChat({ id: 'busy' }),
        makeChat({ id: 'asking', unread: true }),
        makeChat({ id: 'quiet' }),
        makeChat({ id: 'hidden', projectId: 'p-a', unread: true }),
      ],
      appRunningTurns: { m1: 'busy', m2: 'asking' },
      appPendingApprovals: { r1: { chatId: 'asking', messageId: 'm2', requestId: 'r1', toolName: 'write_file' } },
    });
    setGroupCollapsed('p-a', true);
    render(<ChatList />);

    expect(screen.getByTestId('chat-status-ready')).toHaveAttribute('data-status', 'ready');
    expect(screen.getByTestId('chat-status-busy')).toHaveAttribute('data-status', 'working');
    expect(screen.getByTestId('chat-status-asking')).toHaveAttribute('data-status', 'waiting');
    expect(screen.queryByTestId('chat-status-quiet')).toBeNull();
    expect(screen.getByTestId('group-status-p-a')).toHaveAttribute('data-status', 'ready');
    expect(screen.getByTestId(`group-status-${NO_PROJECT_KEY}`)).toHaveAttribute('data-status', 'waiting');
  });

  it('shows no ready dot on a chat that is on screen in a focused window: it is being read', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useGruntStore.setState({ chats: [makeChat({ id: 'open', unread: true }), makeChat({ id: 'other', unread: true })] });
    useGruntStore.getState().setActiveChatId('open');
    render(<ChatList />);

    expect(screen.queryByTestId('chat-status-open')).toBeNull();
    expect(screen.getByTestId('chat-status-other')).toHaveAttribute('data-status', 'ready');
    vi.restoreAllMocks();
  });
});

describe('ChatList pin button', () => {
  it('pins from the row, moving the chat under Pinned, with no marker there', async () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1', title: 'First' })] });
    render(<ChatList />);
    await userEvent.setup().click(within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Pin chat' }));
    expect(mockedPatch).toHaveBeenCalledWith('c1', { pinned: true });
    await waitFor(() => expect(rowIds('group-pinned')).toEqual(['c1']));
    expect(within(screen.getByTestId('group-pinned')).queryByTestId('pin-marker')).toBeNull();
    expect(within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Unpin chat' })).toBeInTheDocument();
  });

  it('refocuses the moved row without scrolling the list to it', async () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1', title: 'First' })] });
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<ChatList />);
    await userEvent.setup().click(within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Pin chat' }));
    await waitFor(() => expect(rowIds('group-pinned')).toEqual(['c1']));
    await waitFor(() => expect(focus).toHaveBeenLastCalledWith({ preventScroll: true }));
    focus.mockRestore();
  });

  it('says so when pinning fails', async () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1', title: 'First' })] });
    mockedPatch.mockRejectedValueOnce(new ApiError(500, 'disk full'));
    render(<ChatList />);
    await userEvent.setup().click(within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Pin chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't pin the chat: disk full");
  });

  it('archived rows have no pin button, and show the marker when they were pinned', () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1', title: 'Old', archivedAt: 5, pinned: true })] });
    window.localStorage.setItem('grunt.showArchived', 'true');
    render(<ChatList />);
    const row = screen.getByTestId('chat-row-c1');
    expect(within(row).queryByRole('button', { name: /pin chat/i })).toBeNull();
    expect(within(row).getByTestId('pin-marker')).toBeInTheDocument();
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

    // Filed at the top of the project: one above its first chat.
    expect(mockedPatch).toHaveBeenCalledWith('c1', { projectId: 'p-a', sortOrder: 1 });
    await waitFor(() => expect(rowIds('group-p-a')).toEqual(['c1', 'c2']));
  });

  it('dropping on No project moves the chat out of its project, to the top while No project is sorted by hand', async () => {
    setGroupSort(NO_PROJECT_KEY, 'manual');
    render(<ChatList />);
    fireEvent.drop(screen.getByTestId(`group-heading-${NO_PROJECT_KEY}`), { dataTransfer: dataTransfer('c2') });
    expect(mockedPatch).toHaveBeenCalledWith('c2', { projectId: null, sortOrder: 1 });
    await waitFor(() => expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['c2', 'c1']));
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

  it('shows an empty Pinned drop zone while a chat is dragged and nothing is pinned; dropping pins it', async () => {
    render(<ChatList />);
    expect(screen.queryByTestId('pinned-drop-zone')).toBeNull();
    fireEvent.dragStart(within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Chat c1' }), { dataTransfer: dataTransfer('c1') });
    const zone = screen.getByTestId('pinned-drop-zone');
    expect(zone).toHaveTextContent('Drop here to pin');
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer('c1') });
    expect(zone).toHaveAttribute('data-drop-active', 'true');
    fireEvent.drop(zone, { dataTransfer: dataTransfer('c1') });
    expect(mockedPatch).toHaveBeenCalledWith('c1', { sortOrder: 0, pinned: true });
    await waitFor(() => expect(rowIds('group-pinned')).toEqual(['c1']));
    expect(screen.queryByTestId('pinned-drop-zone')).toBeNull();
  });

  it('puts the drop zone in place of the search box, so the list does not move under the pointer', () => {
    render(<ChatList />);
    fireEvent.dragStart(within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Chat c1' }), { dataTransfer: dataTransfer('c1') });
    expect(within(screen.getByTestId('chat-list-scroll')).queryByTestId('pinned-drop-zone')).toBeNull();
    expect(screen.getByTestId('pinned-drop-zone')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Search chats' })).toBeNull();
    fireEvent.dragEnd(within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Chat c1' }), { dataTransfer: dataTransfer('c1') });
    expect(screen.getByRole('searchbox', { name: 'Search chats' })).toBeInTheDocument();
  });

  it('takes the drop zone away when the drag ends without a drop', () => {
    render(<ChatList />);
    const row = within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Chat c1' });
    fireEvent.dragStart(row, { dataTransfer: dataTransfer('c1') });
    expect(screen.getByTestId('pinned-drop-zone')).toBeInTheDocument();
    fireEvent.dragEnd(row, { dataTransfer: dataTransfer('c1') });
    expect(screen.queryByTestId('pinned-drop-zone')).toBeNull();
  });

  it('has no drop zone while something is already pinned', () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1' }), makeChat({ id: 'p', pinned: true })] });
    render(<ChatList />);
    fireEvent.dragStart(within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Chat c1' }), { dataTransfer: dataTransfer('c1') });
    expect(screen.queryByTestId('pinned-drop-zone')).toBeNull();
  });

  it('has no drop zone while searching', async () => {
    mockedSearch.mockResolvedValue([{ chatId: 'c1' }]);
    render(<ChatList />);
    await userEvent.setup().type(screen.getByRole('searchbox', { name: 'Search chats' }), 'x');
    await waitFor(() => expect(screen.queryByTestId('group-p-a')).toBeNull());
    fireEvent.dragStart(within(screen.getByTestId('chat-row-c1')).getByRole('button', { name: 'Chat c1' }), { dataTransfer: dataTransfer('c1') });
    expect(screen.queryByTestId('pinned-drop-zone')).toBeNull();
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

  it('right-click opens the menu on its first item; Escape closes it and returns focus to the row', async () => {
    const user = setup();
    fireEvent.contextMenu(row('First'), { clientX: 40, clientY: 50 });

    expect(screen.getByRole('menu', { name: 'Chat actions' })).toBeInTheDocument();
    for (const name of ['Open in new tab', 'Rename', 'Pin', 'Move to project…', 'Archive', 'Delete…']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('menuitem', { name: 'Open in new tab' })).toHaveFocus();

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

  it('Pin in project keeps the chat at the top of its project, marked, and the menu then offers Unpin from project', async () => {
    const user = setup();
    act(() => useGruntStore.setState({ chats: [...useGruntStore.getState().chats, makeChat({ id: 'c3', title: 'Third', projectId: 'p-a', sortOrder: 50 })] }));
    expect(rowIds('group-p-a')).toEqual(['c3', 'c1']);
    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Pin in project' }));
    expect(mockedPatch).toHaveBeenCalledWith('c1', { projectPinned: true });
    await waitFor(() => expect(rowIds('group-p-a')).toEqual(['c1', 'c3']));
    expect(within(screen.getByTestId('chat-row-c1')).getByTestId('project-pin-marker')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-row-c3')).queryByTestId('project-pin-marker')).toBeNull();
    fireEvent.contextMenu(row('First'));
    expect(screen.getByRole('menuitem', { name: 'Unpin from project' })).toBeInTheDocument();
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

  it("Don't add to memory marks the row, and the menu then offers Add to memory", async () => {
    const user = setup();
    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: "Don't add to memory" }));

    expect(mockedPatch).toHaveBeenCalledWith('c1', { memoryExcluded: true });
    await waitFor(() => expect(within(screen.getByTestId('chat-row-c1')).getByTestId('memory-excluded-marker')).toBeInTheDocument());
    await waitFor(() => expect(row('First')).toHaveFocus());

    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Add to memory' }));
    expect(mockedPatch).toHaveBeenLastCalledWith('c1', { memoryExcluded: false });
    await waitFor(() => expect(screen.queryByTestId('memory-excluded-marker')).toBeNull());
  });

  it('a chat outside any project can be kept out of memory too, since it feeds the global note', async () => {
    const user = setup();
    fireEvent.contextMenu(row('Second'));
    await user.click(screen.getByRole('menuitem', { name: "Don't add to memory" }));
    await waitFor(() => expect(within(screen.getByTestId('chat-row-c2')).getByTestId('memory-excluded-marker')).toBeInTheDocument());
  });

  it('Move to project… lists every project plus No project, marks and focuses the current one, and moves the chat', async () => {
    const user = setup();
    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Move to project…' }));

    const sub = screen.getByRole('menu', { name: 'Move to project…' });
    expect(within(sub).getAllByRole('menuitemradio').map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(within(sub).getByRole('menuitemradio', { name: 'Alpha' })).toHaveFocus();
    await user.click(within(sub).getByRole('menuitemradio', { name: 'Beta' }));

    expect(mockedPatch).toHaveBeenCalledWith('c1', expect.objectContaining({ projectId: 'p-b' }));
    await waitFor(() => expect(rowIds('group-p-b')).toEqual(['c1']));
    expect(useGruntStore.getState().chats.find((c) => c.id === 'c1')!.workspaceRoot).toBeNull();
  });

  it('Open in new tab adds the chat as a tab and shows it; once open the item reads Go to tab (#824)', async () => {
    const user = setup();
    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Open in new tab' }));
    expect(useGruntStore.getState().paneState.tabs).toEqual(['c1']);
    expect(useGruntStore.getState().activeChatId).toBe('c1');

    fireEvent.contextMenu(row('First'));
    expect(screen.getByRole('menuitem', { name: 'Go to tab' })).toBeInTheDocument();
  });

  it('Move to project… > New project… makes a project named after the chat and moves the chat into it (#824)', async () => {
    mockedProjectCreate.mockResolvedValue(makeProject({ id: 'p-new', name: 'First' }));
    const user = setup();
    fireEvent.contextMenu(row('First'));
    await user.click(screen.getByRole('menuitem', { name: 'Move to project…' }));
    await user.click(screen.getByRole('menuitem', { name: 'New project…' }));

    expect(mockedProjectCreate).toHaveBeenCalledWith({ name: 'First' });
    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('c1', expect.objectContaining({ projectId: 'p-new' })));
    await waitFor(() => expect(rowIds('group-p-new')).toEqual(['c1']));
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
    for (const name of ['Rename', 'Project settings…', 'Delete…']) expect(screen.getByRole('menuitem', { name })).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: 'Set folder…' })).toBeNull();
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

  it('Project settings… opens the project page for that project', async () => {
    const user = setup();
    await user.click(actions('p-a'));
    await user.click(screen.getByRole('menuitem', { name: 'Project settings…' }));
    expect(useGruntStore.getState().projectPage).toEqual({
      mode: 'edit',
      projectId: 'p-a',
      returnFocus: '[data-testid="group-heading-p-a"] [data-heading-main]',
    });
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

  it('Delete… treats a 404 as already removed: the project goes and the dialog closes', async () => {
    const user = setup();
    mockedProjectDelete.mockRejectedValue(new ApiError(404, 'Project "p-a" not found.'));
    await user.click(actions('p-a'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByTestId('group-p-a')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['c1']);
  });

  it('gives each project group heading an h3 around its name, with the arrow just before it', () => {
    setup();
    const group = within(screen.getByTestId('group-p-a'));
    const h3 = group.getByRole('heading', { level: 3 });
    expect(within(h3).getByRole('button', { name: /^Alpha/ })).toHaveAttribute('data-heading-main');
    expect(group.getByRole('button', { name: 'Collapse Alpha' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('ChatList archived section', () => {
  function setup() {
    useGruntStore.setState({
      projects: [makeProject({ id: 'p-a', name: 'Alpha' })],
      chats: [
        makeChat({ id: 'c1', title: 'Live', projectId: 'p-a', updatedAt: 10 }),
        makeChat({ id: 'c2', title: 'Old one', projectId: 'p-a', archivedAt: 5, updatedAt: 20 }),
        makeChat({ id: 'c3', title: 'Old two', archivedAt: 6, updatedAt: 30 }),
      ],
    });
    render(<ChatList />);
    return userEvent.setup();
  }
  const toggle = () => screen.getByRole('button', { name: /archived/ });
  const archivedIds = () =>
    within(screen.getByTestId('archived-section'))
      .queryAllByTestId(/^chat-row-/)
      .map((el) => el.getAttribute('data-testid')!.slice('chat-row-'.length));

  it('has no toggle when nothing is archived', () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1' })] });
    render(<ChatList />);
    expect(screen.queryByRole('button', { name: /archived/ })).toBeNull();
  });

  it('shows a collapsed "Show archived (N)" toggle that opens and closes the list', async () => {
    const user = setup();
    expect(toggle()).toHaveTextContent('Show archived (2)');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(archivedIds()).toEqual([]);

    await user.click(toggle());
    expect(toggle()).toHaveTextContent('Hide archived');
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(archivedIds()).toEqual(['c3', 'c2']);

    await user.click(toggle());
    expect(archivedIds()).toEqual([]);
  });

  it('remembers the open state per device', async () => {
    const user = setup();
    await user.click(toggle());
    expect(window.localStorage.getItem('grunt.showArchived')).toBe('true');

    cleanup();
    render(<ChatList />);
    expect(toggle()).toHaveTextContent('Hide archived');
    expect(archivedIds()).toEqual(['c3', 'c2']);
  });

  it('clicking an archived chat opens it; its menu offers Unarchive, not Archive', async () => {
    const user = setup();
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'Old one' }));
    expect(useGruntStore.getState().activeChatId).toBe('c2');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Old one' }));
    expect(screen.getByRole('menuitem', { name: 'Unarchive' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeInTheDocument();
  });

  it('Unarchive returns the chat to its group', async () => {
    const user = setup();
    await user.click(toggle());
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Old one' }));
    await user.click(screen.getByRole('menuitem', { name: 'Unarchive' }));

    expect(mockedPatch).toHaveBeenCalledWith('c2', { archivedAt: null });
    await waitFor(() => expect(rowIds('group-p-a')).toEqual(['c2', 'c1']));
    expect(archivedIds()).toEqual(['c3']);
    expect(toggle()).toHaveTextContent('Hide archived');
  });

  it('a search filters the archived list too', async () => {
    const user = setup();
    mockedSearch.mockResolvedValue([{ chatId: 'c3' }]);
    await user.click(toggle());
    await user.type(screen.getByRole('searchbox', { name: 'Search chats' }), 'x');

    await waitFor(() => expect(archivedIds()).toEqual(['c3']));
    expect(toggle()).toHaveTextContent('Hide archived');
  });
});

describe('ChatList reordering (#823)', () => {
  beforeEach(() => {
    // No project starts sorted by recent activity, where rows don't reorder.
    setGroupSort(NO_PROJECT_KEY, 'manual');
    useGruntStore.setState({
      projects: [makeProject({ id: 'p-a', name: 'Alpha' })],
      chats: [
        makeChat({ id: 'a', sortOrder: 30 }),
        makeChat({ id: 'b', sortOrder: 20 }),
        makeChat({ id: 'c', sortOrder: 10 }),
        makeChat({ id: 'x', projectId: 'p-a', sortOrder: 5 }),
        makeChat({ id: 'pin', pinned: true, sortOrder: 1 }),
      ],
    });
  });

  /** Drags `chatId` onto the top or bottom half of row `targetId`. jsdom rows have no height, so the half is set via clientY against a stubbed rect. */
  function dropOnRow(chatId: string, targetId: string, half: 'top' | 'bottom'): void {
    const row = screen.getByTestId(`chat-row-${targetId}`);
    row.getBoundingClientRect = () => ({ top: 100, height: 20, bottom: 120, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) });
    // jsdom has no DragEvent, so clientY has to be put on the event by hand.
    const at = (event: Event): Event => Object.defineProperty(event, 'clientY', { value: half === 'top' ? 105 : 115 });
    fireEvent(row, at(createEvent.dragOver(row, { dataTransfer: dataTransfer(chatId) })));
    expect(row).toHaveAttribute('data-drop-position', half === 'top' ? 'before' : 'after');
    fireEvent(row, at(createEvent.drop(row, { dataTransfer: dataTransfer(chatId) })));
    expect(row).not.toHaveAttribute('data-drop-position');
  }

  it('dropping on the top half of a row places the chat above it, with one PATCH half way between', async () => {
    render(<ChatList />);
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['a', 'b', 'c']);
    dropOnRow('c', 'b', 'top');
    expect(mockedPatch).toHaveBeenCalledTimes(1);
    expect(mockedPatch).toHaveBeenCalledWith('c', { sortOrder: 25 });
    await waitFor(() => expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['a', 'c', 'b']));
  });

  it('dropping on the bottom half of a row places the chat below it', async () => {
    render(<ChatList />);
    dropOnRow('a', 'c', 'bottom');
    expect(mockedPatch).toHaveBeenCalledWith('a', { sortOrder: 9 });
    await waitFor(() => expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['b', 'c', 'a']));
  });

  it('dropping on a row in another project moves the chat there, at that place, in one PATCH', async () => {
    render(<ChatList />);
    dropOnRow('b', 'x', 'top');
    expect(mockedPatch).toHaveBeenCalledWith('b', { sortOrder: 6, projectId: 'p-a' });
    await waitFor(() => expect(rowIds('group-p-a')).toEqual(['b', 'x']));
  });

  it('dropping a chat among the pinned ones pins it, and dropping a pinned chat into a group unpins it', async () => {
    render(<ChatList />);
    dropOnRow('a', 'pin', 'bottom');
    expect(mockedPatch).toHaveBeenLastCalledWith('a', { sortOrder: 0, pinned: true });
    await waitFor(() => expect(rowIds('group-pinned')).toEqual(['pin', 'a']));

    dropOnRow('pin', 'b', 'top');
    expect(mockedPatch).toHaveBeenLastCalledWith('pin', { sortOrder: 21, pinned: false });
    await waitFor(() => expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['pin', 'b', 'c']));
  });

  it("dropping a chat among a project's pinned chats pins it there, and dropping it back among the rest unpins it", async () => {
    useGruntStore.setState({
      chats: [...useGruntStore.getState().chats, makeChat({ id: 'kept', projectId: 'p-a', projectPinned: true, sortOrder: 2 }), makeChat({ id: 'y', projectId: 'p-a', sortOrder: 8 })],
    });
    render(<ChatList />);
    expect(rowIds('group-p-a')).toEqual(['kept', 'y', 'x']);

    dropOnRow('x', 'kept', 'bottom');
    expect(mockedPatch).toHaveBeenLastCalledWith('x', { sortOrder: 1, projectPinned: true });
    await waitFor(() => expect(rowIds('group-p-a')).toEqual(['kept', 'x', 'y']));

    dropOnRow('x', 'y', 'bottom');
    expect(mockedPatch).toHaveBeenLastCalledWith('x', { sortOrder: 7, projectPinned: false });
    await waitFor(() => expect(rowIds('group-p-a')).toEqual(['kept', 'y', 'x']));
  });

  it('dropping a chat from another group among a project\'s pinned chats moves and pins it in one PATCH', async () => {
    useGruntStore.setState({ chats: [...useGruntStore.getState().chats, makeChat({ id: 'kept', projectId: 'p-a', projectPinned: true, sortOrder: 2 })] });
    render(<ChatList />);
    dropOnRow('a', 'kept', 'top');
    expect(mockedPatch).toHaveBeenLastCalledWith('a', { sortOrder: 3, projectPinned: true, projectId: 'p-a' });
    await waitFor(() => expect(rowIds('group-p-a')).toEqual(['a', 'kept', 'x']));
  });

  it('dropping a chat onto itself, or where it already is, sends nothing', () => {
    render(<ChatList />);
    dropOnRow('b', 'b', 'top');
    dropOnRow('b', 'a', 'bottom');
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('rows are not drop targets while searching or in Show archived', async () => {
    mockedSearch.mockResolvedValue([{ chatId: 'a' }, { chatId: 'b' }]);
    render(<ChatList />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), { target: { value: 'q' } });
    await waitFor(() => expect(screen.queryByTestId('chat-row-c')).not.toBeInTheDocument());
    const row = screen.getByTestId('chat-row-b');
    fireEvent.dragOver(row, { dataTransfer: dataTransfer('a') });
    expect(row).not.toHaveAttribute('data-drop-position');
  });

  it('Move up and Move down in the chat menu reorder within the section', async () => {
    const user = userEvent.setup();
    render(<ChatList />);
    fireEvent.contextMenu(screen.getByTestId('chat-row-b').querySelector('[data-row-main]')!);
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
    expect(mockedPatch).toHaveBeenLastCalledWith('b', { sortOrder: 31 });
    await waitFor(() => expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['b', 'a', 'c']));

    fireEvent.contextMenu(screen.getByTestId('chat-row-b').querySelector('[data-row-main]')!);
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    await user.click(screen.getByRole('menuitem', { name: 'Move down' }));
    expect(mockedPatch).toHaveBeenLastCalledWith('b', { sortOrder: 20 });
  });

  it('a failed reorder says so and reloads the server order', async () => {
    mockedPatch.mockRejectedValueOnce(new Error('down'));
    mockedChatList.mockResolvedValue(useGruntStore.getState().chats);
    render(<ChatList />);
    dropOnRow('c', 'a', 'top');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't move the chat");
    expect(mockedChatList).toHaveBeenCalled();
  });
});

describe('ChatList export (#820)', () => {
  beforeEach(() => {
    useGruntStore.setState({ chats: [makeChat({ id: 'c1', title: 'Trip: plans' })] });
    mockedSaveFile.mockReset();
  });

  function openExport(): void {
    fireEvent.contextMenu(screen.getByTestId('chat-row-c1').querySelector('[data-row-main]')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
  }

  it('Export… > Markdown fetches the export and saves it named after the chat', async () => {
    const blob = new Blob(['# Trip']);
    mockedExport.mockResolvedValue(blob);
    render(<ChatList />);
    openExport();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Markdown (shown conversation)' }));
    await waitFor(() => expect(mockedSaveFile).toHaveBeenCalledWith(blob, 'Trip- plans.md'));
    expect(mockedExport).toHaveBeenCalledWith('c1', 'markdown');
  });

  it('Export… > JSON saves a .json file, and a failure says so', async () => {
    mockedExport.mockResolvedValueOnce(new Blob(['{}']));
    render(<ChatList />);
    openExport();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'JSON (every branch)' }));
    await waitFor(() => expect(mockedSaveFile).toHaveBeenCalledWith(expect.any(Blob), 'Trip- plans.json'));

    mockedExport.mockRejectedValueOnce(new ApiError(500, 'disk full'));
    openExport();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'JSON (every branch)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't export the chat: disk full");
  });
});

describe('ChatList footer row', () => {
  const actionsRow = () => screen.getByRole('button', { name: '+ New chat' }).parentElement!;

  it('stays a single line by default, so the desktop and open-mode sidebar are unchanged', () => {
    render(<ChatList footer={<button type="button">Extra</button>} />);
    expect(actionsRow()).not.toHaveClass('flex-wrap');
    expect(within(actionsRow()).getByRole('button', { name: 'Extra' })).toBeInTheDocument();
  });

  it('can wrap onto a second line, so a fourth button stays reachable at phone width', () => {
    render(<ChatList wrapFooter footer={<button type="button">Extra</button>} />);
    expect(actionsRow()).toHaveClass('flex-wrap');
  });
});

describe('ChatList long groups', () => {
  /** Twelve chats in project Alpha, c0 at the top by hand. */
  function seedAlpha(extra: Partial<Chat> = {}): void {
    useGruntStore.setState({
      projects: [makeProject({ id: 'p-a', name: 'Alpha' })],
      chats: Array.from({ length: 12 }, (_, i) => makeChat({ id: `c${i}`, projectId: 'p-a', sortOrder: 100 - i, ...extra })),
    });
  }

  it('shows the first 10 chats and a Show more for the rest; Show fewer folds them again', async () => {
    const user = userEvent.setup();
    seedAlpha();
    render(<ChatList />);
    expect(rowIds('group-p-a')).toHaveLength(10);
    expect(screen.getByTestId('group-count-p-a')).toHaveTextContent('12');

    await user.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(rowIds('group-p-a')).toHaveLength(12);
    // Focus moves to the first chat it revealed.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('chat-row-c10').querySelector('[data-row-main]')));

    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(rowIds('group-p-a')).toHaveLength(10);
  });

  it('keeps the open chat in view past the cap', () => {
    seedAlpha();
    useGruntStore.setState({ activeChatId: 'c11' });
    render(<ChatList />);
    expect(rowIds('group-p-a')).toEqual([...Array.from({ length: 10 }, (_, i) => `c${i}`), 'c11']);
    expect(screen.getByRole('button', { name: 'Show 1 more' })).toBeInTheDocument();
  });

  it('shows every match while searching, with no Show more', async () => {
    seedAlpha();
    mockedSearch.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ chatId: `c${i}` })));
    render(<ChatList />);
    await userEvent.setup().type(screen.getByRole('searchbox', { name: 'Search chats' }), 'zz');
    await waitFor(() => expect(rowIds('group-p-a')).toHaveLength(12));
    expect(screen.queryByTestId('group-more-p-a')).toBeNull();
  });
});

describe('ChatList sorting by recent activity', () => {
  const hour = 3_600_000;

  beforeEach(() => {
    const now = Date.now();
    useGruntStore.setState({
      projects: [makeProject({ id: 'p-a', name: 'Alpha' })],
      chats: [
        makeChat({ id: 'old', projectId: 'p-a', sortOrder: 30, updatedAt: now - 40 * 24 * hour }),
        makeChat({ id: 'new', projectId: 'p-a', sortOrder: 10, updatedAt: now - 60_000 }),
        makeChat({ id: 'loose-old', sortOrder: 30, updatedAt: now - 40 * 24 * hour }),
        makeChat({ id: 'loose-new', sortOrder: 10, updatedAt: now - 60_000 }),
      ],
    });
  });

  it('No project starts by recent activity under date headings; projects start by hand', () => {
    render(<ChatList />);
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['loose-new', 'loose-old']);
    expect(screen.getByTestId(`bucket-${NO_PROJECT_KEY}-today`)).toHaveTextContent('Today');
    expect(screen.getByTestId(`bucket-${NO_PROJECT_KEY}-older`)).toHaveTextContent('Older');
    expect(rowIds('group-p-a')).toEqual(['old', 'new']);
    expect(screen.queryByTestId('bucket-p-a-today')).toBeNull();
  });

  it("a project's menu switches it to recent activity and back, remembered on this device", async () => {
    const user = userEvent.setup();
    render(<ChatList />);
    await user.click(within(screen.getByTestId('group-heading-p-a')).getByRole('button', { name: 'Project actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sort by recent activity' }));
    expect(rowIds('group-p-a')).toEqual(['new', 'old']);
    expect(window.localStorage.getItem('grunt.groupSort')).toBe(JSON.stringify({ 'p-a': 'recent' }));

    await user.click(within(screen.getByTestId('group-heading-p-a')).getByRole('button', { name: 'Project actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sort manually' }));
    expect(rowIds('group-p-a')).toEqual(['old', 'new']);
  });

  it("No project's own menu switches it to manual", async () => {
    const user = userEvent.setup();
    render(<ChatList />);
    await user.click(screen.getByRole('button', { name: 'No project actions' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    await user.click(screen.getByRole('menuitem', { name: 'Sort manually' }));
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['loose-old', 'loose-new']);
    expect(screen.queryByTestId(`bucket-${NO_PROJECT_KEY}-today`)).toBeNull();
  });

  it('a recent group has no Move up / Move down and its rows are not drop targets', () => {
    render(<ChatList />);
    fireEvent.contextMenu(screen.getByTestId('chat-row-loose-new').querySelector('[data-row-main]')!);
    expect(screen.queryByRole('menuitem', { name: 'Move up' })).toBeNull();
    const row = screen.getByTestId('chat-row-loose-old');
    fireEvent.dragOver(row, { dataTransfer: dataTransfer('loose-new') });
    expect(row).not.toHaveAttribute('data-drop-position');
  });

  it("shows each row's age", () => {
    render(<ChatList />);
    expect(within(screen.getByTestId('chat-row-loose-new')).getByTestId('row-age')).toHaveTextContent('1m');
    expect(within(screen.getByTestId('chat-row-old')).getByTestId('row-age')).toHaveTextContent('1mo');
  });
});

describe('ChatList search and filter chips', () => {
  it('finds a chat by its title at once, and adds message-text hits when the server answers', async () => {
    let resolveSearch!: (results: { chatId: string }[]) => void;
    mockedSearch.mockImplementation(() => new Promise((resolve) => (resolveSearch = resolve)));
    useGruntStore.setState({ chats: [makeChat({ id: 'c1', title: 'Sidebar overflow' }), makeChat({ id: 'c2', title: 'Other' }), makeChat({ id: 'c3', title: 'Third' })] });
    render(<ChatList />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), { target: { value: 'OVERFLOW side' } });
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['c1']);
    expect(mockedSearch).toHaveBeenCalledWith('OVERFLOW side');

    await act(async () => resolveSearch([{ chatId: 'c3' }]));
    expect(rowIds(`group-${NO_PROJECT_KEY}`).sort()).toEqual(['c1', 'c3']);
  });

  it('Unread / working keeps only chats with a status, and the open chat', async () => {
    const user = userEvent.setup();
    useGruntStore.setState({
      chats: [makeChat({ id: 'ready', unread: true }), makeChat({ id: 'quiet' }), makeChat({ id: 'open' })],
      activeChatId: 'open',
    });
    render(<ChatList />);
    const chip = screen.getByRole('button', { name: 'Unread / working' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(rowIds(`group-${NO_PROJECT_KEY}`).sort()).toEqual(['open', 'ready']);

    await user.click(chip);
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toHaveLength(3);
  });

  it('says so when the chips match nothing', async () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'quiet' })] });
    render(<ChatList />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Unread / working' }));
    expect(screen.getByText('No chats match these filters.')).toBeInTheDocument();
  });

  it('offers the Machine chip only with a paired machine, and keeps the chats that run on the one picked', async () => {
    const user = userEvent.setup();
    useGruntStore.setState({ chats: [makeChat({ id: 'here', runsOn: 'node-self' }), makeChat({ id: 'there', runsOn: 'node-lap' })] });
    render(<ChatList />);
    expect(screen.queryByRole('combobox', { name: 'Machine' })).toBeNull();

    act(() =>
      useGruntStore.setState({
        machines: {
          self: { id: 'node-self', name: 'Desk', fingerprint: 'f' },
          listening: { running: true, addresses: [] },
          peers: [{ nodeId: 'node-lap', name: 'Laptop', status: 'reachable' }],
        } as unknown as NonNullable<ReturnType<typeof useGruntStore.getState>['machines']>,
      })
    );
    const select = screen.getByRole('combobox', { name: 'Machine' });
    await user.selectOptions(select, 'Laptop');
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['there']);
    await user.selectOptions(select, 'Desk (this machine)');
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toEqual(['here']);
    await user.selectOptions(select, 'Any machine');
    expect(rowIds(`group-${NO_PROJECT_KEY}`)).toHaveLength(2);
  });
});

describe('ChatList sub-projects (spec 2026-10-15-sub-projects-design §4-§5)', () => {
  beforeEach(() => {
    useGruntStore.setState({
      projects: [
        makeProject({ id: 'p-g', name: 'Grunt', sortOrder: 0 }),
        makeProject({ id: 'p-d', name: 'Desktop', parentId: 'p-g', sortOrder: 0 }),
        makeProject({ id: 'p-s', name: 'Sync', parentId: 'p-g', sortOrder: 1 }),
        makeProject({ id: 'p-x', name: 'PhD', sortOrder: 1 }),
      ],
      chats: [makeChat({ id: 'g1', projectId: 'p-g' }), makeChat({ id: 'd1', projectId: 'p-d', unread: true }), makeChat({ id: 'd2', projectId: 'p-d' })],
    });
  });

  it("shows sub-projects inside their parent's group, with the parent counting their chats and showing their status", () => {
    render(<ChatList />);
    expect(headingOrder()).toEqual(['p-g', 'p-d', 'p-s', 'p-x', NO_PROJECT_KEY]);
    const desktop = screen.getByTestId('group-p-d');
    expect(screen.getByTestId('group-p-g')).toContainElement(desktop);
    expect(rowIds('group-p-d')).toEqual(['d1', 'd2']);
    expect(screen.getByTestId('group-count-p-g')).toHaveTextContent('3');
    expect(screen.getByTestId('group-count-p-d')).toHaveTextContent('2');
    expect(screen.getByTestId('group-status-p-g')).toBeInTheDocument();
    // An empty sub-project shows its own "No chats yet", not its parent's.
    expect(within(screen.getByTestId('group-p-s')).getByText('No chats yet')).toBeInTheDocument();
  });

  it('collapsing the parent hides its sub-projects too', async () => {
    render(<ChatList />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse Grunt' }));
    expect(screen.queryByTestId('group-p-d')).toBeNull();
    expect(screen.getByTestId('group-count-p-g')).toHaveTextContent('3');
  });

  it('dropping a chat on a sub-project heading files it there', async () => {
    render(<ChatList />);
    fireEvent.drop(screen.getByTestId('group-heading-p-s'), { dataTransfer: dataTransfer('g1') });
    expect(mockedPatch).toHaveBeenCalledWith('g1', expect.objectContaining({ projectId: 'p-s' }));
    await waitFor(() => expect(rowIds('group-p-s')).toEqual(['g1']));
  });

  it('New sub-project… opens the project page with the parent chosen; a sub-project has none', async () => {
    const user = userEvent.setup();
    render(<ChatList />);
    await user.click(within(screen.getByTestId('group-heading-p-g')).getByRole('button', { name: 'Project actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'New sub-project…' }));
    expect(useGruntStore.getState().projectPage).toMatchObject({ mode: 'create', parentId: 'p-g' });

    await user.click(within(screen.getByTestId('group-heading-p-d')).getByRole('button', { name: 'Project actions' }));
    expect(screen.queryByRole('menuitem', { name: 'New sub-project…' })).toBeNull();
  });

  it('Move under… puts a project under another, opening that group; a project with sub-projects has no Move under…', async () => {
    const user = userEvent.setup();
    setGroupCollapsed('p-x', true);
    render(<ChatList />);
    await user.click(within(screen.getByTestId('group-heading-p-g')).getByRole('button', { name: 'Project actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Move under…' })).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(within(screen.getByTestId('group-heading-p-d')).getByRole('button', { name: 'Project actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move under…' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'PhD' }));
    expect(mockedProjectPatch).toHaveBeenCalledWith('p-d', { parentId: 'p-x' });
    await waitFor(() => expect(screen.getByTestId('group-p-x')).toContainElement(screen.getByTestId('group-p-d')));
  });

  it("Move up / Move down move a sub-project among its parent's sub-projects only", async () => {
    const user = userEvent.setup();
    render(<ChatList />);
    await user.click(within(screen.getByTestId('group-heading-p-s')).getByRole('button', { name: 'Project actions' }));
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
    expect(mockedProjectPatch).toHaveBeenCalledWith('p-s', { sortOrder: 0 });
    expect(mockedProjectPatch).toHaveBeenCalledWith('p-d', { sortOrder: 1 });
    expect(mockedProjectPatch).toHaveBeenCalledTimes(2);
  });

  it('deleting a parent says what happens to its sub-projects', async () => {
    const user = userEvent.setup();
    render(<ChatList />);
    await user.click(within(screen.getByTestId('group-heading-p-g')).getByRole('button', { name: 'Project actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Its sub-projects become top-level projects.');
  });

  it("names a pinned chat's sub-project after its parent, and lists sub-projects indented in Move to project…", async () => {
    useGruntStore.setState({ chats: [makeChat({ id: 'pin', projectId: 'p-d', pinned: true })] });
    render(<ChatList />);
    expect(within(screen.getByTestId('chat-row-pin')).getByTestId('row-project-name')).toHaveTextContent('Grunt / Desktop');

    fireEvent.contextMenu(screen.getByTestId('chat-row-pin').querySelector('[data-row-main]')!);
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Move to project…' }));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent!.replace('✓', '').trim())).toEqual(['Grunt', 'Desktop', 'Sync', 'PhD', 'No project']);
    // Sub-projects sit one step in.
    expect(items.map((i) => i.querySelector('.pl-3') !== null)).toEqual([false, true, true, false, false]);
  });
});
